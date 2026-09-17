import { z } from 'zod'
import type { Capabilities } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { CliResponse, HostClient } from '../host/client.js'

const UserSchema = z.object({ login: z.string() })
const RepoBodySchema = z.object({
  private: z.boolean().optional(),
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional() }).optional(),
})

export const SCOPE_HINT = 'gh auth refresh -h github.com -s repo'

/**
 * Whether this login may post on this repository, from the token's scopes and the repository
 * permissions. A token without a scopes header is a fine-grained or app token, whose rights this
 * check cannot read: posting stays enabled and GitHub's own answer decides.
 */
export function decideCapabilities(login: string | null, response: CliResponse): Capabilities {
  const parsed = RepoBodySchema.safeParse(response.body)
  const body = parsed.success ? parsed.data : {}
  const canPull = body.permissions?.pull === true
  const isPrivate = body.private !== false
  const header = response.headers['x-oauth-scopes']
  if (header === undefined) {
    return {
      canComment: 'unknown',
      tokenKind: 'fine-grained',
      login,
      reason: 'this token does not report its scopes, so posting is tried and GitHub decides',
    }
  }
  const scopes = header
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
  const hasScope = scopes.includes('repo') || (!isPrivate && scopes.includes('public_repo'))
  if (!hasScope) {
    return {
      canComment: false,
      tokenKind: 'classic',
      login,
      reason: `this token has no ${isPrivate ? 'repo' : 'public_repo'} scope`,
      hint: SCOPE_HINT,
    }
  }
  if (!canPull) {
    return {
      canComment: false,
      tokenKind: 'classic',
      login,
      reason: 'this login cannot read the repository',
      hint: 'ask for access to the repository',
    }
  }
  return { canComment: true, tokenKind: 'classic', login }
}

/** The probe itself: who the token belongs to, and what it may do here. */
export async function probeCapabilities(gh: HostClient, repo: Repo): Promise<Capabilities> {
  let login: string | null = null
  try {
    login = UserSchema.parse(await gh.api('user')).login
  } catch {
    login = null
  }
  try {
    return decideCapabilities(login, await gh.apiWithHeaders(`repos/${repo.owner}/${repo.name}`))
  } catch (err) {
    return {
      canComment: false,
      tokenKind: 'unknown',
      login,
      reason: err instanceof Error ? err.message : String(err),
      hint: 'run `gh auth status` and log in again',
    }
  }
}
