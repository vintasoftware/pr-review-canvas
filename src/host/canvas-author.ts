// Who may supply a pull request's canvas. Anyone can comment on a public pull request, so a canvas
// zip or canvas comment from a stranger could stand in for the author's: it is skipped instead.
import { z } from 'zod'
import type { Repo } from '../contract/review-artifact.js'
import { gitlabProjectApi } from '../gitlab/project.js'
import type { HostClient } from './client.js'

/** Who wrote the text a canvas was found in, and their role as the host reports it, if it does. */
export interface CanvasAuthor {
  login: string
  /** GitHub's `author_association`; GitLab reports no role on a note. */
  association?: string
}

/** True when `login` opened the review. `ghost` stands for any deleted account, so it matches nobody. */
export function isReviewAuthor(login: string, reviewAuthor: string): boolean {
  return login !== 'ghost' && login.toLowerCase() === reviewAuthor.toLowerCase()
}

/** GitHub's `author_association` values for people with a role on the repository. */
const GITHUB_REPOSITORY_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** On GitHub: the pull request's author, or an owner, member, or collaborator of the repository. */
export function githubTrustsCanvasAuthor(author: CanvasAuthor, reviewAuthor: string): Promise<boolean> {
  return Promise.resolve(
    isReviewAuthor(author.login, reviewAuthor) || GITHUB_REPOSITORY_ROLES.has(author.association ?? '')
  )
}

const GitlabMembersSchema = z.array(z.object({ username: z.string() }))

/**
 * On GitLab: the merge request's author, or a member of the project, directly or through its
 * groups. A note carries no role, so membership is asked of the members API.
 */
export async function gitlabTrustsCanvasAuthor(
  client: HostClient,
  repo: Repo,
  author: CanvasAuthor,
  reviewAuthor: string
): Promise<boolean> {
  if (isReviewAuthor(author.login, reviewAuthor)) return true
  if (author.login === 'ghost') return false
  const members = GitlabMembersSchema.parse(
    await client.api(`${gitlabProjectApi(repo)}/members/all`, { query: author.login, per_page: '100' })
  )
  return members.some(m => m.username.toLowerCase() === author.login.toLowerCase())
}
