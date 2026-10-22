// Self-review: the author settles attention points before asking for review, and the canvas carries
// each answer to every reviewer. Any point can be settled, a reviewer point too when it does not
// apply. A settled point leaves the reviewer's list; its reason stays.
import type { Point, Pr, ReopenedDecision, ReviewArtifact, Settlement } from '../contract/review-artifact.js'
import { POINT_LEVELS } from '../contract/review-artifact.js'
import { isLocalKey, type ReviewKey } from '../contract/review-key.js'

type Level = (typeof POINT_LEVELS)[number]

/** What a canvas leaves open, as the shared comment counts it. */
export interface CanvasTally {
  /** Unsettled points for the reviewer, by level. */
  reviewer: Record<Level, number>
  /** Unsettled author points. */
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
    lines.push(`**Resolved by the author:** ${tally.settled}, each with its reason in the canvas.`)
  }
  if (tally.authorOpen > 0) {
    lines.push(`**Not yet resolved by the author:** ${tally.authorOpen}.`)
  }
  return lines.join('\n')
}

/**
 * The canvas with the point settled, or reopened when `settlement` is undefined, stamped as revised.
 * Reopening a settled decision's point records the commit whose answer it sets aside, so the next
 * canvas leaves it open; settling it again takes the record back.
 */
export function withSettlement(
  artifact: ReviewArtifact,
  pointFingerprint: string,
  settlement: Settlement | undefined,
  revisedAt: string
): ReviewArtifact & { settled: Record<string, Settlement>; revisedAt: string } {
  const { [pointFingerprint]: _previous, ...rest } = artifact.settled ?? {}
  const settled = settlement === undefined ? rest : { ...rest, [pointFingerprint]: settlement }
  const { [pointFingerprint]: _reopened, ...stillReopened } = artifact.reopened ?? {}
  const commit = artifact.points.find(p => p.fingerprint === pointFingerprint)?.decisionCommit
  const reopened =
    settlement === undefined && commit !== undefined
      ? { ...stillReopened, [pointFingerprint]: { commit, at: revisedAt } }
      : stillReopened
  const { reopened: _old, ...revised } = artifact
  return {
    ...revised,
    settled,
    ...(Object.keys(reopened).length === 0 ? {} : { reopened }),
    revisedAt,
  }
}

/**
 * The comment a settled point's reason is posted as, on the point's line. The credit line is left
 * out when `sharing.mentionCanvas` is off.
 */
export function settlementCommentBody(
  point: Pick<Point, 'title'>,
  reason: string,
  mentionCanvas: boolean
): string {
  const credit = mentionCanvas ? '\n\n_from the pr-review canvas self-review_' : ''
  return `**Resolved by the author:** ${point.title}\n\n${reason.trim()}${credit}`
}

/**
 * Whether the signed-in login wrote the pull request. The forge compares logins without case, so
 * this does too.
 */
export function isAuthor(login: string | null, pr: Pick<Pr, 'author'>): boolean {
  return login !== null && login.toLowerCase() === pr.author.toLowerCase()
}

/**
 * Whether the reader may resolve the attention points of the canvas on screen: it is their own
 * work (local work always is, a pull request when they wrote it), and the canvas describes the
 * current head, as the settle route requires. The page offers resolve to this reader, and AI Chat
 * proposes resolutions to them; neither does for anyone else.
 */
export function readerResolves(
  key: ReviewKey,
  login: string | null,
  pr: Pick<Pr, 'author'>,
  canvasCurrent: boolean
): boolean {
  return canvasCurrent && (isLocalKey(key) || isAuthor(login, pr))
}

/**
 * The settlements a newly generated canvas keeps: those of the canvas it took its resolutions from
 * (see `findResolutionSource`), under a point with the same fingerprint. The generator is told which
 * points the author resolved, and writes a concern that still applies under its old kind, path, and
 * title, wherever its lines moved; one it reopens comes back under a new title, and so open.
 */
export function keptSettlements(
  artifact: Pick<ReviewArtifact, 'points'>,
  source: Pick<ReviewArtifact, 'settled'> | null
): Record<string, Settlement> {
  const present = new Set(artifact.points.map(p => p.fingerprint))
  return Object.fromEntries(Object.entries(source?.settled ?? {}).filter(([fp]) => present.has(fp)))
}

/**
 * The settled decisions a newly generated canvas keeps open: those the author reopened on the
 * canvas it took its resolutions from, while the point still comes from the same commit. A later
 * commit that decides the same question again is a new answer, which resolves the point once more.
 */
export function keptReopens(
  artifact: Pick<ReviewArtifact, 'points'>,
  source: Pick<ReviewArtifact, 'reopened'> | null
): Record<string, ReopenedDecision> {
  const fromCommit = new Map(artifact.points.map(p => [p.fingerprint, p.decisionCommit]))
  return Object.fromEntries(
    Object.entries(source?.reopened ?? {}).filter(([fp, reopen]) => fromCommit.get(fp) === reopen.commit)
  )
}
