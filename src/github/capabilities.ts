import { z } from 'zod'
import type { Capabilities } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { GhResponse, GitHubClient } from './gh.js'

const UserSchema = z.object({ login: z.string() })
const RepoBodySchema = z.object({
  private: z.boolean().optional(),
  permissions: z.object({ pull: z.boolean().optional(), push: z.boolean().optional() }).optional(),
})

/** What a page assumes before the probe answers: posting is tried and GitHub decides. */
export const UNKNOWN_CAPABILITIES: Capabilities = {
  canComment: 'unknown',
  tokenKind: 'unprobed',
  login: null,
}

export const SCOPE_HINT = 'gh auth refresh -h github.com -s repo'

/** How long a probe answer is reused. A new token needs `?refresh=1` or ten minutes. */
export const CAPABILITY_TTL_MS = 10 * 60 * 1000

/**
 * Whether this login may post on this repository, from the token's scopes and the repository
 * permissions. A token without a scopes header is a fine-grained or app token, whose rights this
 * check cannot read: posting stays enabled and GitHub's own answer decides.
 */
export function decideCapabilities(login: string | null, response: GhResponse): Capabilities {
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
export async function probeCapabilities(gh: GitHubClient, repo: Repo): Promise<Capabilities> {
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

export interface CapabilityProbe {
  get(opts?: { refresh?: boolean }): Promise<Capabilities>
}

/**
 * The probe with its cache. One per server process; `refresh` skips the cache after the user
 * changed their token.
 */
export function createCapabilityProbe(
  gh: GitHubClient,
  repo: Repo,
  now: () => Date,
  ttlMs = CAPABILITY_TTL_MS,
  probe: (client: GitHubClient, repo: Repo) => Promise<Capabilities> = probeCapabilities
): CapabilityProbe {
  let cached: { at: number; value: Capabilities } | null = null
  return {
    get: async (opts = {}) => {
      const at = now().getTime()
      if (!opts.refresh && cached !== null && at - cached.at < ttlMs) {
        return cached.value
      }
      const value = await probe(gh, repo)
      cached = { at, value }
      return value
    },
  }
}
