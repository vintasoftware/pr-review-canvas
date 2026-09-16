import { execFile } from 'node:child_process'
import { type GitHubClient, parseIncludedResponse } from '../github/gh.js'

/**
 * GitLab through `glab`. The client shape matches GitHubClient so fakes and routes stay shared.
 * `--hostname` is always passed so a self-hosted instance is the one we talk to.
 */

export class GitLabApiError extends Error {
  readonly path: string
  readonly stderr: string
  readonly exitCode: number
  readonly missingBinary: boolean

  constructor(path: string, stderr: string, exitCode: number, missingBinary = false) {
    super(`glab api ${path} failed (${exitCode}): ${stderr.trim()}`)
    this.name = 'GitLabApiError'
    this.path = path
    this.stderr = stderr
    this.exitCode = exitCode
    this.missingBinary = missingBinary
  }
  get notFound(): boolean {
    return /HTTP 404|404 Not Found|Not Found/i.test(this.stderr)
  }
  get unauthenticated(): boolean {
    return /HTTP 401|unauthorized|not logged in|glab auth login|401 Unauthorized/i.test(this.stderr)
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  missingBinary: boolean
}

export interface GlabExecOptions {
  binary?: string
  input?: string
}

export function execGlab(args: string[], opts: GlabExecOptions = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(
      opts.binary ?? 'glab',
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const missingBinary = error !== null && 'code' in error && error.code === 'ENOENT'
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr, code, missingBinary })
      }
    )
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(opts.input)
    }
  })
}

export type GlabExec = typeof execGlab

function throwIfFailed(path: string, r: ExecResult): void {
  if (r.code !== 0) {
    throw new GitLabApiError(
      path,
      r.missingBinary ? 'glab: command not found' : r.stderr,
      r.code,
      r.missingBinary
    )
  }
}

export function createGitLabClient(hostname: string, exec: GlabExec = execGlab): GitHubClient {
  const hostArgs = ['--hostname', hostname]
  return {
    api: async (path, params = {}) => {
      const args = [...hostArgs, 'api', '--method', 'GET', path]
      for (const [k, v] of Object.entries(params)) {
        args.push('-F', `${k}=${v}`)
      }
      const r = await exec(args)
      throwIfFailed(path, r)
      return JSON.parse(r.stdout) as unknown
    },
    apiWithHeaders: async path => {
      const r = await exec([...hostArgs, 'api', '-i', '--method', 'GET', path])
      throwIfFailed(path, r)
      return parseIncludedResponse(r.stdout)
    },
    post: async (path, body) => {
      const r = await exec([...hostArgs, 'api', '--method', 'POST', path, '--input', '-'], {
        input: JSON.stringify(body),
      })
      throwIfFailed(path, r)
      return JSON.parse(r.stdout) as unknown
    },
    graphql: async (query, variables) => {
      const args = [...hostArgs, 'api', 'graphql', '-f', `query=${query}`]
      for (const [k, v] of Object.entries(variables)) {
        args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
      }
      const r = await exec(args)
      throwIfFailed('graphql', r)
      const body = JSON.parse(r.stdout) as { data?: unknown; errors?: Array<{ message: string }> }
      if (body.errors && body.errors.length > 0) {
        throw new GitLabApiError('graphql', body.errors.map(e => e.message).join('; '), 1)
      }
      return body.data
    },
    authStatus: async () => {
      const r = await exec([...hostArgs, 'auth', 'status'])
      if (r.missingBinary) {
        return { installed: false, authenticated: false, detail: 'glab is not on PATH' }
      }
      const detail = (r.stdout + r.stderr).trim().split('\n')[0] ?? ''
      return { installed: true, authenticated: r.code === 0, detail }
    },
    authToken: async () => {
      const fromConfig = await exec([...hostArgs, 'config', 'get', 'token', '--host', hostname])
      const configToken = fromConfig.stdout.trim()
      if (fromConfig.code === 0 && configToken !== '') {
        return configToken
      }
      const r = await exec([...hostArgs, 'auth', 'token'])
      const token = r.stdout.trim()
      return r.code === 0 && token !== '' ? token : null
    },
  }
}
