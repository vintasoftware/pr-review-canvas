// @vitest-environment node
import { createGitHubClient, execGh, type GhExec, GitHubApiError, parseIncludedResponse } from './gh.js'

function fakeExec(handler: (args: string[]) => Partial<Awaited<ReturnType<GhExec>>>): {
  exec: GhExec
  calls: string[][]
  inputs: Array<string | undefined>
} {
  const calls: string[][] = []
  const inputs: Array<string | undefined> = []
  const exec: GhExec = async (args, opts = {}) => {
    calls.push(args)
    inputs.push(opts.input)
    return { stdout: '', stderr: '', code: 0, missingBinary: false, ...handler(args) }
  }
  return { exec, calls, inputs }
}

const RESPONSE_WITH_HEADERS = [
  'HTTP/2.0 200 OK',
  'Content-Type: application/json; charset=utf-8',
  'X-Oauth-Scopes: gist, read:org, repo',
  '',
  '{"private":true,\n\n"permissions":{"pull":true}}',
].join('\n')

describe('parseIncludedResponse', () => {
  it('reads the status, lower-cased header names, and the JSON body', () => {
    expect(parseIncludedResponse(RESPONSE_WITH_HEADERS)).toEqual({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-oauth-scopes': 'gist, read:org, repo' },
      body: { private: true, permissions: { pull: true } },
    })
  })

  it('describes the last hop of a redirect', () => {
    const redirected = ['HTTP/1.1 302 Found', 'Location: https://example.test/x', '', RESPONSE_WITH_HEADERS].join('\n')
    expect(parseIncludedResponse(redirected).headers['x-oauth-scopes']).toBe('gist, read:org, repo')
  })

  it('answers with a null body when there is none, and handles CRLF line ends', () => {
    expect(parseIncludedResponse('HTTP/2.0 204 No Content\r\nX-A: b\r\n\r\n')).toEqual({
      status: 204,
      headers: { 'x-a': 'b' },
      body: null,
    })
    expect(parseIncludedResponse('not http at all')).toEqual({ status: 0, headers: {}, body: null })
  })
})

describe('createGitHubClient', () => {
  it('pins GET and passes query params as typed fields', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '[{"id":1}]' }))
    const gh = createGitHubClient(exec)
    expect(await gh.api('repos/acme/widgets/pulls/1/comments', { per_page: '100' })).toEqual([{ id: 1 }])
    expect(calls).toEqual([['api', '--method', 'GET', 'repos/acme/widgets/pulls/1/comments', '-F', 'per_page=100']])
  })

  it('throws GitHubApiError with the 404 and 401 hints readable', async () => {
    const { exec } = fakeExec(args => ({
      code: 1,
      stderr: args[3]?.includes('404') ? 'gh: Not Found (HTTP 404)' : 'gh: Bad credentials (HTTP 401)',
    }))
    const gh = createGitHubClient(exec)
    const notFound = await gh.api('x/404').catch((e: unknown) => e)
    expect(notFound).toBeInstanceOf(GitHubApiError)
    expect((notFound as GitHubApiError).notFound).toBe(true)
    expect((notFound as GitHubApiError).unauthenticated).toBe(false)
    const unauth = await gh.api('x/401').catch((e: unknown) => e)
    expect((unauth as GitHubApiError).unauthenticated).toBe(true)
    expect((unauth as GitHubApiError).message).toBe('gh api x/401 failed (1): gh: Bad credentials (HTTP 401)')
  })

  it('flags a missing gh binary on REST and GraphQL errors', async () => {
    const { exec } = fakeExec(() => ({ code: 1, missingBinary: true }))
    const gh = createGitHubClient(exec)
    await expect(gh.api('user')).rejects.toMatchObject({ stderr: 'gh: command not found', missingBinary: true })
    await expect(gh.graphql('q', {})).rejects.toMatchObject({ stderr: 'gh: command not found', missingBinary: true })
    expect(new GitHubApiError('x', 'HTTP 500', 1).missingBinary).toBe(false)
  })

  it('sends graphql with -f for strings and -F for numbers, and returns data', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: JSON.stringify({ data: { ok: true } }) }))
    const gh = createGitHubClient(exec)
    expect(await gh.graphql('query { x }', { owner: 'acme', number: 7 })).toEqual({ ok: true })
    expect(calls).toEqual([['api', 'graphql', '-f', 'query=query { x }', '-f', 'owner=acme', '-F', 'number=7']])
  })

  it('turns graphql errors into GitHubApiError', async () => {
    const { exec } = fakeExec(() => ({
      stdout: JSON.stringify({ errors: [{ message: 'nope' }, { message: 'still nope' }] }),
    }))
    const gh = createGitHubClient(exec)
    await expect(gh.graphql('q', {})).rejects.toMatchObject({ name: 'GitHubApiError', stderr: 'nope; still nope' })
    const failing = createGitHubClient(fakeExec(() => ({ code: 1, stderr: 'network' })).exec)
    await expect(failing.graphql('q', {})).rejects.toMatchObject({ stderr: 'network' })
  })

  it('reports auth status for installed, missing, and logged-out gh', async () => {
    expect(
      await createGitHubClient(fakeExec(() => ({ stdout: 'github.com\n  ✓ Logged in\n' })).exec).authStatus()
    ).toEqual({
      installed: true,
      authenticated: true,
      detail: 'github.com',
    })
    expect(await createGitHubClient(fakeExec(() => ({ code: 1, missingBinary: true })).exec).authStatus()).toEqual({
      installed: false,
      authenticated: false,
      detail: 'gh is not on PATH',
    })
    expect(
      await createGitHubClient(
        fakeExec(() => ({ code: 1, stderr: 'You are not logged into any GitHub hosts.' })).exec
      ).authStatus()
    ).toEqual({
      installed: true,
      authenticated: false,
      detail: 'You are not logged into any GitHub hosts.',
    })
  })

  it('asks for the response headers and parses them', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{"private":false}' }))
    const gh = createGitHubClient(exec)
    expect(await gh.apiWithHeaders('repos/acme/widgets')).toEqual({
      status: 200,
      headers: { 'x-oauth-scopes': 'repo' },
      body: { private: false },
    })
    expect(calls).toEqual([['api', '-i', '--method', 'GET', 'repos/acme/widgets']])
  })

  it('sends a POST payload over stdin, never as an argument', async () => {
    const { exec, calls, inputs } = fakeExec(() => ({ stdout: '{"id":7}' }))
    const gh = createGitHubClient(exec)
    expect(await gh.post('repos/acme/widgets/issues/42/comments', { body: 'hello' })).toEqual({ id: 7 })
    expect(calls).toEqual([['api', '--method', 'POST', 'repos/acme/widgets/issues/42/comments', '--input', '-']])
    expect(inputs).toEqual(['{"body":"hello"}'])
  })

  it('reports a failed header read and a failed post as GitHubApiError', async () => {
    const { exec } = fakeExec(() => ({ code: 1, missingBinary: true }))
    const gh = createGitHubClient(exec)
    await expect(gh.apiWithHeaders('repos/x/y')).rejects.toMatchObject({ missingBinary: true })
    await expect(gh.post('repos/x/y/issues/1/comments', {})).rejects.toMatchObject({ missingBinary: true })
  })

  it.each([
    { stdout: '  example-token\n', code: 0, expected: 'example-token' },
    { stdout: '  \n', code: 0, expected: null },
    { stdout: 'stale-token', code: 1, expected: null },
  ])('returns an auth token only after a successful nonempty response: $code/$expected', async row => {
    const { exec, calls } = fakeExec(() => row)
    expect(await createGitHubClient(exec).authToken()).toBe(row.expected)
    expect(calls).toEqual([['auth', 'token']])
  })

  it('preserves API errors from an installed gh for header reads and posts', async () => {
    const gh = createGitHubClient(fakeExec(() => ({ code: 1, stderr: 'HTTP 403: forbidden' })).exec)
    await expect(gh.apiWithHeaders('repos/acme/widgets')).rejects.toMatchObject({
      stderr: 'HTTP 403: forbidden', missingBinary: false,
    })
    await expect(gh.post('repos/acme/widgets/issues/42/comments', { body: 'hello' })).rejects.toMatchObject({
      stderr: 'HTTP 403: forbidden', missingBinary: false,
    })
  })

  it('runs the real exec wrapper: a missing binary is reported, a real one answers', async () => {
    const missing = await execGh(['--version'], { binary: 'pr-review-no-such-binary' })
    expect(missing).toMatchObject({ missingBinary: true, code: 1, stdout: '' })
    const piped = await execGh([], { binary: 'cat', input: 'from stdin' })
    expect(piped).toMatchObject({ stdout: 'from stdin', code: 0 })
    const real = await execGh(['--version'], { binary: process.execPath })
    expect(real).toMatchObject({ code: 0, missingBinary: false, stdout: `${process.version}\n` })
    const failing = await execGh(['-e', 'process.stderr.write("failed"); process.exitCode = 7'], {
      binary: process.execPath,
    })
    expect(failing).toEqual({ stdout: '', stderr: 'failed', code: 7, missingBinary: false })
  })
})


it('handles an empty included response and ignores malformed header lines', () => {
  expect(parseIncludedResponse('')).toEqual({ status: 0, headers: {}, body: null })
  expect(parseIncludedResponse('HTTP/2.0 204 No Content\nMalformed\nX-Request: 123')).toEqual({
    status: 204, headers: { 'x-request': '123' }, body: null,
  })
})
