import { inspect } from 'node:util'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ConfigError } from '../config.js'
import type { ErrorCode, ErrorEnvelope } from '../contract/api.js'
import { GitError } from '../git/git.js'
import { LocalTargetError } from '../git/local-target.js'
import { PrNotFoundError } from '../host/pr.js'
import { CLI_INFO, type HostCli, HostCliError } from '../host/client.js'

/** The codes each host CLI's failures map to. The front end and the docs name them one by one. */
const CLI_ERROR_CODES: Record<HostCli, { missing: ErrorCode; unauthenticated: ErrorCode; api: ErrorCode }> = {
  gh: { missing: 'GH_MISSING', unauthenticated: 'GH_UNAUTHENTICATED', api: 'GITHUB_API_ERROR' },
  glab: { missing: 'GLAB_MISSING', unauthenticated: 'GLAB_UNAUTHENTICATED', api: 'GITLAB_API_ERROR' },
}

/** The codes that mean the host CLI itself, not the request, is the problem. */
export const CLI_SETUP_CODES: ReadonlySet<ErrorCode> = new Set(
  Object.values(CLI_ERROR_CODES).flatMap(c => [c.missing, c.unauthenticated])
)

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: ContentfulStatusCode
  readonly hint: string | undefined
  /** What a rejected file got wrong, one line each. Never the file's content. */
  readonly issues: string[] | undefined

  constructor(
    code: ErrorCode,
    message: string,
    status: ContentfulStatusCode,
    hint?: string,
    issues?: string[]
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.hint = hint
    this.issues = issues
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope['error'] = { code: this.code, message: this.message }
    if (this.hint !== undefined) {
      error.hint = this.hint
    }
    if (this.issues !== undefined) {
      error.issues = this.issues
    }
    return { error }
  }
}

/** Maps every error the routes can see to one AppError, so the envelope is built in one place. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err
  }
  if (err instanceof PrNotFoundError) {
    return new AppError(
      'PR_NOT_FOUND',
      err.message,
      404,
      'check the number and that origin is the right repository'
    )
  }
  if (err instanceof HostCliError) {
    const codes = CLI_ERROR_CODES[err.cli]
    const info = CLI_INFO[err.cli]
    if (err.missingBinary) {
      return new AppError(
        codes.missing,
        `the ${info.label} is not installed`,
        500,
        `install it from ${info.installUrl}`
      )
    }
    if (err.unauthenticated) {
      return new AppError(
        codes.unauthenticated,
        `${err.cli} is not logged in`,
        401,
        `run \`${info.loginCommand}\``
      )
    }
    return new AppError(codes.api, err.message, 502)
  }
  if (err instanceof LocalTargetError) {
    return new AppError('BAD_REQUEST', err.message, 400, err.hint)
  }
  if (err instanceof GitError) {
    return new AppError('GIT_ERROR', err.message, 500)
  }
  if (err instanceof ConfigError) {
    return new AppError(err.code, err.message, 500, err.hint)
  }
  return new AppError('INTERNAL', err instanceof Error ? err.message : String(err), 500)
}

/** Keep the original error and its causes in the server log, before response mapping loses the stack. */
export function logRequestError(
  log: (line: string) => void,
  request: { method: string; path: string },
  err: unknown
): void {
  const mapped = toAppError(err)
  if (mapped.status >= 500) {
    log(`[serve] ${request.method} ${request.path} ${mapped.status} ${mapped.code}\n${inspect(err)}`)
  }
}
