// @vitest-environment node
import {
  type CliExec,
  createHostClient,
  execCli,
  GH_CLI,
  glabCli,
  HostCliError,
  type HostCliSpec,
  parseIncludedResponse,
} from './client.js'

function fakeExec(handler: (args: string[]) => Partial<Awaited<ReturnType<CliExec>>>): {
  exec: CliExec
  calls: string[][]
  inputs: Array<string | undefined>
  options: Array<{ binary?: string; env?: Record<string, string> }>
} {
  const calls: string[][] = []
  const inputs: Array<string | undefined> = []
  const options: Array<{ binary?: string; env?: Record<string, string> }> = []
  const exec: CliExec = async (args, opts = {}) => {
    calls.push(args)
    inputs.push(opts.input)
    options.push({
      ...(opts.binary === undefined ? {} : { binary: opts.binary }),
      ...(opts.env === undefined ? {} : { env: opts.env }),
    })
    return { stdout: '', stderr: '', code: 0, missingBinary: false, ...handler(args) }
  }
  return { exec, calls, inputs, options }
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
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-oauth-scopes': 'gist, read:org, repo',
      },
      body: { private: true, permissions: { pull: true } },
    })
  })

  it('describes the last hop of a redirect', () => {
    const redirected = [
      'HTTP/1.1 302 Found',
      'Location: https://example.test/x',
      '',
      RESPONSE_WITH_HEADERS,
    ].join('\n')
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

  it('handles an empty included response and ignores malformed header lines', () => {
    expect(parseIncludedResponse('')).toEqual({ status: 0, headers: {}, body: null })
    expect(parseIncludedResponse('HTTP/2.0 204 No Content\nMalformed\nX-Request: 123')).toEqual({
      status: 204,
      headers: { 'x-request': '123' },
      body: null,
    })
  })
})

describe.each<{ spec: HostCliSpec; env: Record<string, string> }>([
  { spec: GH_CLI, env: {} },
  { spec: glabCli('gitlab.example.com'), env: { GITLAB_HOST: 'gitlab.example.com' } },
])('createHostClient for $spec.cli', ({ spec, env }) => {
  const cli = spec.cli

  it('accepts empty success responses from publishing and deleting draft notes', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '' }))
    const client = createHostClient(spec, exec)
    expect(await client.post('draft_notes/bulk_publish', {})).toBeNull()
    expect(await client.post('draft_notes/1', {}, 'DELETE')).toBeNull()
    expect(calls[1]).toContain('DELETE')
  })

  it('runs the binary with its instance in the environment, pins GET, and passes params as fields', async () => {
    const { exec, calls, options } = fakeExec(() => ({ stdout: '[{"id":1}]' }))
    const client = createHostClient(spec, exec)
    expect(await client.api('repos/acme/widgets/pulls/1/comments', { per_page: '100' })).toEqual([{ id: 1 }])
    expect(calls).toEqual([
      ['api', '--method', 'GET', 'repos/acme/widgets/pulls/1/comments', '-F', 'per_page=100'],
    ])
    expect(options).toEqual([{ binary: cli, env }])
  })

  it('throws HostCliError naming the CLI, with the 404 and 401 hints readable', async () => {
    const { exec } = fakeExec(args => ({
      code: 1,
      stderr: args[3]?.includes('404')
        ? `${cli}: Not Found (HTTP 404)`
        : `${cli}: Bad credentials (HTTP 401)`,
    }))
    const client = createHostClient(spec, exec)
    const notFound = await client.api('x/404').catch((e: unknown) => e)
    expect(notFound).toBeInstanceOf(HostCliError)
    expect(notFound).toMatchObject({ cli, notFound: true, unauthenticated: false })
    const unauth = await client.api('x/401').catch((e: unknown) => e)
    expect(unauth).toMatchObject({
      unauthenticated: true,
      message: `${cli} api x/401 failed (1): ${cli}: Bad credentials (HTTP 401)`,
    })
  })

  it('flags a missing binary on every call that needs it', async () => {
    const { exec } = fakeExec(() => ({ code: 1, missingBinary: true }))
    const client = createHostClient(spec, exec)
    const missing = { cli, stderr: `${cli}: command not found`, missingBinary: true }
    await expect(client.api('user')).rejects.toMatchObject(missing)
    await expect(client.graphql('q', {})).rejects.toMatchObject(missing)
    await expect(client.apiWithHeaders('repos/x/y')).rejects.toMatchObject(missing)
    await expect(client.post('repos/x/y/issues/1/comments', {})).rejects.toMatchObject(missing)
    expect(await client.authStatus()).toEqual({
      installed: false,
      authenticated: false,
      detail: `${cli} is not on PATH`,
    })
    expect(new HostCliError(cli, 'x', 'HTTP 500', 1).missingBinary).toBe(false)
  })

  it('sends graphql with -f for strings and -F for numbers, and returns data', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: JSON.stringify({ data: { ok: true } }) }))
    const client = createHostClient(spec, exec)
    expect(await client.graphql('query { x }', { owner: 'acme', number: 7 })).toEqual({ ok: true })
    expect(calls).toEqual([
      ['api', 'graphql', '-f', 'query=query { x }', '-f', 'owner=acme', '-F', 'number=7'],
    ])
  })

  it('turns graphql errors into HostCliError', async () => {
    const { exec } = fakeExec(() => ({
      stdout: JSON.stringify({ errors: [{ message: 'nope' }, { message: 'still nope' }] }),
    }))
    await expect(createHostClient(spec, exec).graphql('q', {})).rejects.toMatchObject({
      name: 'HostCliError',
      cli,
      stderr: 'nope; still nope',
    })
    const failing = createHostClient(spec, fakeExec(() => ({ code: 1, stderr: 'network' })).exec)
    await expect(failing.graphql('q', {})).rejects.toMatchObject({ stderr: 'network' })
  })

  it('reports auth status for a logged-in and a logged-out CLI', async () => {
    expect(
      await createHostClient(
        spec,
        fakeExec(() => ({ stdout: 'example.com\n  ✓ Logged in\n' })).exec
      ).authStatus()
    ).toEqual({ installed: true, authenticated: true, detail: 'example.com' })
    expect(
      await createHostClient(
        spec,
        fakeExec(() => ({ code: 1, stderr: 'You are not logged into any hosts.' })).exec
      ).authStatus()
    ).toEqual({ installed: true, authenticated: false, detail: 'You are not logged into any hosts.' })
  })

  it('asks for the response headers and parses them', async () => {
    const { exec, calls } = fakeExec(() => ({
      stdout: 'HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{"private":false}',
    }))
    expect(await createHostClient(spec, exec).apiWithHeaders('repos/acme/widgets')).toEqual({
      status: 200,
      headers: { 'x-oauth-scopes': 'repo' },
      body: { private: false },
    })
    expect(calls).toEqual([['api', '-i', '--method', 'GET', 'repos/acme/widgets']])
  })

  it('sends a POST payload over stdin as JSON, never as an argument', async () => {
    const { exec, calls, inputs } = fakeExec(() => ({ stdout: '{"id":7}' }))
    const client = createHostClient(spec, exec)
    expect(await client.post('repos/acme/widgets/issues/42/comments', { body: 'hello' })).toEqual({ id: 7 })
    expect(calls).toEqual([
      [
        'api',
        '--method',
        'POST',
        'repos/acme/widgets/issues/42/comments',
        '--input',
        '-',
        '-H',
        'Content-Type: application/json',
      ],
    ])
    expect(inputs).toEqual(['{"body":"hello"}'])
  })

  it('preserves API errors from an installed CLI for header reads and posts', async () => {
    const client = createHostClient(spec, fakeExec(() => ({ code: 1, stderr: 'HTTP 403: forbidden' })).exec)
    const forbidden = { stderr: 'HTTP 403: forbidden', missingBinary: false }
    await expect(client.apiWithHeaders('repos/acme/widgets')).rejects.toMatchObject(forbidden)
    await expect(
      client.post('repos/acme/widgets/issues/42/comments', { body: 'hello' })
    ).rejects.toMatchObject(forbidden)
  })

  it.each([
    { stdout: '  example-token\n', code: 0, expected: 'example-token' },
    { stdout: '  \n', code: 0, expected: null },
    { stdout: 'stale-token', code: 1, expected: null },
  ])('returns an auth token only after a successful nonempty response: $code/$expected', async row => {
    const { exec, calls } = fakeExec(() => row)
    expect(await createHostClient(spec, exec).authToken()).toBe(row.expected)
    expect(calls).toEqual([spec.tokenArgs])
  })
})

it('asks gh and glab for the token the way each CLI prints it', () => {
  expect(GH_CLI.tokenArgs).toEqual(['auth', 'token'])
  expect(glabCli('gitlab.example.com').tokenArgs).toEqual([
    'config',
    'get',
    'token',
    '--host',
    'gitlab.example.com',
  ])
})

it('runs the real exec wrapper: a missing binary is reported, a real one answers', async () => {
  const missing = await execCli(['--version'], { binary: 'pr-review-no-such-binary' })
  expect(missing).toMatchObject({ missingBinary: true, code: 1, stdout: '' })
  const piped = await execCli([], { binary: 'cat', input: 'from stdin' })
  expect(piped).toMatchObject({ stdout: 'from stdin', code: 0 })
  const real = await execCli(['--version'], { binary: process.execPath })
  expect(real).toMatchObject({ code: 0, missingBinary: false, stdout: `${process.version}\n` })
  const failing = await execCli(['-e', 'process.stderr.write("failed"); process.exitCode = 7'], {
    binary: process.execPath,
  })
  expect(failing).toEqual({ stdout: '', stderr: 'failed', code: 7, missingBinary: false })
  const withEnv = await execCli(['-e', 'process.stdout.write(process.env.PR_REVIEW_TEST_VAR ?? "")'], {
    binary: process.execPath,
    env: { PR_REVIEW_TEST_VAR: 'from env' },
  })
  expect(withEnv).toMatchObject({ code: 0, stdout: 'from env' })
})
