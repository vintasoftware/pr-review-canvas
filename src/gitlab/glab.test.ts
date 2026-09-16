// @vitest-environment node
import { createGitLabClient, execGlab, type GlabExec, GitLabApiError } from './glab.js'

function fakeExec(handler: (args: string[]) => Partial<Awaited<ReturnType<GlabExec>>>): {
  exec: GlabExec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: GlabExec = async args => {
    calls.push(args)
    return { stdout: '', stderr: '', code: 0, missingBinary: false, ...handler(args) }
  }
  return { exec, calls }
}

describe('createGitLabClient', () => {
  it('passes --hostname on every call and pins GET', async () => {
    const { exec, calls } = fakeExec(() => ({ stdout: '[{"id":1}]' }))
    const gl = createGitLabClient('gitlab.example.com', exec)
    expect(await gl.api('projects/a%2Fb/merge_requests/1', { per_page: '100' })).toEqual([{ id: 1 }])
    expect(calls[0]?.slice(0, 6)).toEqual([
      '--hostname',
      'gitlab.example.com',
      'api',
      '--method',
      'GET',
      'projects/a%2Fb/merge_requests/1',
    ])
  })

  it('flags a missing glab binary and 401', async () => {
    const missing = createGitLabClient('gitlab.com', fakeExec(() => ({ code: 1, missingBinary: true })).exec)
    await expect(missing.api('user')).rejects.toMatchObject({ missingBinary: true, name: 'GitLabApiError' })
    const unauth = createGitLabClient(
      'gitlab.com',
      fakeExec(() => ({ code: 1, stderr: '401 Unauthorized' })).exec
    )
    const err = await unauth.api('user').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitLabApiError)
    expect((err as GitLabApiError).unauthenticated).toBe(true)
  })

  it('reads the token from config, then auth token', async () => {
    const { exec, calls } = fakeExec(args =>
      args.includes('config') ? { stdout: 'glpat-from-config\n' } : { stdout: '' }
    )
    expect(await createGitLabClient('gitlab.com', exec).authToken()).toBe('glpat-from-config')
    expect(calls[0]).toEqual(['--hostname', 'gitlab.com', 'config', 'get', 'token', '--host', 'gitlab.com'])
  })

  it('returns null when neither config nor auth token has a value', async () => {
    const { exec } = fakeExec(() => ({ stdout: '\n', code: 1 }))
    expect(await createGitLabClient('gitlab.com', exec).authToken()).toBeNull()
  })

  it('falls back to auth token when config is empty', async () => {
    const { exec } = fakeExec(args =>
      args.includes('auth') && args.includes('token')
        ? { stdout: 'glpat-auth\n' }
        : { stdout: '  \n', code: 1 }
    )
    expect(await createGitLabClient('gitlab.com', exec).authToken()).toBe('glpat-auth')
  })

  it('posts JSON on stdin and parses graphql data', async () => {
    const { exec, calls } = fakeExec(args => {
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { ok: true } }) }
      }
      if (args.includes('-i')) {
        return { stdout: 'HTTP/2.0 200 OK\nX-A: b\n\n{"private":false}' }
      }
      return { stdout: '{"id":7}' }
    })
    const gl = createGitLabClient('gitlab.com', exec)
    expect(await gl.post('projects/x/notes', { body: 'hi' })).toEqual({ id: 7 })
    expect(await gl.graphql('query { x }', { path: 'a/b', iid: 1 })).toEqual({ ok: true })
    expect(await gl.apiWithHeaders('projects/x')).toMatchObject({
      status: 200,
      headers: { 'x-a': 'b' },
      body: { private: false },
    })
    expect(calls.some(c => c.includes('--input'))).toBe(true)
    expect(calls.some(c => c.includes('graphql'))).toBe(true)
  })

  it('throws when a post or header read fails', async () => {
    const gl = createGitLabClient('gitlab.com', fakeExec(() => ({ code: 1, stderr: 'HTTP 500' })).exec)
    await expect(gl.post('x', {})).rejects.toBeInstanceOf(GitLabApiError)
    await expect(gl.apiWithHeaders('x')).rejects.toBeInstanceOf(GitLabApiError)
    await expect(gl.graphql('q', {})).rejects.toBeInstanceOf(GitLabApiError)
  })

  it('turns graphql payload errors into GitLabApiError', async () => {
    const gl = createGitLabClient(
      'gitlab.com',
      fakeExec(() => ({ stdout: JSON.stringify({ errors: [{ message: 'nope' }] }) })).exec
    )
    await expect(gl.graphql('q', {})).rejects.toMatchObject({ name: 'GitLabApiError', stderr: 'nope' })
  })

  it('reports auth status for installed, missing, and logged-out glab', async () => {
    expect(
      await createGitLabClient(
        'gitlab.com',
        fakeExec(() => ({ stdout: 'gitlab.com\n  ✓ Logged in\n' })).exec
      ).authStatus()
    ).toEqual({ installed: true, authenticated: true, detail: 'gitlab.com' })
    expect(
      await createGitLabClient(
        'gitlab.com',
        fakeExec(() => ({ code: 1, missingBinary: true })).exec
      ).authStatus()
    ).toEqual({ installed: false, authenticated: false, detail: 'glab is not on PATH' })
    expect(
      await createGitLabClient(
        'gitlab.com',
        fakeExec(() => ({ code: 1, stderr: 'Not logged in' })).exec
      ).authStatus()
    ).toMatchObject({ installed: true, authenticated: false })
  })

  it('flags notFound on 404 stderr', () => {
    expect(new GitLabApiError('x', '404 Not Found', 1).notFound).toBe(true)
    expect(new GitLabApiError('x', 'boom', 1).notFound).toBe(false)
  })
})

it('runs the real exec wrapper: a missing binary is reported, a real one answers', async () => {
  const missing = await execGlab(['--version'], { binary: 'pr-review-no-such-binary' })
  expect(missing).toMatchObject({ missingBinary: true, code: 1, stdout: '' })
  const piped = await execGlab([], { binary: 'cat', input: 'from stdin' })
  expect(piped).toMatchObject({ stdout: 'from stdin', code: 0 })
})
