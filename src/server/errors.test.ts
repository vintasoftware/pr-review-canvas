// @vitest-environment node
import { ConfigError } from '../config.js'
import { GitError } from '../git/git.js'
import { HostCliError } from '../host/client.js'
import { PrNotFoundError } from '../host/pr.js'
import { AppError, toAppError } from './errors.js'

describe('toAppError', () => {
  it('maps every known error to a code, status, and hint', () => {
    expect(toAppError(new PrNotFoundError(9))).toMatchObject({ code: 'PR_NOT_FOUND', status: 404 })
    expect(toAppError(new HostCliError('gh', 'user', 'HTTP 401', 1))).toMatchObject({
      code: 'GH_UNAUTHENTICATED',
      status: 401,
      hint: 'run `gh auth login`',
    })
    expect(toAppError(new HostCliError('gh', 'user', 'HTTP 502', 1))).toMatchObject({
      code: 'GITHUB_API_ERROR',
      status: 502,
    })
    expect(toAppError(new HostCliError('gh', 'user', 'gh: command not found', 1, true))).toMatchObject({
      code: 'GH_MISSING',
      status: 500,
      message: 'the GitHub CLI (gh) is not installed',
      hint: 'install it from https://cli.github.com',
    })
    expect(toAppError(new HostCliError('glab', 'user', 'glab: command not found', 1, true))).toMatchObject({
      code: 'GLAB_MISSING',
      hint: 'install it from https://gitlab.com/gitlab-org/cli',
    })
    expect(toAppError(new HostCliError('glab', 'user', '401 Unauthorized', 1))).toMatchObject({
      code: 'GLAB_UNAUTHENTICATED',
      hint: 'run `glab auth login`',
    })
    expect(toAppError(new GitError(['diff'], 'bad', 128))).toMatchObject({ code: 'GIT_ERROR', status: 500 })
    expect(toAppError(new ConfigError('NO_ORIGIN', 'no origin', 'add one'))).toMatchObject({
      code: 'NO_ORIGIN',
      status: 500,
      hint: 'add one',
    })
    expect(toAppError(new Error('x'))).toMatchObject({ code: 'INTERNAL', status: 500, message: 'x' })
    expect(toAppError('str')).toMatchObject({ code: 'INTERNAL', message: 'str' })
    const app = new AppError('BAD_REQUEST', 'm', 400)
    expect(toAppError(app)).toBe(app)
  })

  it('builds the envelope with an optional hint', () => {
    expect(new AppError('NOT_FOUND', 'gone', 404).toEnvelope()).toEqual({
      error: { code: 'NOT_FOUND', message: 'gone' },
    })
    expect(new AppError('NOT_FOUND', 'gone', 404, 'look elsewhere').toEnvelope()).toEqual({
      error: { code: 'NOT_FOUND', message: 'gone', hint: 'look elsewhere' },
    })
  })
})
