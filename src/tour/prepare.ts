// `pr-review tour prepare`: fetch the target, build derived/, compute the budget and the blast
// radius, find the earlier tour this one updates, and write prompt.md + context.json into the tour
// directory. The generation skill reads
// those two files and writes the model and the scenes; `tour publish` reads context.json back.
import { appendFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrepareTarget, PrepareTargetInput } from '../contract/generation-context.js'
import type { Pr } from '../contract/review-artifact.js'
import type { LocalKey, ReviewKey } from '../contract/review-key.js'
import { resolveTourSharing } from '../contract/settings.js'
import {
  blastRadiusOf,
  computeBudget,
  effectiveTourCaps,
  stateRequiredFor,
  type TourArtifact,
  type TourBasis,
  type TourContext,
  type TourModel,
} from '../contract/tour.js'
import type { Derived } from '../store/derived-store.js'
import { fileDelta, findBasis } from '../review/incremental.js'
import { UNCOMMITTED_STATE } from '../git/local-target.js'
import { loadPromptFile } from '../prompt-files.js'
import { PACKAGE_ROOT } from '../paths.js'
import type { GenerationModels } from '../project-config.js'
import { matchesGlob } from '../review/glob.js'
import { completeTargetPr, resolveTargetPr } from '../review/prepare.js'
import type { AppContext } from '../server/context.js'
import { readText, writeJsonAtomic, writeTextAtomic } from '../store/atomic-json.js'
import { renderTourPrompt } from './prompt.js'

/** The scene guide the generator reads: the tour skill's, as the package ships it. */
export const SCENE_GUIDE_PATH = path.join(PACKAGE_ROOT, 'skills', 'pr-tour', 'scenes.md')

export interface TourPrepareOptions {
  force: boolean
  log: (phase: string) => void
  /** The prompt template, when a test supplies one instead of the bundled or overridden file. */
  template?: string
}

export interface TourPrepareResult {
  tourDir: string
  headSha: string
  mergeBaseSha: string
  promptPath: string
  contextPath: string
  scenesDir: string
  sceneGuidePath: string
  status: 'prepared' | 'exists'
  sharing: 'shared' | 'off'
  models: GenerationModels
  blastRadius: string[]
  budget: TourContext['budget']
  /** The guide's path when the project has one; null says to run `/pr-tour-setup`. */
  guide: string | null
  /** The earlier tour this one updates, when there is one: its model and its pictures. */
  basis?: { tourSha: string; modelPath: string; scenesDir: string }
  local?: { review: LocalKey; base: string; headRef: string; uncommitted: boolean }
}

/** What an earlier run left behind goes; the published tour stays until publish replaces it. */
const KEPT_ON_PREPARE = new Set(['tour.json', 'tour.log'])

async function clearTourDir(tourDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(tourDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!KEPT_ON_PREPARE.has(name)) await rm(path.join(tourDir, name), { recursive: true, force: true })
  }
}

/** The review a target's tours are filed under; a ref comparison has none, so it has no basis. */
function ownerOf(target: PrepareTarget): ReviewKey | null {
  return target.kind === 'pr' ? target.number : target.kind === 'local' ? target.source : null
}

/** A stored tour as the model the generator writes: its pictures go to their own files. */
export function tourModelOf(artifact: TourArtifact): TourModel {
  return {
    landmarks: artifact.landmarks.map(({ scene: _scene, micro: _micro, ...rest }) => rest),
    decisions: artifact.decisions,
    quiz: artifact.quiz,
    notToured: artifact.notToured,
  }
}

/**
 * The tour this one updates: the newest tour of the same review whose head is an ancestor of this
 * one, copied into `<tourDir>/basis/` as a model and its picture files. Null when the tour is written
 * from a blank page: `--force`, `tour.incremental: false`, a ref comparison, no such tour, or one
 * whose diff this clone can no longer read.
 */
async function resolveTourBasis(
  ctx: AppContext,
  target: PrepareTarget,
  pr: Pr,
  head: Derived,
  tourDir: string
): Promise<TourBasis | null> {
  const owner = ownerOf(target)
  if (owner === null) return null
  const sha = await findBasis(ctx.git, pr.headSha, (await ctx.tours.readIndex()).tours, entry =>
    ctx.tours.belongsTo(entry, owner)
  )
  if (sha === null) return null
  const artifact = await ctx.tours.read(sha)
  if (artifact === null) return null
  const basis = await ctx.derived.readOrBuild({ headSha: sha, mergeBaseSha: artifact.mergeBaseSha })
  if (basis === null) return null
  const dir = path.join(tourDir, 'basis')
  const scenesDir = path.join(dir, 'scenes')
  await mkdir(scenesDir, { recursive: true })
  const modelPath = path.join(dir, 'tour-model.json')
  await writeJsonAtomic(modelPath, tourModelOf(artifact))
  for (const l of artifact.landmarks) {
    if (l.scene !== undefined) await writeFile(path.join(scenesDir, `${l.id}.scene.html`), l.scene)
    if (l.micro !== undefined) await writeFile(path.join(scenesDir, `${l.id}.micro.html`), l.micro)
  }
  return { tourSha: sha, modelPath, scenesDir, files: fileDelta(basis, head) }
}

/** A guide has a run recipe when it says how to run the app under a heading that names it. */
export function guideHasRunRecipe(text: string | null): boolean {
  return text !== null && /^#+\s.*\b(run|start)\b/im.test(text) && /```/.test(text)
}

export async function prepareTour(
  ctx: AppContext,
  input: PrepareTargetInput,
  opts: TourPrepareOptions
): Promise<TourPrepareResult> {
  const { target, pr } = await resolveTargetPr(ctx, input, opts.log)
  const config = ctx.projectConfig.config
  const tourDir = ctx.tours.tourDir(pr.headSha)
  const scenesDir = ctx.tours.scenesDir(pr.headSha)
  const guidePath = config.tour.guide
  const guideText = await readText(path.resolve(ctx.config.repoRoot, guidePath))
  const result: Omit<TourPrepareResult, 'status' | 'blastRadius' | 'budget'> = {
    tourDir,
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    promptPath: path.join(tourDir, 'prompt.md'),
    contextPath: path.join(tourDir, 'context.json'),
    scenesDir,
    sceneGuidePath: SCENE_GUIDE_PATH,
    models: { ...config.generation.models, ...config.tour.models },
    sharing:
      target.kind === 'pr' &&
      resolveTourSharing({ sharing: config.sharing, tourShare: config.tour.share }, await ctx.settings.read())
        ? 'shared'
        : 'off',
    guide: guideText === null ? null : guidePath,
  }
  if (target.kind === 'local') {
    result.local = {
      review: target.source,
      base: target.base,
      headRef: pr.headRef,
      uncommitted: pr.state === UNCOMMITTED_STATE,
    }
  }

  opts.log('collect-diffs')
  const derived = await ctx.derived.ensure(pr)
  const additions = derived.files.reduce((n, f) => n + f.additions, 0)
  const deletions = derived.files.reduce((n, f) => n + f.deletions, 0)
  const blastRadius = blastRadiusOf(derived.files, config.highRisk, matchesGlob)
  const budget = computeBudget(additions + deletions, blastRadius, config.tour.budget)
  if (!opts.force && (await ctx.tours.exists(pr.headSha))) {
    return { ...result, status: 'exists', blastRadius, budget }
  }

  opts.log('prompt')
  const fullPr = await completeTargetPr(ctx, target, pr, derived)
  const derivedDir = ctx.derived.derivedDir(pr)
  const tryIt = config.tour.tryIt === 'auto' ? guideHasRunRecipe(guideText) : config.tour.tryIt === 'on'
  const context: TourContext = {
    version: 1,
    target,
    repo: ctx.config.repo,
    pr: fullPr,
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    tourDir,
    scenesDir,
    paths: {
      head: path.join(derivedDir, 'head'),
      base: path.join(derivedDir, 'base'),
      patches: path.join(derivedDir, 'patches'),
      model: path.join(tourDir, 'tour-model.json'),
    },
    files: derived.files,
    highRisk: config.highRisk,
    blastRadius,
    budget,
    caps: effectiveTourCaps(),
    categories: config.tour.categories,
    tests: { patterns: config.tests.patterns },
    guide: { path: guideText === null ? null : guidePath, text: guideText },
    stateRequired: stateRequiredFor(
      blastRadius,
      derived.files.map(f => f.path)
    ),
    options: { microWorld: config.tour.microWorld === 'on', tryIt, finalQuiz: config.tour.finalQuiz },
    maxRepairRounds: config.generation.maxRepairRounds,
    preparedAt: ctx.now().toISOString(),
  }
  await clearTourDir(tourDir)
  await mkdir(scenesDir, { recursive: true })
  // `--force` means start over, so it never reads a basis, whatever the project config says.
  const basis =
    opts.force || !config.tour.incremental ? null : await resolveTourBasis(ctx, target, pr, derived, tourDir)
  if (basis !== null) context.basis = basis
  const template =
    opts.template ??
    (await loadPromptFile('tour.md', undefined, { repoRoot: ctx.config.repoRoot, overrides: config.prompts }))
  await writeTextAtomic(
    result.promptPath,
    renderTourPrompt(context, derived.patches, template, { sceneGuidePath: SCENE_GUIDE_PATH })
  )
  await writeJsonAtomic(result.contextPath, context)
  await appendFile(path.join(tourDir, 'tour.log'), `${context.preparedAt} prepared ${pr.headSha}\n`, 'utf8')
  const prepared: TourPrepareResult = { ...result, status: 'prepared', blastRadius, budget }
  if (basis !== null) {
    prepared.basis = { tourSha: basis.tourSha, modelPath: basis.modelPath, scenesDir: basis.scenesDir }
  }
  return prepared
}
