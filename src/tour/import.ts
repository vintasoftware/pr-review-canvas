// One import path for the ways a tour arrives from elsewhere: the tour page's drop zone, its look
// for a shared tour, and `pr-review tour import`. Everything is checked here, so no caller can skip
// a step. The tour page decides afresh whether a stored tour is current or stale, so an import only
// stores it.
import type { CommentsPayload } from '../contract/comments.js'
import type { Pr } from '../contract/review-artifact.js'
import type { TourImportResult } from '../contract/tour-api.js'
import type { TourArtifact } from '../contract/tour.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { readTourComment } from './comment.js'
import { parseTourZipName, readTourZip } from './zip.js'

export interface TourImportOptions {
  bytes: Uint8Array
  /** The pull request the tour is imported for; it files the tour under that number. */
  prNumber?: number | undefined
  /** Accepts a tour exported from another repository. */
  force?: boolean | undefined
}

function sameRepo(a: { owner: string; name: string }, b: { owner: string; name: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
}

/** When a tour last changed: its author revises it by finishing, which keeps its generation time. */
function revision(tour: Pick<TourArtifact, 'generatedAt' | 'revisedAt'>): string {
  return tour.revisedAt ?? tour.generatedAt
}

/**
 * Validates the zip and stores the tour under its head sha. A tour already on disk is kept unless
 * the incoming one was generated or revised later.
 */
export async function importTour(ctx: AppContext, opts: TourImportOptions): Promise<TourImportResult> {
  const { manifest, artifact } = readTourZip(opts.bytes)
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
  const named = manifest.prNumber ?? artifact.pr.number ?? undefined
  if (opts.prNumber !== undefined && named !== undefined && named !== opts.prNumber) {
    throw new AppError(
      'CANVAS_PR_MISMATCH',
      `this tour was exported for #${named}, and it is being imported for #${opts.prNumber}`,
      400,
      `import it without --pr to store it under #${named}, or generate a tour for #${opts.prNumber}`
    )
  }
  const headSha = manifest.headSha
  if (artifact.headSha !== headSha) {
    throw new AppError(
      'CANVAS_INVALID',
      `the zip's manifest names ${headSha.slice(0, 7)} and its tour ${artifact.headSha.slice(0, 7)}`,
      400
    )
  }
  const stored = await ctx.tours.read(headSha)
  if (stored !== null && revision(stored) >= revision(artifact)) {
    return { status: 'exists', headSha, warnings }
  }
  const number = opts.prNumber ?? artifact.pr.number
  await ctx.tours.write(headSha, {
    ...artifact,
    pr: { ...artifact.pr, number },
    source: 'import',
  })
  return { status: 'imported', headSha, warnings }
}

/** How many shared tours a fetch tries before it gives up: a broken one must not hide a good one. */
const MAX_SHARED_TRIED = 3

/**
 * Looks through the pull request's comments for tour comments (`readTourComment`) and imports the
 * best one: of the head first, then the newest. A comment whose zip names another pull request is
 * passed over. Answers whether one was found, and whether an import stored it.
 */
export async function fetchSharedTour(
  ctx: AppContext,
  pr: Pr,
  comments: CommentsPayload
): Promise<{ found: boolean; imported: boolean; warnings: string[] }> {
  const number = pr.number
  if (number === null) return { found: false, imported: false, warnings: [] }
  const candidates = comments.issueComments
    .flatMap(comment => {
      const zip = readTourComment(comment.body)
      const named = zip === null ? null : parseTourZipName(zip.name, ctx.config.repo)
      if (zip === null || named === null) return []
      if (named.prNumber !== undefined && named.prNumber !== number) return []
      return [{ zip, ofHead: named.shaPrefix === pr.headSha.slice(0, 8), at: comment.updatedAt }]
    })
    .sort((a, b) => (a.ofHead !== b.ofHead ? (a.ofHead ? -1 : 1) : a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  const warnings: string[] = []
  for (const candidate of candidates.slice(0, MAX_SHARED_TRIED)) {
    try {
      const result = await importTour(ctx, { bytes: candidate.zip.bytes, prNumber: number })
      return {
        found: true,
        imported: result.status === 'imported',
        warnings: [...warnings, ...result.warnings],
      }
    } catch (err) {
      warnings.push(`${candidate.zip.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { found: candidates.length > 0, imported: false, warnings }
}
