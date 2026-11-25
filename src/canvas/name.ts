// The zip file name carries the repo, the PR number when there is one, and the head sha, so a
// file attached to a pull request can be recognised before it is downloaded.
import type { Repo } from '../contract/review-artifact.js'

export interface ParsedCanvasName {
  prNumber?: number
  shaPrefix: string
}

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
  generatedAt: string
  prNumber?: number | undefined
}

/** PR or ref, UTC generation time to seconds, commit prefix, repository, and canvas marker. */
export function buildCanvasZipName(opts: BuildNameOptions): string {
  const target = opts.prNumber === undefined ? 'ref' : `pr-${opts.prNumber}`
  const timestamp = new Date(opts.generatedAt).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
  return `${target}-${timestamp}-${opts.headSha.slice(0, 8)}-${repoSlug(opts.repo)}-canvas.zip`
}

/** The strict form of the grammar the drop zone applies to a picked file (`validateCanvasFilename`). */
const NAME_RE = /^(?:pr-([1-9]\d*)|ref)-\d{8}t\d{6}z-([0-9a-f]{8})$/

/**
 * Reads a file name as a canvas zip for `repo`. A name for another repository, or one that does
 * not follow the grammar, returns null: discovery uses this to skip attachments that are not ours.
 */
export function parseCanvasZipName(filename: string, repo: Repo): ParsedCanvasName | null {
  const suffix = `-${repoSlug(repo)}-canvas.zip`
  const lower = filename.toLowerCase()
  if (!lower.endsWith(suffix)) {
    return null
  }
  const m = NAME_RE.exec(lower.slice(0, -suffix.length))
  const shaPrefix = m?.[2]
  if (shaPrefix === undefined) {
    return null
  }
  const pr = m?.[1]
  return pr === undefined ? { shaPrefix } : { prNumber: Number(pr), shaPrefix }
}

/** What ranking reads of a canvas found on a pull request: its name, when it appeared, and where. */
export interface RankedCandidate {
  parsed: ParsedCanvasName
  /** When the text carrying it was last edited. */
  postedAt: string
  /** Position in the scan, used when two carry the same time. */
  order: number
}

/** True when the name names a pull request, and it is not the one being looked at. */
export function namesAnotherPr(c: RankedCandidate, prNumber: number): boolean {
  return c.parsed.prNumber !== undefined && c.parsed.prNumber !== prNumber
}

/**
 * The canvas for this head wins, then one exported for this PR, then the one attached last. A name
 * that carries another pull request's number sorts below all of them: import refuses it, so it may
 * never take a place in the try budget from an attachment that could be used.
 */
export function rankCandidates<C extends RankedCandidate>(
  candidates: readonly C[],
  target: { headSha: string; prNumber: number }
): C[] {
  const shaPrefix = target.headSha.slice(0, 8)
  const score = (c: RankedCandidate): number =>
    namesAnotherPr(c, target.prNumber)
      ? -1
      : (c.parsed.shaPrefix === shaPrefix ? 2 : 0) + (c.parsed.prNumber === target.prNumber ? 1 : 0)
  return [...candidates].sort(
    (a, b) => score(b) - score(a) || b.postedAt.localeCompare(a.postedAt) || b.order - a.order
  )
}

/** Whether two names are the same repository: GitHub and GitLab compare them case-blind. */
export function sameRepo(a: Repo, b: Repo): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
}
