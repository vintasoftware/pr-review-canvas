import { z } from 'zod'
import type { Capabilities } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { GitHubClient } from '../github/gh.js'
import { gitlabProjectApi } from './project.js'

const UserSchema = z.object({ username: z.string() })
const ProjectSchema = z.object({
  permissions: z
    .object({
      project_access: z.object({ access_level: z.number().int().optional() }).nullable().optional(),
      group_access: z.object({ access_level: z.number().int().optional() }).nullable().optional(),
    })
    .optional(),
})

/** Reporter (20) and above can comment on merge requests. */
export const GITLAB_COMMENT_ACCESS_LEVEL = 20

export const GITLAB_SCOPE_HINT = 'glab auth login'

function accessLevel(body: z.infer<typeof ProjectSchema>): number {
  const project = body.permissions?.project_access?.access_level ?? 0
  const group = body.permissions?.group_access?.access_level ?? 0
  return Math.max(project, group)
}

export function decideGitlabCapabilities(login: string | null, projectRaw: unknown): Capabilities {
  const parsed = ProjectSchema.safeParse(projectRaw)
  if (!parsed.success) {
    return {
      canComment: 'unknown',
      tokenKind: 'glab',
      login,
      reason: 'this GitLab token does not report project permissions, so posting is tried and GitLab decides',
    }
  }
  const level = accessLevel(parsed.data)
  if (parsed.data.permissions === undefined) {
    return {
      canComment: 'unknown',
      tokenKind: 'glab',
      login,
      reason: 'this GitLab token does not report project permissions, so posting is tried and GitLab decides',
    }
  }
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

export async function probeGitlabCapabilities(client: GitHubClient, repo: Repo): Promise<Capabilities> {
  let login: string | null = null
  try {
    login = UserSchema.parse(await client.api('user')).username
  } catch {
    login = null
  }
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
