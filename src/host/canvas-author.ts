// Who may supply a pull request's canvas besides its author: someone with a role on the repository.
// Anyone can comment on a public pull request, so a canvas zip or canvas comment from a stranger
// could stand in for the author's: it is skipped instead.
import { z } from 'zod'
import type { Repo } from '../contract/review-artifact.js'
import { gitlabProjectApi } from '../gitlab/project.js'
import { isAuthor } from '../../static/js/host.js'
import type { HostClient } from './client.js'

/** Who wrote the text a canvas was found in, and their role as the host reports it, if it does. */
export interface CanvasAuthor {
  login: string
  /** GitHub's `author_association`; GitLab reports no role on a note. */
  association?: string
}

/** The name both forges give every deleted account, so it names nobody in particular. */
const DELETED_ACCOUNT = 'ghost'

/** True when `login` opened the review, in any letter case. A deleted account never did. */
export function isReviewAuthor(login: string, reviewAuthor: string): boolean {
  return login !== DELETED_ACCOUNT && isAuthor(login, { author: reviewAuthor })
}

/** GitHub's `author_association` values for people with a role on the repository. */
const GITHUB_REPOSITORY_ROLES = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

/** On GitHub: an owner, member, or collaborator of the repository, as the comment itself says. */
export function hasGithubRole(author: CanvasAuthor): boolean {
  return GITHUB_REPOSITORY_ROLES.has(author.association ?? '')
}

const GitlabMembersSchema = z.array(z.object({ username: z.string() }))
const MEMBERS_PAGE_SIZE = 100

/**
 * On GitLab: a member of the project, directly or through its groups. A note carries no role, so
 * membership is asked of the members API. Its `query` also matches names and parts of them, so
 * every page is read until one holds the username itself.
 */
export async function hasGitlabRole(client: HostClient, repo: Repo, author: CanvasAuthor): Promise<boolean> {
  // Membership is asked by name, and a deleted account's name is every deleted account's.
  if (author.login === DELETED_ACCOUNT) return false
  const username = author.login.toLowerCase()
  for (let page = 1; ; page++) {
    const members = GitlabMembersSchema.parse(
      await client.api(`${gitlabProjectApi(repo)}/members/all`, {
        query: author.login,
        per_page: String(MEMBERS_PAGE_SIZE),
        page: String(page),
      })
    )
    if (members.some(m => m.username.toLowerCase() === username)) return true
    if (members.length < MEMBERS_PAGE_SIZE) return false
  }
}
