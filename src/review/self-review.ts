// Self-review: the author settles attention points before asking for review, and the canvas carries
// each answer to every reviewer. A settled point leaves the reviewer's list; its reason stays.
import type { GenerationContext } from '../contract/generation-context.js'
import type { Point, Pr, ReviewArtifact, Settlement } from '../contract/review-artifact.js'
import { POINT_LEVELS } from '../contract/review-artifact.js'
import { fingerprint } from './normalize.js'

type Level = (typeof POINT_LEVELS)[number]

/** What a canvas leaves open, as the shared comment counts it. */
export interface CanvasTally {
  /** Unsettled points for the reviewer, by level. */
  reviewer: Record<Level, number>
  /** Unsettled points the author could still settle. */
  authorOpen: number
  settled: number
}

export function isSettled(
  artifact: Pick<ReviewArtifact, 'settled'>,
  point: Pick<Point, 'fingerprint'>
): boolean {
  return artifact.settled?.[point.fingerprint] !== undefined
}

export function tallyCanvas(artifact: Pick<ReviewArtifact, 'points' | 'settled'>): CanvasTally {
  const tally: CanvasTally = { reviewer: { decide: 0, check: 0, fyi: 0 }, authorOpen: 0, settled: 0 }
  for (const point of artifact.points) {
    if (isSettled(artifact, point)) {
      tally.settled += 1
    } else if (point.audience === 'author') {
      tally.authorOpen += 1
    } else {
      tally.reviewer[point.level] += 1
    }
  }
  return tally
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The lines of the shared canvas comment that say what is left, and for whom. */
export function tallyMarkdown(tally: CanvasTally): string {
  const levels = POINT_LEVELS.filter(l => tally.reviewer[l] > 0).map(l => `${tally.reviewer[l]} ${l}`)
  const total = POINT_LEVELS.reduce((n, l) => n + tally.reviewer[l], 0)
  const lines = [
    total === 0
      ? '**For the reviewer:** no open attention points.'
      : `**For the reviewer:** ${plural(total, 'attention point')} to judge (${levels.join(', ')}).`,
  ]
  if (tally.settled > 0) {
    lines.push(`**Settled by the author:** ${tally.settled}, each with its reason in the canvas.`)
  }
  if (tally.authorOpen > 0) {
    lines.push(`**Not yet settled by the author:** ${tally.authorOpen}.`)
  }
  return lines.join('\n')
}

/** The canvas with the point settled, or reopened when `settlement` is undefined, stamped as revised. */
export function withSettlement(
  artifact: ReviewArtifact,
  pointFingerprint: string,
  settlement: Settlement | undefined,
  revisedAt: string
): ReviewArtifact & { settled: Record<string, Settlement>; revisedAt: string } {
  const { [pointFingerprint]: _previous, ...rest } = artifact.settled ?? {}
  const settled = settlement === undefined ? rest : { ...rest, [pointFingerprint]: settlement }
  return { ...artifact, settled, revisedAt }
}

/** The comment a settled point's reason is posted as, on the point's line. */
export function settlementCommentBody(point: Pick<Point, 'title'>, reason: string): string {
  return `**Settled by the author:** ${point.title}\n\n${reason.trim()}\n\n_from the pr-review canvas self-review_`
}

/**
 * Whether the signed-in login wrote the pull request. The forge compares logins without case, so
 * this does too.
 */
export function isAuthor(login: string | null, pr: Pick<Pr, 'author'>): boolean {
  return login !== null && login.toLowerCase() === pr.author.toLowerCase()
}

/**
 * The settlements a newly generated canvas keeps. A settlement answers the code under its point, so
 * it survives only where that code survives: in a regeneration of the same commit, under an author
 * point with the same fingerprint; in an incremental run, under one the basis split carried.
 */
export function carriedSettlements(
  artifact: Pick<ReviewArtifact, 'points'>,
  sources: {
    sameCommit: Pick<ReviewArtifact, 'settled'> | null
    basis: {
      artifact: Pick<ReviewArtifact, 'settled'>
      split: NonNullable<GenerationContext['basis']>
    } | null
  }
): Record<string, Settlement> {
  // Only an author point takes a settlement: a point regenerated for the reviewer loses its answer.
  const present = new Set(artifact.points.filter(p => p.audience === 'author').map(p => p.fingerprint))
  const carriedByBasis = new Set(
    (sources.basis?.split.points ?? []).filter(p => p.status === 'carried').map(p => fingerprint(p))
  )
  const out: Record<string, Settlement> = {}
  for (const [fp, settlement] of Object.entries(sources.basis?.artifact.settled ?? {})) {
    if (present.has(fp) && carriedByBasis.has(fp)) {
      out[fp] = settlement
    }
  }
  for (const [fp, settlement] of Object.entries(sources.sameCommit?.settled ?? {})) {
    if (present.has(fp)) {
      out[fp] = settlement
    }
  }
  return out
}
