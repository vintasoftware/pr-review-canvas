// `pr-review tour prepare`: fetch the target, build derived/, compute the budget and the blast
// radius, and write prompt.md + context.json into the tour directory. The generation skill reads
// those two files and writes the model and the scenes; `tour publish` reads context.json back.
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { PrepareTargetInput } from '../contract/generation-context.js'
import type { LocalKey } from '../contract/review-key.js'
import type { Pr } from '../contract/review-artifact.js'
import { resolveTourSharing } from '../contract/settings.js'
import {
  blastRadiusOf,
  computeBudget,
  effectiveTourCaps,
  stateRequiredFor,
  type TourContext,
} from '../contract/tour.js'
import { UNCOMMITTED_STATE } from '../git/local-target.js'
import { loadPromptFile } from '../prompt-files.js'
import { PACKAGE_ROOT } from '../paths.js'
import type { GenerationModels } from '../project-config.js'
import { matchesGlob } from '../review/glob.js'
import { resolveTargetPr } from '../review/prepare.js'
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
  const derived = await ctx.derived.ensure(pr.headSha, pr.mergeBaseSha)
  const additions = derived.files.reduce((n, f) => n + f.additions, 0)
  const deletions = derived.files.reduce((n, f) => n + f.deletions, 0)
  const blastRadius = blastRadiusOf(derived.files, config.highRisk, matchesGlob)
  const budget = computeBudget(additions + deletions, blastRadius, config.tour.budget)
  if (!opts.force && (await ctx.tours.exists(pr.headSha))) {
    return { ...result, status: 'exists', blastRadius, budget }
  }

  opts.log('prompt')
  const fullPr: Pr =
    target.kind === 'pr' ? pr : { ...pr, additions, deletions, changedFiles: derived.files.length }
  const derivedDir = ctx.derived.derivedDir(pr.headSha)
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
    stateRequired: stateRequiredFor(blastRadius),
    options: { microWorld: config.tour.microWorld === 'on', tryIt, finalQuiz: config.tour.finalQuiz },
    maxRepairRounds: config.generation.maxRepairRounds,
    preparedAt: ctx.now().toISOString(),
  }
  await clearTourDir(tourDir)
  await mkdir(scenesDir, { recursive: true })
  const template =
    opts.template ??
    (await loadPromptFile('tour.md', undefined, { repoRoot: ctx.config.repoRoot, overrides: config.prompts }))
  await writeTextAtomic(
    result.promptPath,
    renderTourPrompt(context, derived.patches, template, { sceneGuidePath: SCENE_GUIDE_PATH })
  )
  await writeJsonAtomic(result.contextPath, context)
  await appendFile(path.join(tourDir, 'tour.log'), `${context.preparedAt} prepared ${pr.headSha}\n`, 'utf8')
  return { ...result, status: 'prepared', blastRadius, budget }
}
