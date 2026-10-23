// One import path for the ways a tour arrives from elsewhere: the tour page's drop zone, its look
// for a shared tour, and `pr-review tour import`. Everything is checked here, so no caller can skip
// a step. The tour page decides afresh whether a stored tour is current or stale, so an import only
// stores it.
import { readZipOrThrow, sameRepo } from '../canvas/import.js'
import type { CommentsPayload } from '../contract/comments.js'
import type { Pr } from '../contract/review-artifact.js'
import type { TourImportResult } from '../contract/tour-api.js'
import type { TourArtifact, TouredBy, TourRecord } from '../contract/tour.js'
import {
  collectCandidates,
  type DiscoverySources,
  downloadAttachment,
  MAX_CANDIDATES_TRIED,
  namesAnotherPr,
  rankCandidates,
} from '../host/attachments.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { TOUR_ZIP } from './comment.js'

export interface TourImportOptions {
  bytes: Uint8Array
  /** The pull request the tour is imported for; it files the tour under that number. */
  prNumber?: number | undefined
  /** Accepts a tour exported from another repository. */
  force?: boolean | undefined
}

/** When a tour last changed: its author revises it by finishing, which keeps its generation time. */
function revision(tour: Pick<TourArtifact, 'generatedAt' | 'revisedAt'>): string {
  return tour.revisedAt ?? tour.generatedAt
}

/**
 * Two copies' records of one tour as one: everyone who finished either copy, each by their latest
 * finish, and the author's picks from the copy the author finished last. Every reader who finishes
 * posts a copy of their own, so the record is whole only once the copies are read together.
 */
export function mergedRecord(
  stored: TourRecord,
  incoming: TourRecord
): { record: TourRecord; changed: boolean } {
  const byLogin = new Map<string, TouredBy>(stored.touredBy.map(t => [t.login, t]))
  let changed = false
  for (const t of incoming.touredBy) {
    const seen = byLogin.get(t.login)
    if (seen === undefined || seen.at < t.at) {
      byLogin.set(t.login, t)
      changed = true
    }
  }
  const record: TourRecord = { touredBy: [...byLogin.values()].sort((a, b) => a.at.localeCompare(b.at)) }
  const author =
    incoming.author !== undefined &&
    (stored.author === undefined || stored.author.finishedAt < incoming.author.finishedAt)
      ? incoming.author
      : stored.author
  if (author !== undefined) record.author = author
  if (author !== stored.author) changed = true
  return { record, changed }
}

/**
 * Validates the zip and stores the tour under its head sha. A tour already on disk keeps its
 * content unless the incoming one was generated or revised later, and takes the incoming record's
 * finishes either way, so no copy loses a reader's sign-off or the author's picks.
 */
export async function importTour(ctx: AppContext, opts: TourImportOptions): Promise<TourImportResult> {
  const { manifest, artifact, prNumber: named } = readZipOrThrow(opts.bytes, TOUR_ZIP)
  const warnings: string[] = []
  if (!sameRepo(manifest.repo, ctx.config.repo)) {
    const from = `${manifest.repo.owner}/${manifest.repo.name}`
    if (opts.force !== true) {
      throw new AppError(
        'CANVAS_REPO_MISMATCH',
        `this tour was exported from ${from}, and origin here is ${ctx.config.repo.owner}/${ctx.config.repo.name}`,
        400,
        'import it with --force to use it anyway'
      )
    }
    warnings.push(`imported a tour exported from ${from}`)
  }
  // As for the canvas, the one check --force cannot lift: the tour may only be filed under the
  // pull request its zip names.
  if (opts.prNumber !== undefined && named !== undefined && named !== opts.prNumber) {
    throw new AppError(
      'CANVAS_PR_MISMATCH',
      `this tour was exported for #${named}, and it is being imported for #${opts.prNumber}`,
      400,
      `import it without --pr to store it under #${named}, or generate a tour for #${opts.prNumber}`
    )
  }
  const headSha = manifest.headSha
  const stored = await ctx.tours.read(headSha)
  const number = opts.prNumber ?? artifact.pr.number
  if (stored === null) {
    await ctx.tours.write(headSha, { ...artifact, pr: { ...artifact.pr, number }, source: 'import' })
    return { status: 'imported', headSha, warnings }
  }
  const { record, changed } = mergedRecord(stored.record, artifact.record)
  if (revision(stored) < revision(artifact)) {
    await ctx.tours.write(headSha, { ...artifact, pr: { ...artifact.pr, number }, source: 'import', record })
    return { status: 'imported', headSha, warnings }
  }
  if (!changed) return { status: 'exists', headSha, warnings }
  await ctx.tours.revise(headSha, { ...stored, record, revisedAt: ctx.now().toISOString() })
  return { status: 'imported', headSha, warnings }
}

/**
 * Looks on the pull request for a tour someone shared, in a comment's hidden block or attached as
 * a zip the comment did not fit, and imports the best one: of the head first, then this pull
 * request's, then the newest, as the canvas's discovery ranks them. Answers whether one was found,
 * and whether an import stored anything.
 */
export async function fetchSharedTour(
  ctx: AppContext,
  pr: Pr,
  comments: CommentsPayload
): Promise<{ found: boolean; imported: boolean; warnings: string[] }> {
  const number = pr.number
  if (number === null) return { found: false, imported: false, warnings: [] }
  const sources: DiscoverySources = { body: pr.body, bodyUpdatedAt: pr.updatedAt ?? '', comments }
  const ranked = rankCandidates(
    collectCandidates(sources, ctx.config.repo, ctx.config.host.attachments, 'tour'),
    { headSha: pr.headSha, prNumber: number }
  ).filter(c => !namesAnotherPr(c, number))
  const warnings: string[] = []
  // A broken attachment must not hide a good one behind it, so the next ones are tried too.
  for (const candidate of ranked.slice(0, MAX_CANDIDATES_TRIED)) {
    const download =
      candidate.bytes === undefined
        ? await downloadAttachment(ctx, candidate.url)
        : { ok: true as const, bytes: candidate.bytes }
    if (!download.ok) {
      warnings.push(`${candidate.name}: ${download.reason}`)
      continue
    }
    try {
      const result = await importTour(ctx, { bytes: download.bytes, prNumber: number })
      return {
        found: true,
        imported: result.status === 'imported',
        warnings: [...warnings, ...result.warnings],
      }
    } catch (err) {
      warnings.push(`${candidate.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { found: ranked.length > 0, imported: false, warnings }
}
