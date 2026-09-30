// The tour a page or a scene frame shows for a review key: the stored tour for the head, the
// newest older one when the head moved, or, in preview, the model as the generator has written it.
import path from 'node:path'
import type { TourStaleInfo } from '../contract/tour-api.js'
import { formatTourError, type TourArtifact } from '../contract/tour.js'
import type { Pr } from '../contract/review-artifact.js'
import type { ReviewKey } from '../contract/review-key.js'
import type { PrLoader } from '../server/bundle.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { readText } from '../store/atomic-json.js'
import { tourBelongsTo } from '../store/tour-store.js'
import { readTourContext, readTourModel, tourValidationInput } from './publish.js'
import { validateTourModel } from './validate.js'

export type TourLookupResult =
  | { status: 'ready'; pr: Pr; headSha: string; artifact: TourArtifact; preview: boolean }
  | { status: 'stale'; pr: Pr; headSha: string; artifact: TourArtifact; stale: TourStaleInfo; preview: false }
  | { status: 'missing'; pr: Pr; preview: false }

/**
 * The tour as written in `tours/<head>/tour-model.json`, validated as `tour publish` would, or
 * null when nothing is being written there. An invalid model is an error with its problems, one
 * line each, so the generator sees in the page what publish would refuse.
 */
export async function previewArtifact(ctx: AppContext, pr: Pr): Promise<TourArtifact | null> {
  const tourDir = ctx.tours.tourDir(pr.headSha)
  if ((await readText(path.join(tourDir, 'context.json'))) === null) return null
  const context = await readTourContext(tourDir)
  const model = await readTourModel(context)
  const result =
    'error' in model
      ? {
          ok: false,
          errors: [{ code: 'SCHEMA' as const, where: '(root)', message: model.error.message }],
          output: null,
        }
      : validateTourModel(model.raw, await tourValidationInput(ctx, context, model.raw))
  if (!result.ok || result.output === null) {
    throw new AppError(
      'MODEL_INVALID',
      'tour-model.json does not validate',
      422,
      'fix it and reload',
      result.errors.map(formatTourError)
    )
  }
  return {
    version: 1,
    pr: context.pr,
    repo: context.repo,
    headSha: context.headSha,
    mergeBaseSha: context.mergeBaseSha,
    blastRadius: context.blastRadius,
    budget: context.budget,
    guide: context.guide.path,
    landmarks: result.output.landmarks,
    decisions: result.output.decisions,
    quiz: result.output.quiz,
    notToured: result.output.notToured,
    generatedAt: ctx.now().toISOString(),
    generator: { agent: 'preview', harness: 'other', attempts: 0 },
    source: 'local',
    record: { touredBy: [] },
  }
}

export async function lookupTour(
  ctx: AppContext,
  loader: PrLoader,
  key: ReviewKey,
  opts: { preview?: boolean | undefined } = {}
): Promise<TourLookupResult> {
  const pr = await loader.currentTarget(key)
  if (opts.preview === true) {
    const artifact = await previewArtifact(ctx, pr)
    if (artifact !== null) return { status: 'ready', pr, headSha: pr.headSha, artifact, preview: true }
  }
  const found = await ctx.tours.findFor(key, pr.headSha)
  if (found.status === 'missing') return { status: 'missing', pr, preview: false }
  const artifact = await ctx.tours.read(found.headSha)
  if (artifact === null) {
    throw new AppError(
      'CANVAS_INVALID',
      `the tour of ${found.headSha.slice(0, 7)} cannot be read`,
      500,
      'generate it again'
    )
  }
  if (found.status === 'ready')
    return { status: 'ready', pr, headSha: found.headSha, artifact, preview: false }
  const stale: TourStaleInfo = {
    tourHeadSha: found.headSha,
    currentHeadSha: pr.headSha,
    relation: found.relation,
  }
  if (found.commitsBehind !== undefined) stale.commitsBehind = found.commitsBehind
  return { status: 'stale', pr, headSha: found.headSha, artifact, stale, preview: false }
}

/** The tour at a given commit, when the index files it under this key; for the scene frames. */
export async function tourAt(ctx: AppContext, key: ReviewKey, headSha: string): Promise<TourArtifact> {
  const entry = (await ctx.tours.readIndex()).tours[headSha]
  const artifact = entry !== undefined && tourBelongsTo(entry, key) ? await ctx.tours.read(headSha) : null
  if (artifact === null) {
    throw new AppError('CANVAS_NOT_FOUND', `no tour of ${String(key)} at ${headSha.slice(0, 7)}`, 404)
  }
  return artifact
}
