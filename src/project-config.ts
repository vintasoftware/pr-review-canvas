import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { TextCaps } from './contract/review-artifact.js'
import { DEFAULT_TEST_PATTERNS } from './review/test-paths.js'
import { readText } from './store/atomic-json.js'

export const PROJECT_CONFIG_FILE = 'pr-review.config.yml'
export const GenerationModeSchema = z.enum(['strict', 'surfacing'])
export type GenerationMode = z.infer<typeof GenerationModeSchema>

export const DefaultLayerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  paths: z.array(z.string()).optional(),
})
export type DefaultLayer = z.infer<typeof DefaultLayerSchema>

export const GenerationModelsSchema = z.record(z.string().min(1), z.string().min(1))
export type GenerationModels = z.infer<typeof GenerationModelsSchema>

export const HighRiskRuleSchema = z.object({ pattern: z.string().min(1), label: z.string().min(1) })
export type HighRiskRule = z.infer<typeof HighRiskRuleSchema>

export const SharingSchema = z.object({
  /** Publish posts the canvas as a PR/MR comment. False keeps the canvas on this machine. */
  canvasComment: z.boolean(),
  /** What the review page posts names the canvas. False drops every mention and credit. */
  mentionCanvas: z.boolean(),
})
export type Sharing = z.infer<typeof SharingSchema>

const cap = () => z.number().int().positive().optional()

/** One optional override per text cap. `satisfies` fails the build when TEXT_CAPS gains a key. */
const capsShape = {
  summary: cap(),
  layerTitle: cap(),
  rationale: cap(),
  decisions: cap(),
  checkByHand: cap(),
  annotation: cap(),
  pointTitle: cap(),
  pointBody: cap(),
  testBehavior: cap(),
  diagram: cap(),
} satisfies Record<keyof TextCaps, z.ZodOptional<z.ZodNumber>>

export const PromptOverridesSchema = z
  .object({
    'generation-format.md': z.string().min(1).optional(),
    'generation-strict.md': z.string().min(1).optional(),
    'generation-surfacing.md': z.string().min(1).optional(),
    'generation-strict-incremental.md': z.string().min(1).optional(),
    'generation-surfacing-incremental.md': z.string().min(1).optional(),
    'judging-strict.md': z.string().min(1).optional(),
    'judging-surfacing.md': z.string().min(1).optional(),
    'quality-standards.md': z.string().min(1).optional(),
    'layering-guidance.md': z.string().min(1).optional(),
    'chat-seed.md': z.string().min(1).optional(),
    'tour.md': z.string().min(1).optional(),
    'tour-grill.md': z.string().min(1).optional(),
  })
  .strict()
export type PromptOverrides = z.infer<typeof PromptOverridesSchema>

export const TOUR_CATEGORIES = ['trade-off', 'architecture', 'product', 'pokayoke', 'nfr', 'spec'] as const
const OnOff = z.enum(['on', 'off'])

/** The tour's settings, under `tour:`. The defaults are the design's. */
export const TourConfigSchema = z.object({
  budget: z.object({
    /** Ceilings: at most this many landmarks, decisions, and quiz questions. */
    landmarks: z.number().int().positive(),
    decisions: z.number().int().positive(),
    quiz: z.number().int().positive(),
    /** About one landmark per this many changed lines, on top of the three every tour has. */
    linesPerLandmark: z.number().int().positive(),
  }),
  finalQuiz: z.enum(['on', 'off', 'required']),
  reverseQuiz: OnOff,
  grill: z.enum(['change', 'always', 'off']),
  audio: OnOff,
  microWorld: OnOff,
  /** `auto`: on when the guide has a run recipe. */
  tryIt: z.enum(['on', 'off', 'auto']),
  categories: z.array(z.enum(TOUR_CATEGORIES)),
  /** `auto`: the same as canvas sharing. */
  share: z.enum(['on', 'off', 'auto']),
  /** The model each agent generates tours with; falls back to `generation.models`. */
  models: GenerationModelsSchema,
  /** The committed guide, relative to the repository root. */
  guide: z.string().min(1),
})
export type TourConfig = z.infer<typeof TourConfigSchema>

const PartialTourConfigSchema = z.object({
  budget: z
    .object({
      landmarks: z.number().int().positive().optional(),
      decisions: z.number().int().positive().optional(),
      quiz: z.number().int().positive().optional(),
      linesPerLandmark: z.number().int().positive().optional(),
    })
    .optional(),
  finalQuiz: z.enum(['on', 'off', 'required']).optional(),
  reverseQuiz: OnOff.optional(),
  grill: z.enum(['change', 'always', 'off']).optional(),
  audio: OnOff.optional(),
  microWorld: OnOff.optional(),
  tryIt: z.enum(['on', 'off', 'auto']).optional(),
  categories: z.array(z.enum(TOUR_CATEGORIES)).optional(),
  share: z.enum(['on', 'off', 'auto']).optional(),
  models: GenerationModelsSchema.optional(),
  guide: z.string().min(1).optional(),
})

export const DEFAULT_TOUR_CONFIG: TourConfig = {
  budget: { landmarks: 8, decisions: 5, quiz: 5, linesPerLandmark: 150 },
  finalQuiz: 'on',
  reverseQuiz: 'on',
  grill: 'change',
  audio: 'on',
  microWorld: 'on',
  tryIt: 'auto',
  categories: [...TOUR_CATEGORIES],
  share: 'auto',
  models: {},
  guide: 'docs/pr-tour.md',
}

export const ProjectConfigSchema = z.object({
  version: z.literal(1),
  rulebook: z.string().min(1).optional(),
  prompts: PromptOverridesSchema.optional(),
  layers: z.array(DefaultLayerSchema),
  highRisk: z.array(HighRiskRuleSchema),
  generation: z.object({
    mode: GenerationModeSchema.default('strict'),
    maxRepairRounds: z.number().int().positive(),
    inlineDiffMaxLines: z.number().int().positive(),
    /** A change set with at most this many hunks is "small": one layer unless concerns differ. */
    smallPrHunks: z.number().int().positive(),
    caps: z.object(capsShape).optional(),
    /**
     * The model each agent generates canvases with, keyed by the agent id publish records
     * (`claude`, `codex`, ...). Claude defaults to Opus; an agent with no entry keeps the
     * session's model.
     */
    models: GenerationModelsSchema,
  }),
  /** Which paths count as tests, for the layering rules and the `isTest` flag on a file. */
  tests: z.object({ patterns: z.array(z.string().min(1)) }),
  chat: z.object({ enabled: z.boolean() }),
  canvas: z.object({
    /**
     * A canvas still stands for a later head whose diff is identical to the one it was generated
     * from, as after merging the base branch in. False marks the canvas outdated on any commit.
     */
    keepForIdenticalDiff: z.boolean(),
    /**
     * Regenerating a canvas for a new head starts from the newest canvas of a commit the head was
     * built on, carrying what the head's diff leaves untouched. False generates every canvas from
     * a blank page, as `--force` always does.
     */
    incremental: z.boolean(),
  }),
  /** What publish and the review page put on the PR/MR. `.pr-review/settings.yml` can override both. */
  sharing: SharingSchema,
  tour: TourConfigSchema,
})
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/** The shape a user may write: everything optional, filled from the defaults. */
const PartialProjectConfigSchema = z.object({
  version: z.literal(1).optional(),
  rulebook: z.string().min(1).optional(),
  prompts: PromptOverridesSchema.optional(),
  layers: z.array(DefaultLayerSchema).optional(),
  highRisk: z.array(HighRiskRuleSchema).optional(),
  generation: z
    .object({
      mode: GenerationModeSchema.optional(),
      maxRepairRounds: z.number().int().positive().optional(),
      inlineDiffMaxLines: z.number().int().positive().optional(),
      smallPrHunks: z.number().int().positive().optional(),
      caps: z.object(capsShape).optional(),
      models: GenerationModelsSchema.optional(),
    })
    .optional(),
  tests: z.object({ patterns: z.array(z.string().min(1)).optional() }).optional(),
  chat: z.object({ enabled: z.boolean().optional() }).optional(),
  canvas: z
    .object({ keepForIdenticalDiff: z.boolean().optional(), incremental: z.boolean().optional() })
    .optional(),
  sharing: z
    .object({ canvasComment: z.boolean().optional(), mentionCanvas: z.boolean().optional() })
    .optional(),
  tour: PartialTourConfigSchema.optional(),
})

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  layers: [],
  highRisk: [],
  generation: {
    mode: 'strict',
    maxRepairRounds: 3,
    inlineDiffMaxLines: 1500,
    smallPrHunks: 10,
    models: { claude: 'opus' },
  },
  tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
  chat: { enabled: true },
  canvas: { keepForIdenticalDiff: true, incremental: true },
  sharing: { canvasComment: true, mentionCanvas: true },
  tour: DEFAULT_TOUR_CONFIG,
}

export interface LoadedProjectConfig {
  config: ProjectConfig
  warnings: string[]
  /** Absolute path of the file that was read, or null when the defaults are in use. */
  source: string | null
}

function formatIssues(err: z.ZodError): string {
  return err.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/** Merges a parsed user file over the defaults. Exported for tests; `loadProjectConfig` reads the file. */
export function mergeProjectConfig(raw: unknown): { config: ProjectConfig; warnings: string[] } {
  const parsed = PartialProjectConfigSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [`${PROJECT_CONFIG_FILE} is invalid, using defaults: ${formatIssues(parsed.error)}`],
    }
  }
  const user = parsed.data
  const generation: ProjectConfig['generation'] = {
    mode: user.generation?.mode ?? DEFAULT_PROJECT_CONFIG.generation.mode,
    maxRepairRounds: user.generation?.maxRepairRounds ?? DEFAULT_PROJECT_CONFIG.generation.maxRepairRounds,
    inlineDiffMaxLines:
      user.generation?.inlineDiffMaxLines ?? DEFAULT_PROJECT_CONFIG.generation.inlineDiffMaxLines,
    smallPrHunks: user.generation?.smallPrHunks ?? DEFAULT_PROJECT_CONFIG.generation.smallPrHunks,
    // Per agent: a project that names only codex still generates with Opus on Claude.
    models: { ...DEFAULT_PROJECT_CONFIG.generation.models, ...user.generation?.models },
  }
  if (user.generation?.caps !== undefined) {
    generation.caps = user.generation.caps
  }
  const config: ProjectConfig = {
    version: 1,
    layers: user.layers ?? [],
    highRisk: user.highRisk ?? [],
    generation,
    tests: { patterns: user.tests?.patterns ?? [...DEFAULT_TEST_PATTERNS] },
    chat: { enabled: user.chat?.enabled ?? true },
    canvas: {
      keepForIdenticalDiff:
        user.canvas?.keepForIdenticalDiff ?? DEFAULT_PROJECT_CONFIG.canvas.keepForIdenticalDiff,
      incremental: user.canvas?.incremental ?? DEFAULT_PROJECT_CONFIG.canvas.incremental,
    },
    sharing: {
      canvasComment: user.sharing?.canvasComment ?? DEFAULT_PROJECT_CONFIG.sharing.canvasComment,
      mentionCanvas: user.sharing?.mentionCanvas ?? DEFAULT_PROJECT_CONFIG.sharing.mentionCanvas,
    },
    tour: {
      budget: {
        landmarks: user.tour?.budget?.landmarks ?? DEFAULT_TOUR_CONFIG.budget.landmarks,
        decisions: user.tour?.budget?.decisions ?? DEFAULT_TOUR_CONFIG.budget.decisions,
        quiz: user.tour?.budget?.quiz ?? DEFAULT_TOUR_CONFIG.budget.quiz,
        linesPerLandmark: user.tour?.budget?.linesPerLandmark ?? DEFAULT_TOUR_CONFIG.budget.linesPerLandmark,
      },
      finalQuiz: user.tour?.finalQuiz ?? DEFAULT_TOUR_CONFIG.finalQuiz,
      reverseQuiz: user.tour?.reverseQuiz ?? DEFAULT_TOUR_CONFIG.reverseQuiz,
      grill: user.tour?.grill ?? DEFAULT_TOUR_CONFIG.grill,
      audio: user.tour?.audio ?? DEFAULT_TOUR_CONFIG.audio,
      microWorld: user.tour?.microWorld ?? DEFAULT_TOUR_CONFIG.microWorld,
      tryIt: user.tour?.tryIt ?? DEFAULT_TOUR_CONFIG.tryIt,
      categories: user.tour?.categories ?? [...TOUR_CATEGORIES],
      share: user.tour?.share ?? DEFAULT_TOUR_CONFIG.share,
      models: { ...user.tour?.models },
      guide: user.tour?.guide ?? DEFAULT_TOUR_CONFIG.guide,
    },
  }
  if (user.rulebook !== undefined) {
    config.rulebook = user.rulebook
  }
  if (user.prompts !== undefined) {
    config.prompts = user.prompts
  }
  const warnings: string[] = []
  if (config.tests.patterns.length === 0) {
    warnings.push(`${PROJECT_CONFIG_FILE}: "tests.patterns" is empty, so no file counts as a test`)
  }
  const ids = new Set<string>()
  for (const layer of config.layers) {
    if (ids.has(layer.id)) {
      warnings.push(`${PROJECT_CONFIG_FILE}: duplicate layer id "${layer.id}"`)
    }
    ids.add(layer.id)
  }
  return { config, warnings }
}

export async function loadProjectConfig(repoRoot: string): Promise<LoadedProjectConfig> {
  const file = path.join(repoRoot, PROJECT_CONFIG_FILE)
  const text = await readText(file)
  if (text === null) {
    return { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null }
  }
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    return {
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [
        `${PROJECT_CONFIG_FILE} is not valid YAML, using defaults: ${err instanceof Error ? err.message : String(err)}`,
      ],
      source: file,
    }
  }
  const merged = mergeProjectConfig(raw ?? {})
  return { ...merged, source: file }
}
