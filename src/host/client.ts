import { execFile } from 'node:child_process'

/**
 * The forge operations the tool needs, all through the host's own CLI (`gh` or `glab`) so the
 * user's login is used and no token is ever read by this code. The two CLIs share one command
 * grammar, so one client serves both; the spec names the binary and the instance. Routes receive
 * an implementation through AppContext; tests use an in-memory fake.
 */
export interface HostClient {
  /** `<cli> api --method GET <path>` with optional query params; returns the parsed JSON body. */
  api(path: string, params?: Record<string, string>): Promise<unknown>
  /** `<cli> api -i --method GET <path>`: the response headers as well as the body. */
  apiWithHeaders(path: string): Promise<CliResponse>
  /** `<cli> api --method POST <path> --input -`; the JSON body goes over stdin, never the command line. */
  post(path: string, body: unknown): Promise<unknown>
  /** `<cli> api graphql`; returns the parsed `data` object. */
  graphql(query: string, variables: Record<string, string | number>): Promise<unknown>
  /** `<cli> auth status`: is the CLI installed and logged in? */
  authStatus(): Promise<{ installed: boolean; authenticated: boolean; detail: string }>
  /**
   * The token of the current login, or null when there is none. Callers keep it in a local
   * variable for the length of one request; it is never logged or written to disk.
   */
  authToken(): Promise<string | null>
}

export type HostCli = 'gh' | 'glab'

/** What differs between the two CLIs. Everything else is the same argument list. */
export interface HostCliSpec {
  cli: HostCli
  /** Variables the child gets on top of the process environment; `glab` learns its instance here. */
  env: Record<string, string>
  /** The command that prints the current login's token. */
  tokenArgs: string[]
}

/** The words the doctor and error hints use for each CLI. */
export const CLI_INFO: Record<HostCli, { label: string; installUrl: string; loginCommand: string }> = {
  gh: { label: 'GitHub CLI (gh)', installUrl: 'https://cli.github.com', loginCommand: 'gh auth login' },
  glab: {
    label: 'GitLab CLI (glab)',
    installUrl: 'https://gitlab.com/gitlab-org/cli',
    loginCommand: 'glab auth login',
  },
}

/** One HTTP answer from `<cli> api -i`: the status, the header names in lower case, and the body. */
export interface CliResponse {
  status: number
  headers: Record<string, string>
  body: unknown
}

/**
 * Splits the output of `<cli> api -i` into the last header block and the body. A redirect prints
 * one block per hop, and only the final one describes the answer.
 */
export function parseIncludedResponse(stdout: string): CliResponse {
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

export class HostCliError extends Error {
  readonly cli: HostCli
  readonly path: string
  readonly stderr: string
  readonly exitCode: number
  /** True when the CLI binary is not on PATH. */
  readonly missingBinary: boolean

  constructor(cli: HostCli, path: string, stderr: string, exitCode: number, missingBinary = false) {
    super(`${cli} api ${path} failed (${exitCode}): ${stderr.trim()}`)
    this.name = 'HostCliError'
    this.cli = cli
    this.path = path
    this.stderr = stderr
    this.exitCode = exitCode
    this.missingBinary = missingBinary
  }
  /** Both CLIs exit 1 and name the status in stderr for a missing resource. */
  get notFound(): boolean {
    return /HTTP 404|404 Not Found/i.test(this.stderr)
  }
  get unauthenticated(): boolean {
    return /HTTP 401|401 Unauthorized|not logged in|auth login/i.test(this.stderr)
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  missingBinary: boolean
}

export interface CliExecOptions {
  binary?: string
  env?: Record<string, string>
  /** Written to the child's stdin, for `api --input -`. */
  input?: string
}

export function execCli(args: string[], opts: CliExecOptions = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    const child = execFile(
      opts.binary ?? 'gh',
      args,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } },
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

export type CliExec = typeof execCli

export const GH_CLI: HostCliSpec = { cli: 'gh', env: {}, tokenArgs: ['auth', 'token'] }

/** `glab` reads its instance from GITLAB_HOST, and prints a login's token through `config get`. */
export function glabCli(hostname: string): HostCliSpec {
  return {
    cli: 'glab',
    env: { GITLAB_HOST: hostname },
    tokenArgs: ['config', 'get', 'token', '--host', hostname],
  }
}

export function createHostClient(spec: HostCliSpec, exec: CliExec = execCli): HostClient {
  const run = async (path: string, args: string[], input?: string): Promise<ExecResult> => {
    const r = await exec(args, { binary: spec.cli, env: spec.env, ...(input === undefined ? {} : { input }) })
    if (r.code !== 0) {
      throw new HostCliError(
        spec.cli,
        path,
        r.missingBinary ? `${spec.cli}: command not found` : r.stderr,
        r.code,
        r.missingBinary
      )
    }
    return r
  }
  return {
    api: async (path, params = {}) => {
      // `api` switches to POST as soon as a field is given; these are reads, so pin GET.
      const args = ['api', '--method', 'GET', path]
      for (const [k, v] of Object.entries(params)) {
        args.push('-F', `${k}=${v}`)
      }
      return JSON.parse((await run(path, args)).stdout) as unknown
    },
    apiWithHeaders: async path =>
      parseIncludedResponse((await run(path, ['api', '-i', '--method', 'GET', path])).stdout),
    post: async (path, body) => {
      // The payload goes over stdin, so no comment text ever appears in an argument list. The
      // content type is named because `glab` does not infer it and GitLab answers 415 without it.
      const args = ['api', '--method', 'POST', path, '--input', '-', '-H', 'Content-Type: application/json']
      return JSON.parse((await run(path, args, JSON.stringify(body))).stdout) as unknown
    },
    graphql: async (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`]
      for (const [k, v] of Object.entries(variables)) {
        args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
      }
      const body = JSON.parse((await run('graphql', args)).stdout) as {
        data?: unknown
        errors?: Array<{ message: string }>
      }
      if (body.errors && body.errors.length > 0) {
        throw new HostCliError(spec.cli, 'graphql', body.errors.map(e => e.message).join('; '), 1)
      }
      return body.data
    },
    authStatus: async () => {
      const r = await exec(['auth', 'status'], { binary: spec.cli, env: spec.env })
      if (r.missingBinary) {
        return { installed: false, authenticated: false, detail: `${spec.cli} is not on PATH` }
      }
      const detail = (r.stdout + r.stderr).trim().split('\n')[0] ?? ''
      return { installed: true, authenticated: r.code === 0, detail }
    },
    authToken: async () => {
      const r = await exec(spec.tokenArgs, { binary: spec.cli, env: spec.env })
      const token = r.stdout.trim()
      return r.code === 0 && token !== '' ? token : null
    },
  }
}
