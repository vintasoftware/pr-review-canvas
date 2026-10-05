// Where a project lives on the shared server. One server serves every project the user opens, so
// each gets a path of its own: `/r/<owner>/<repo>/` for a clone's main checkout, and
// `/r/<owner>/<repo>~<folder>/` for each linked worktree, whose branch and working tree differ.
// The slug comes from the repository alone, so a command that runs without the server (publish)
// prints the same URL the server answers on.
import path from 'node:path'
import type { Repo } from '../contract/review-artifact.js'

/** The prefix every project path starts with. */
export const PROJECTS_PREFIX = '/r/'

/** What separates a linked worktree's folder from its repository in a slug. */
const WORKTREE_MARK = '~'

/** A worktree folder name as a path segment: letters, digits, `.`, `_` and `-`. */
function worktreeLabel(repoRoot: string): string {
  return path.basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, '-')
}

/**
 * `<owner>/<repo>`, with `~<folder>` for a linked worktree. The main checkout is the folder that
 * holds the common `.git`; any other worktree, including every worktree of a bare clone, is linked.
 */
export function projectSlug(repo: Repo, repoRoot: string, commonDir: string): string {
  const name = `${repo.owner}/${repo.name}`
  const main =
    path.basename(commonDir) === '.git' && path.resolve(path.dirname(commonDir)) === path.resolve(repoRoot)
  return main ? name : `${name}${WORKTREE_MARK}${worktreeLabel(repoRoot)}`
}

/** The repository and the worktree folder a slug names; a main checkout names no worktree. */
export function slugParts(slug: string): { repo: string; worktree: string | null } {
  const cut = slug.indexOf(WORKTREE_MARK)
  return cut === -1
    ? { repo: slug, worktree: null }
    : { repo: slug.slice(0, cut), worktree: slug.slice(cut + 1) }
}

/** The path a project's pages and API answer under, with its trailing slash. */
export function basePathOf(slug: string): string {
  return `${PROJECTS_PREFIX}${slug.split('/').map(encodeURIComponent).join('/')}/`
}
