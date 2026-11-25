// The error every route answers with, as its JSON envelope. Kept apart from errors.ts, which maps
// node-side failures (git, the host CLI, the config) onto it, so the static viewer can throw and
// answer the same errors in the browser.
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ErrorCode, ErrorEnvelope } from '../contract/api.js'

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

/** The AppError an error envelope describes, as a command reads it back from the server. */
export function fromEnvelope(error: ErrorEnvelope['error'], status: ContentfulStatusCode): AppError {
  return new AppError(error.code, error.message, status, error.hint, error.issues)
}
