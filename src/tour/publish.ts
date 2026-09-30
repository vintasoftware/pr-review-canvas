// `pr-review tour publish`: read the model and the scene files, validate them against
// context.json, store the tour, and share it on the pull request. An invalid tour is never stored.
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import type { CanvasSharing } from '../contract/self-review.js'
import type { Generator } from '../contract/review-artifact.js'
import {
  type TourArtifact,
  type TourContext,
  TourContextSchema,
  type TourModel,
  type TourRecord,
  type TourValidationReport,
} from '../contract/tour.js'
import { UNCOMMITTED_STATE } from '../git/local-target.js'
import { currentHead, parseModelText, PublishError } from '../review/publish.js'
import type { AppContext } from '../server/context.js'
import { readJson, readText } from '../store/atomic-json.js'
import { shareTourOnPr } from './share.js'
import { guardPaths, type TourValidationInput, validateTourModel } from './validate.js'

export interface TourPublishOptions {
  agent: string
  model?: string | undefined
  harness: Generator['harness']
  allowStale: boolean
}

export interface TourPublishResult {
  status: 'published'
  headSha: string
  tourJsonPath: string
  attempts: number
  sharing: CanvasSharing | { status: 'local' }
  /** Where the tour shows once the server runs; absent for a `--base/--head` change set. */
  tourUrl?: string
}

/** The report of a failed tour publish. The CLI prints one line per error and exits 5. */
export class TourInvalidError extends Error {
  readonly report: TourValidationReport
  readonly attempts: number

  constructor(report: TourValidationReport, attempts: number) {
    super(`tour-model.json has ${report.errors.length} problem${report.errors.length === 1 ? '' : 's'}`)
    this.name = 'TourInvalidError'
    this.report = report
    this.attempts = attempts
  }
}

export async function readTourContext(tourDir: string): Promise<TourContext> {
  const context = await readJson(path.join(tourDir, 'context.json'), TourContextSchema)
  if (context === null) {
    throw new PublishError(
      'NOT_FOUND',
      `${tourDir} has no context.json`,
      'run `pr-review tour prepare` first'
    )
  }
  return context
}

/** The model as written, with each landmark's scene and micro-world read from the scenes dir. */
export async function readTourModel(
  context: TourContext,
  file = context.paths.model
): Promise<ReturnType<typeof parseModelText>> {
  const text = await readText(file)
  if (text === null) {
    throw new PublishError(
      'NOT_FOUND',
      `${file} does not exist`,
      'write the tour model there and publish again'
    )
  }
  const parsed = parseModelText(text, path.basename(file))
  if ('error' in parsed) return parsed
  await attachScenes(parsed.raw, context.scenesDir)
  return parsed
}

/** Fills `scene` and `micro` from `<scenes>/<id>.scene.html` and `<id>.micro.html` where the model left them out. */
async function attachScenes(raw: unknown, scenesDir: string): Promise<void> {
  const landmarks = (raw as { landmarks?: unknown })?.landmarks
  if (!Array.isArray(landmarks)) return
  for (const landmark of landmarks) {
    const l = landmark as { id?: unknown; scene?: unknown; micro?: unknown }
    if (typeof l.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(l.id)) continue
    for (const [field, suffix] of [
      ['scene', 'scene'],
      ['micro', 'micro'],
    ] as const) {
      if (l[field] !== undefined && l[field] !== null) continue
      const text = await readText(path.join(scenesDir, `${l.id}.${suffix}.html`))
      if (text !== null) l[field] = text
    }
  }
}

export async function tourValidationInput(
  ctx: AppContext,
  context: TourContext,
  raw: unknown
): Promise<TourValidationInput> {
  const inDiff = new Set(context.files.map(f => f.path))
  const headPaths = new Set<string>()
  for (const p of guardPaths(raw)) {
    if (!inDiff.has(p) && (await ctx.git.blobSize(context.headSha, p)) !== null) headPaths.add(p)
  }
  return {
    files: context.files,
    headPaths,
    caps: context.caps,
    budget: context.budget,
    categories: context.categories,
    stateRequired: context.stateRequired,
    options: context.options,
  }
}

/** Publish runs since prepare last wrote a context, this one included. */
function attemptsSince(log: string): number {
  const lines = log.split('\n').filter(l => l !== '')
  const lastPrepared = lines.map(l => l.split(' ')[1] === 'prepared').lastIndexOf(true)
  return lines.length - (lastPrepared + 1)
}

async function recordAttempt(tourDir: string, now: string, result: TourValidationReport): Promise<number> {
  const file = path.join(tourDir, 'tour.log')
  const attempts = attemptsSince((await readText(file)) ?? '') + 1
  const codes = result.errors.map(e => e.code).join(',')
  const line = result.ok
    ? `${now} published attempts=${attempts}`
    : `${now} invalid attempts=${attempts} errors=${result.errors.length}${codes === '' ? '' : ` ${codes}`}`
  await appendFile(file, `${line}\n`, 'utf8')
  return attempts
}

/**
 * The record a regenerated tour keeps: who toured the earlier tour of the same commit, and the
 * author's picks whose decision key survived. A pick on a decision that is gone goes with it.
 */
export function carriedRecord(previous: TourArtifact | null, model: TourModel): TourRecord {
  if (previous === null) return { touredBy: [] }
  const keys = new Set(model.decisions.map(d => d.key))
  const record: TourRecord = { touredBy: previous.record.touredBy }
  const author = previous.record.author
  if (author !== undefined) {
    record.author = {
      ...author,
      picks: Object.fromEntries(Object.entries(author.picks).filter(([key]) => keys.has(key))),
    }
  }
  return record
}

export async function publishTour(
  ctx: AppContext,
  tourDir: string,
  opts: TourPublishOptions
): Promise<TourPublishResult> {
  const context = await readTourContext(tourDir)
  const storedDir = ctx.tours.tourDir(context.headSha)
  if (path.resolve(tourDir) !== storedDir) {
    throw new PublishError(
      'CANVAS_ELSEWHERE',
      `${tourDir} is not the tour dir of ${context.headSha.slice(0, 7)} in ${ctx.config.dataDir}; publishing would write ${storedDir}`,
      'publish the tourDir prepare printed, with the --data-dir prepare used or none'
    )
  }
  if (!opts.allowStale) {
    const head = await currentHead(ctx, context)
    if (head.moved) {
      throw new PublishError(
        'CANVAS_STALE',
        `the target moved to ${head.headSha.slice(0, 7)} while this tour was prepared for ${context.headSha.slice(0, 7)}`,
        'run `pr-review tour prepare` again, or pass --allow-stale to publish for the old commit'
      )
    }
  }
  const model = await readTourModel(context)
  const result =
    'error' in model
      ? {
          ok: false,
          errors: [{ code: 'SCHEMA' as const, where: '(root)', message: model.error.message }],
          output: null,
        }
      : validateTourModel(model.raw, await tourValidationInput(ctx, context, model.raw))
  const now = ctx.now().toISOString()
  const attempts = await recordAttempt(tourDir, now, result)
  if (!result.ok || result.output === null)
    throw new TourInvalidError({ ok: false, errors: result.errors }, attempts)
  const generator: Generator = { agent: opts.agent, harness: opts.harness, attempts }
  if (opts.model !== undefined) generator.model = opts.model
  const previous = await ctx.tours.read(context.headSha).catch(() => null)
  const artifact: TourArtifact = {
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
    generatedAt: now,
    generator,
    source: 'local',
    record: carriedRecord(previous, result.output),
  }
  const worktree = context.target.kind === 'local' && context.pr.state === UNCOMMITTED_STATE
  await ctx.tours.write(context.headSha, artifact, { worktree })
  if (worktree) await ctx.git.anchorCommit(context.headSha)
  const published: TourPublishResult = {
    status: 'published',
    headSha: context.headSha,
    tourJsonPath: path.join(storedDir, 'tour.json'),
    attempts,
    sharing: { status: 'local' },
  }
  if (context.target.kind === 'local') {
    published.tourUrl = `http://localhost:${ctx.config.port}/tour/${context.target.source}`
  }
  if (context.target.kind === 'pr') {
    published.tourUrl = `http://localhost:${ctx.config.port}/tour/${context.target.number}`
    published.sharing = await shareTourOnPr(ctx, context.headSha, context.target.number)
  }
  return published
}
