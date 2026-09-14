import { execFile } from 'node:child_process'

/**
 * The GitHub operations the tool needs, all through the `gh` CLI so the user's own login is
 * used and no token is ever read by this code. Routes receive an implementation through
 * AppContext; tests use an in-memory fake.
 */
export interface GitHubClient {
  /** `gh api --method GET <path>` with optional query params; returns the parsed JSON body. */
  api(path: string, params?: Record<string, string>): Promise<unknown>
  /** `gh api -i --method GET <path>`: the response headers as well as the body. */
  apiWithHeaders(path: string): Promise<GhResponse>
  /** `gh api --method POST <path> --input -`; the JSON body goes over stdin, never the command line. */
  post(path: string, body: unknown): Promise<unknown>
  /** `gh api graphql`; returns the parsed `data` object. */
  graphql(query: string, variables: Record<string, string | number>): Promise<unknown>
  /** `gh auth status`: is the CLI installed and logged in? */
  authStatus(): Promise<{ installed: boolean; authenticated: boolean; detail: string }>
  /**
   * `gh auth token`: the token of the current login, or null when there is none. Callers keep it
   * in a local variable for the length of one request; it is never logged or written to disk.
   */
  authToken(): Promise<string | null>
}

/** One HTTP answer from `gh api -i`: the status, the header names in lower case, and the body. */
export interface GhResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/**
 * Splits the output of `gh api -i` into the last header block and the body. A redirect prints
 * one block per hop, and only the final one describes the answer.
 */
export function parseIncludedResponse(stdout: string): GhResponse {
  const normalized = stdout.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  let body: unknown = null
  const headerBlocks: string[] = []
  for (const [i, part] of parts.entries()) {
    if (/^HTTP\/[\d.]+ \d{3}/.test(part)) {
      headerBlocks.push(part)
      continue
    }
    // Everything after the last header block is the body, which may hold blank lines itself.
    body = parseJsonOrNull(parts.slice(i).join('\n\n'))
    break
  }
  const last = headerBlocks[headerBlocks.length - 1] ?? ''
  const lines = last.split('\n').filter(l => l.trim() !== '')
  const status = Number(/^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0)
  const headers: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) {
      headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
    }
  }
  return { status, headers, body }
}

function parseJsonOrNull(text: string): unknown {
  if (text.trim() === '') {
    return null
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export class GitHubApiError extends Error {
  readonly path: string
  readonly stderr: string
  readonly exitCode: number
  /** True when the `gh` binary is not on PATH. */
  readonly missingBinary: boolean

  constructor(path: string, stderr: string, exitCode: number, missingBinary = false) {
    super(`gh api ${path} failed (${exitCode}): ${stderr.trim()}`)
    this.name = 'GitHubApiError'
    this.path = path
    this.stderr = stderr
    this.exitCode = exitCode
    this.missingBinary = missingBinary
  }
  /** `gh api` exits 1 with "HTTP 404" in stderr for a missing resource. */
  get notFound(): boolean {
    return /HTTP 404/.test(this.stderr)
  }
  get unauthenticated(): boolean {
    return /HTTP 401|not logged into|gh auth login/i.test(this.stderr)
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  missingBinary: boolean
}

export interface GhExecOptions {
  binary?: string
  /** Written to the child's stdin, for `gh api --input -`. */
  input?: string
}

export function execGh(args: string[], opts: GhExecOptions = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(
      opts.binary ?? 'gh',
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

export type GhExec = typeof execGh

export function createGitHubClient(exec: GhExec = execGh): GitHubClient {
  return {
    api: async (path, params = {}) => {
      // `gh api` switches to POST as soon as a field is given; these are reads, so pin GET.
      const args = ['api', '--method', 'GET', path]
      for (const [k, v] of Object.entries(params)) {
        args.push('-F', `${k}=${v}`)
      }
      const r = await exec(args)
      if (r.code !== 0) {
        throw new GitHubApiError(path, r.missingBinary ? 'gh: command not found' : r.stderr, r.code, r.missingBinary)
      }
      return JSON.parse(r.stdout) as unknown
    },
    apiWithHeaders: async path => {
      const r = await exec(['api', '-i', '--method', 'GET', path])
      if (r.code !== 0) {
        throw new GitHubApiError(path, r.missingBinary ? 'gh: command not found' : r.stderr, r.code, r.missingBinary)
      }
      return parseIncludedResponse(r.stdout)
    },
    post: async (path, body) => {
      // The payload goes over stdin, so no comment text ever appears in an argument list.
      const r = await exec(['api', '--method', 'POST', path, '--input', '-'], { input: JSON.stringify(body) })
      if (r.code !== 0) {
        throw new GitHubApiError(path, r.missingBinary ? 'gh: command not found' : r.stderr, r.code, r.missingBinary)
      }
      return JSON.parse(r.stdout) as unknown
    },
    graphql: async (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`]
      for (const [k, v] of Object.entries(variables)) {
        args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
      }
      const r = await exec(args)
      if (r.code !== 0) {
        throw new GitHubApiError(
          'graphql',
          r.missingBinary ? 'gh: command not found' : r.stderr,
          r.code,
          r.missingBinary
        )
      }
      const body = JSON.parse(r.stdout) as { data?: unknown; errors?: Array<{ message: string }> }
      if (body.errors && body.errors.length > 0) {
        throw new GitHubApiError('graphql', body.errors.map(e => e.message).join('; '), 1)
      }
      return body.data
    },
    authStatus: async () => {
      const r = await exec(['auth', 'status'])
      if (r.missingBinary) {
        return { installed: false, authenticated: false, detail: 'gh is not on PATH' }
      }
      const detail = (r.stdout + r.stderr).trim().split('\n')[0] ?? ''
      return { installed: true, authenticated: r.code === 0, detail }
    },
    authToken: async () => {
      const r = await exec(['auth', 'token'])
      const token = r.stdout.trim()
      return r.code === 0 && token !== '' ? token : null
    },
  }
}
