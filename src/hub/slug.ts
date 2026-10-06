// Where a project lives on the shared server. One server serves every project the user opens, so
// each gets a path of its own: `/r/<owner>/<repo>/` for a clone's main checkout, and
// `/r/<owner>/<repo>~<worktree>/` for each linked worktree, whose branch and working tree differ.
// The slug comes from the repository alone, so a command that runs without the server (publish)
// prints the same URL the server answers on.
import path from 'node:path'
import type { Repo } from '../contract/review-artifact.js'
import { WORKTREE_MARK } from '../contract/review-key.js'

/** The prefix every project path starts with. */
export const PROJECTS_PREFIX = '/r/'

/**
 * The label of a linked worktree: git's own name for it, the last part of its git dir
 * (`<common>/worktrees/<name>`). git takes it from the folder's name, keeps it unique within the
 * clone, and keeps it when the worktree moves. Null for the clone's main checkout, whose git dir
 * is the common one; every worktree of a bare clone is linked. The checkout's slug and the folders
 * of its local reviews both carry this label.
 */
export function worktreeOf(gitDir: string, commonDir: string): string | null {
  return path.resolve(gitDir) === path.resolve(commonDir) ? null : path.basename(gitDir)
}

/** `<owner>/<repo>`, with `~<label>` for a linked worktree. */
export function projectSlug(repo: Repo, worktree: string | null): string {
  const name = `${repo.owner}/${repo.name}`
  return worktree === null ? name : `${name}${WORKTREE_MARK}${worktree}`
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
