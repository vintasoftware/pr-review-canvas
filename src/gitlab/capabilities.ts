import { z } from 'zod'
import type { Capabilities } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'
import { gitlabProjectApi } from './project.js'

const UserSchema = z.object({ username: z.string() })
const AccessSchema = z.object({ access_level: z.number().int() }).nullable().optional()
const ProjectSchema = z.object({
  permissions: z.object({ project_access: AccessSchema, group_access: AccessSchema }).optional(),
})

/** Reporter (20) and above can comment on merge requests. */
export const GITLAB_COMMENT_ACCESS_LEVEL = 20

/**
 * Whether this login may post on this project, from the access level the project object reports
 * for the token. A token that gets no permissions block is one this check cannot read: posting
 * stays enabled and GitLab's own answer decides.
 */
export function decideGitlabCapabilities(login: string | null, projectRaw: unknown): Capabilities {
  const permissions = ProjectSchema.safeParse(projectRaw).data?.permissions
  if (permissions === undefined) {
    return {
      canComment: 'unknown',
      tokenKind: 'glab',
      login,
      reason: 'this GitLab token does not report project permissions, so posting is tried and GitLab decides',
    }
  }
  const level = Math.max(
    permissions.project_access?.access_level ?? 0,
    permissions.group_access?.access_level ?? 0
  )
  if (level < GITLAB_COMMENT_ACCESS_LEVEL) {
    return {
      canComment: false,
      tokenKind: 'glab',
      login,
      reason: 'this login cannot comment on merge requests in this project',
      hint: 'ask for Reporter access or higher',
    }
  }
  return { canComment: true, tokenKind: 'glab', login }
}

/** The probe itself: who the token belongs to, and what it may do here. */
export async function probeGitlabCapabilities(client: HostClient, repo: Repo): Promise<Capabilities> {
  const login = await client
    .api('user')
    .then(raw => UserSchema.parse(raw).username)
    .catch(() => null)
  try {
    return decideGitlabCapabilities(login, await client.api(gitlabProjectApi(repo)))
  } catch (err) {
    return {
      canComment: false,
      tokenKind: 'unknown',
      login,
      reason: err instanceof Error ? err.message : String(err),
      hint: 'run `glab auth status` and log in again',
    }
  }
}
