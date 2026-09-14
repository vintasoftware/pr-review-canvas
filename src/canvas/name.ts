// The zip file name carries the repo, the PR number when there is one, and the head sha, so a
// file attached to a pull request can be recognised before it is downloaded.
import type { Repo } from '../contract/review-artifact.js'

export interface ParsedCanvasName {
  prNumber?: number
  sha7: string
}

export const CANVAS_NAME_PREFIX = 'pr-review-canvas'

/** Owner and repo names may hold characters a file name should not; runs of them become one dash. */
function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function repoSlug(repo: Repo): string {
  return `${slugPart(repo.owner)}-${slugPart(repo.name)}`
}

export interface BuildNameOptions {
  repo: Repo
  headSha: string
  prNumber?: number | undefined
}

/** `pr-review-canvas-<owner>-<repo>-pr<n>-<sha7>.zip`, without `-pr<n>` before the PR exists. */
export function buildCanvasZipName(opts: BuildNameOptions): string {
  const pr = opts.prNumber === undefined ? '' : `-pr${opts.prNumber}`
  return `${CANVAS_NAME_PREFIX}-${repoSlug(opts.repo)}${pr}-${opts.headSha.slice(0, 7)}.zip`
}

const TAIL_RE = /^(?:pr(\d+)-)?([0-9a-f]{7})\.zip$/

/**
 * Reads a file name as a canvas zip for `repo`. A name for another repository, or one that does
 * not follow the grammar, returns null: discovery uses this to skip attachments that are not ours.
 */
export function parseCanvasZipName(filename: string, repo: Repo): ParsedCanvasName | null {
  const prefix = `${CANVAS_NAME_PREFIX}-${repoSlug(repo)}-`
  const lower = filename.toLowerCase()
  if (!lower.startsWith(prefix)) {
    return null
  }
  const m = TAIL_RE.exec(lower.slice(prefix.length))
  const sha7 = m?.[2]
  if (sha7 === undefined) {
    return null
  }
  const pr = m?.[1]
  return pr === undefined ? { sha7 } : { prNumber: Number(pr), sha7 }
}
