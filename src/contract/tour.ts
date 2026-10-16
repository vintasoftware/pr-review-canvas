// The tour: what the generator writes, what the store keeps, and what `tour prepare` records for
// `tour publish` to validate against. The words are CONTEXT.md's: landmark, scene, micro-world,
// decision, quiz, not toured, blast radius, guide.
import { z } from 'zod'
import { GeneratorSchema, PrSchema, RepoSchema, FileEntrySchema, type FileEntry } from './review-artifact.js'
import { FileDeltaSchema, PrepareTargetSchema } from './generation-context.js'
import { HighRiskRuleSchema } from '../project-config.js'

/**
 * A landmark's place in the tour: the background, then what the change means to the world, why
 * each part is the way it is, and what a later change must respect.
 */
export const TOUR_STAGES = ['background', 'world', 'why', 'respect'] as const
export type TourStage = (typeof TOUR_STAGES)[number]

/** The six decision categories of the design. A project may turn some off (`tour.categories`). */
export const DECISION_CATEGORIES = [
  'trade-off',
  'architecture',
  'product',
  'pokayoke',
  'nfr',
  'spec',
] as const
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number]

/** The two sides a decision offers: what the code does, and the tour's alternative. */
export const PICKS = ['keep', 'change'] as const
export type TourPick = (typeof PICKS)[number]
/** A reader's answer: one of the two sides, or something else they describe in a grilling. */
export const READER_PICKS = [...PICKS, 'other'] as const
export type ReaderPickKind = (typeof READER_PICKS)[number]

/** Visible-character caps on the generator's prose. Numbers, so the prompt can print them. */
export const TOUR_CAPS = {
  landmarkTitle: 60,
  lead: 140,
  /** One paragraph of a landmark's body, or of a literate diff: about 90 words. */
  paragraph: 600,
  decisionTitle: 70,
  context: 300,
  sideLabel: 60,
  consequence: 300,
  question: 200,
  option: 140,
  why: 200,
  tryItLine: 200,
  notToured: 90,
  overBudget: 200,
} as const
export type TourCaps = { -readonly [K in keyof typeof TOUR_CAPS]: number }

export const TOUR_LIMITS = {
  /** Characters of one scene or micro-world, HTML with its styles and scripts. */
  sceneChars: 12_000,
  /** Characters of one code chunk's diff. */
  diffChars: 6_000,
  codePerLandmark: 3,
  /** Paragraphs and embedded chunks of a literate diff: up to three chunks, a few snippets, and the prose between them. */
  literateBlocks: 12,
  /** Paragraphs a stored landmark may hold; tours written before the two-paragraph rule had three. */
  bodyParagraphs: 3,
  /** Paragraphs a new landmark's body may have: the picture carries the rest. */
  bodyParagraphsWritten: 2,
  quizOptions: 3,
  tryItSteps: 8,
  tryItLook: 6,
  notToured: 12,
  /** Files one not-toured entry may group under its reason. */
  notTouredPaths: 20,
  /** Micro-worlds in one tour: each is a model the reader plays with, and each costs a reader's time. */
  microWorlds: 2,
  /** Scenes of one tour that may draw the same technique: a third is the same picture dealt again. */
  sceneTechniqueRepeats: 2,
  /** A tour needs a background, a world, and a respect landmark at the least. */
  minLandmarks: 3,
} as const
export type TourLimits = { -readonly [K in keyof typeof TOUR_LIMITS]: number }

/**
 * How much tour this change gets. Background, world, and respect are one landmark each, so only the
 * why landmarks are budgeted: `why` from the size of the change, one more when the model says why
 * (`overBudget`), never over `whyMax`. Decisions and quiz questions follow the landmarks written,
 * never over their own ceilings. `prepare` computes it from the diff, the blast radius, and the
 * project's `tour.budget`, and records it in the context, so the validator holds the generator to
 * the same numbers the prompt stated.
 */
const TourBudgetShape = z.object({
  why: z.number().int().positive(),
  whyMax: z.number().int().positive(),
  decisions: z.number().int().nonnegative(),
  quiz: z.number().int().nonnegative(),
})
/** Tours prepared before the why budget recorded ceilings on all landmarks; three of them were fixed. */
export const TourBudgetSchema = z.preprocess(v => {
  if (v === null || typeof v !== 'object' || !('landmarks' in v) || 'why' in v) return v
  const { landmarks, ...rest } = v as { landmarks: number }
  const why = Math.max(1, landmarks - TOUR_LIMITS.minLandmarks)
  return { ...rest, why, whyMax: why }
}, TourBudgetShape)
export type TourBudget = z.infer<typeof TourBudgetShape>

/** The decisions and quiz questions a tour may have, given the landmarks it has, state aside. */
export function budgetLimits(
  budget: TourBudget,
  landmarks: number,
  whys: number
): { decisions: number; quiz: number } {
  return {
    decisions: Math.min(budget.decisions, whys + 1),
    quiz: Math.min(budget.quiz, Math.max(2, landmarks - 1)),
  }
}

/** The raw-text ceiling behind a cap: four times the cap, as the canvas does it. */
export const TOUR_HARD_CAP_FACTOR = 4

function mapCaps(fn: (key: keyof TourCaps) => number): TourCaps {
  const out = {} as TourCaps
  for (const key of Object.keys(TOUR_CAPS) as Array<keyof TourCaps>) out[key] = fn(key)
  return out
}
export function effectiveTourCaps(overrides?: Partial<TourCaps> | undefined): TourCaps {
  return mapCaps(key => overrides?.[key] ?? TOUR_CAPS[key])
}
export function hardTourCaps(caps: TourCaps): TourCaps {
  return mapCaps(key => caps[key] * TOUR_HARD_CAP_FACTOR)
}
export const TOUR_ARTIFACT_HARD_CAPS = hardTourCaps(TOUR_CAPS)

const slug = () =>
  z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/)

function text(caps: TourCaps, key: keyof TourCaps): z.ZodString {
  const visible = caps[key] / TOUR_HARD_CAP_FACTOR
  return z
    .string()
    .min(1)
    .max(caps[key])
    .meta({
      description: `At most ${visible} visible characters. Backticks and link targets do not count; maxLength is the raw ceiling.`,
      'x-visibleMaxLength': visible,
    })
}

/** A chunk of the diff behind a landmark: one file, one unified-diff excerpt with its `@@` header. */
export function codeChunkSchema() {
  return z.object({
    path: z.string().min(1),
    diff: z
      .string()
      .min(1)
      .max(TOUR_LIMITS.diffChars)
      .meta({ description: 'A unified diff excerpt starting with its @@ header, as the patch has it.' }),
  })
}

/**
 * A literate diff block: a paragraph, one of the landmark's chunks by index, or a snippet the raw
 * view does not carry.
 */
export function literateBlockSchema(caps: TourCaps) {
  return z.union([
    text(caps, 'paragraph'),
    z.object({ chunk: z.number().int().nonnegative() }),
    codeChunkSchema(),
  ])
}

export function landmarkSchema(caps: TourCaps) {
  return z.object({
    id: slug(),
    stage: z.enum(TOUR_STAGES),
    title: text(caps, 'landmarkTitle'),
    lead: text(caps, 'lead'),
    body: z.array(text(caps, 'paragraph')).min(1).max(TOUR_LIMITS.bodyParagraphs),
    /**
     * The state landmark: a schema, a migration, or the shape of stored data. Never cut by the
     * budget; it carries a reversibility decision when undoing the change is not clean.
     */
    state: z.boolean().optional(),
    /** The scene, an HTML fragment for the sandboxed frame; read from `<scenes>/<id>.scene.html` when absent. */
    scene: z.string().max(TOUR_LIMITS.sceneChars).optional(),
    /** The micro-world, same form, from `<scenes>/<id>.micro.html`; at most two landmarks have one. */
    micro: z.string().max(TOUR_LIMITS.sceneChars).optional(),
    code: z.array(codeChunkSchema()).max(TOUR_LIMITS.codePerLandmark).default([]),
    literate: z.array(literateBlockSchema(caps)).max(TOUR_LIMITS.literateBlocks).default([]),
  })
}

export function decisionSideSchema(caps: TourCaps) {
  return z.object({ label: text(caps, 'sideLabel'), consequence: text(caps, 'consequence') })
}

export function tryItSchema(caps: TourCaps) {
  return z.object({
    steps: z.array(text(caps, 'tryItLine')).min(1).max(TOUR_LIMITS.tryItSteps),
    look: z.array(text(caps, 'tryItLine')).min(1).max(TOUR_LIMITS.tryItLook),
    /** True once the generation skill ran the steps and saw what `look` describes. */
    verified: z.boolean(),
  })
}

export function decisionSchema(caps: TourCaps) {
  return z.object({
    /** A stable slug: picks carry across regenerations by it. */
    key: slug(),
    category: z.enum(DECISION_CATEGORIES),
    /** The why (or respect) landmark the decision is anchored on. */
    landmark: slug(),
    title: text(caps, 'decisionTitle'),
    context: text(caps, 'context'),
    keep: decisionSideSchema(caps),
    change: decisionSideSchema(caps),
    recommended: z.enum(PICKS),
    /** A line of the diff, on the new side, the decision points at. */
    anchor: z.object({ path: z.string().min(1), line: z.number().int().positive() }),
    tryIt: tryItSchema(caps).optional(),
  })
}

export function quizQuestionSchema(caps: TourCaps) {
  return z.object({
    id: slug(),
    /** The landmark a wrong answer reopens. */
    landmark: slug(),
    question: text(caps, 'question'),
    options: z.array(text(caps, 'option')).length(TOUR_LIMITS.quizOptions),
    answer: z
      .number()
      .int()
      .min(0)
      .max(TOUR_LIMITS.quizOptions - 1),
    why: text(caps, 'why'),
  })
}

/** What the budget left out: one reason, and the files of the diff it covers. */
export function notTouredSchema(caps: TourCaps) {
  return z.object({
    title: text(caps, 'notToured'),
    paths: z.array(z.string().min(1)).min(1).max(TOUR_LIMITS.notTouredPaths),
  })
}

/** A stored entry: tours written before entries grouped files name one `path`. */
const storedNotTouredSchema = z.preprocess(
  v =>
    v !== null && typeof v === 'object' && 'path' in v && !('paths' in v)
      ? { title: (v as { title?: unknown }).title, paths: [(v as { path: unknown }).path] }
      : v,
  notTouredSchema(TOUR_ARTIFACT_HARD_CAPS)
)

/** What the generator writes to `tour-model.json`. The validator checks the rest. */
export function tourModelSchema(visibleCaps: TourCaps) {
  const caps = hardTourCaps(visibleCaps)
  return z.object({
    landmarks: z.array(landmarkSchema(caps)).min(TOUR_LIMITS.minLandmarks),
    /** Why the tour needs one why landmark over the budget; validation asks for it then. */
    overBudget: text(caps, 'overBudget').optional(),
    decisions: z.array(decisionSchema(caps)),
    quiz: z.array(quizQuestionSchema(caps)),
    notToured: z.array(notTouredSchema(caps)).max(TOUR_LIMITS.notToured).default([]),
  })
}
export const TourModelSchema = tourModelSchema(TOUR_CAPS)
export type TourModel = z.infer<typeof TourModelSchema>
export type Landmark = TourModel['landmarks'][number]
export type Decision = TourModel['decisions'][number]
export type QuizQuestion = TourModel['quiz'][number]
export type CodeChunk = z.infer<ReturnType<typeof codeChunkSchema>>

/** One reader who finished the tour: the shared record lists them, and nothing of their quiz. */
export const TouredBySchema = z.object({ login: z.string().min(1), at: z.string() })
export type TouredBy = z.infer<typeof TouredBySchema>

/** The author's answer to a decision, as the shared record keeps it. */
export const AuthorPickSchema = z.object({
  pick: z.enum(READER_PICKS),
  /** For something else: the approved restatement, what changes and what stays the same. */
  restatement: z
    .object({ what: z.string().min(1), where: z.array(z.string().min(1)), unchanged: z.string().min(1) })
    .optional(),
})
export type AuthorPick = z.infer<typeof AuthorPickSchema>

/**
 * What the tour shares beyond its generated content: who finished it, and the author's picks with
 * their plan, so the re-implementation prompt can be rebuilt anywhere the tour is read.
 */
export const TourRecordSchema = z.object({
  touredBy: z.array(TouredBySchema),
  author: z
    .object({
      finishedAt: z.string(),
      picks: z.record(z.string(), AuthorPickSchema),
      /** The re-implementation prompt as written at finish. */
      prompt: z.string(),
    })
    .optional(),
})
export type TourRecord = z.infer<typeof TourRecordSchema>

/** The stored tour: `tour.json`. Read back under the generous hard ceilings, as a canvas is. */
export const TourArtifactSchema = z.object({
  version: z.literal(1),
  pr: PrSchema,
  repo: RepoSchema,
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The high-risk labels the change touches, from the project's `highRisk` patterns. */
  blastRadius: z.array(z.string()),
  budget: TourBudgetSchema,
  /** The guide the tour was generated with, relative to the repository, or null without one. */
  guide: z.string().nullable(),
  landmarks: z.array(landmarkSchema(TOUR_ARTIFACT_HARD_CAPS)),
  decisions: z.array(decisionSchema(TOUR_ARTIFACT_HARD_CAPS)),
  quiz: z.array(quizQuestionSchema(TOUR_ARTIFACT_HARD_CAPS)),
  notToured: z.array(storedNotTouredSchema),
  generatedAt: z.string(),
  generator: GeneratorSchema,
  source: z.enum(['local', 'import']),
  importedAt: z.string().optional(),
  record: TourRecordSchema,
  /** When the record last changed after generation. */
  revisedAt: z.string().optional(),
})
export type TourArtifact = z.infer<typeof TourArtifactSchema>

/** The tour's own options, as the prompt and the validator read them from the context. */
export const TourOptionsSchema = z.object({
  microWorld: z.boolean(),
  tryIt: z.boolean(),
  finalQuiz: z.enum(['on', 'off', 'required']),
})

/**
 * `context.json` of a tour: everything the generator and `tour publish` need. Written by
 * `tour prepare`, so a config change between the two commands does not change the rules.
 */
export const TourBasisSchema = z.object({
  tourSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** The earlier tour as a model, the form `<model>` takes. */
  modelPath: z.string().min(1),
  /** Its scene and micro-world files, named as `<scenes>` names them. */
  scenesDir: z.string().min(1),
  files: FileDeltaSchema,
})
export type TourBasis = z.infer<typeof TourBasisSchema>

export const TourContextSchema = z.object({
  version: z.literal(1),
  target: PrepareTargetSchema,
  repo: RepoSchema,
  pr: PrSchema,
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  tourDir: z.string().min(1),
  /** Where the generator writes `<id>.scene.html` and `<id>.micro.html`. */
  scenesDir: z.string().min(1),
  /** Absolute paths: the head files, the merge-base files, one labeled patch per file, the model. */
  paths: z.object({ head: z.string(), base: z.string(), patches: z.string(), model: z.string() }),
  files: z.array(FileEntrySchema),
  highRisk: z.array(HighRiskRuleSchema),
  blastRadius: z.array(z.string()),
  budget: TourBudgetSchema,
  caps: z.object(
    Object.fromEntries(Object.keys(TOUR_CAPS).map(k => [k, z.number().int().positive()])) as Record<
      keyof TourCaps,
      z.ZodNumber
    >
  ),
  /** The decision categories this project keeps. */
  categories: z.array(z.enum(DECISION_CATEGORIES)),
  tests: z.object({ patterns: z.array(z.string().min(1)) }),
  /** The committed guide, when the project has one. */
  guide: z.object({ path: z.string().nullable(), text: z.string().nullable() }),
  /** The change touches stored data, so a state landmark is required. */
  stateRequired: z.boolean(),
  options: TourOptionsSchema,
  maxRepairRounds: z.number().int().positive(),
  preparedAt: z.string(),
  /**
   * The tour of an ancestor commit this one updates, when there is one (`tour.incremental`): its
   * model and pictures copied into `basis/`, and how each file of the head's diff relates to its.
   */
  basis: TourBasisSchema.optional(),
})
export type TourContext = z.infer<typeof TourContextSchema>

export const TOUR_VALIDATION_CODES = [
  'SCHEMA',
  'TEXT_TOO_LONG',
  'MARKUP_IN_PLAIN_TEXT',
  'LANDMARK_ORDER',
  'LANDMARK_BUDGET',
  'DECISION_BUDGET',
  'QUIZ_BUDGET',
  'ID_DUPLICATE',
  'LANDMARK_UNKNOWN',
  'PATH_UNKNOWN',
  'ANCHOR_OUTSIDE_DIFF',
  'CHUNK_UNKNOWN',
  'PICTURE_MISSING',
  'SCENE_INVALID',
  'MICRO_INVALID',
  'MICRO_LIMIT',
  'SCENE_REPEATED',
  'CATEGORY_OFF',
  'STATE_LANDMARK_MISSING',
  'TRY_IT_UNVERIFIED',
] as const
export type TourValidationCode = (typeof TOUR_VALIDATION_CODES)[number]

export interface TourValidationError {
  code: TourValidationCode
  message: string
  where?: string
}

export interface TourValidationReport {
  ok: boolean
  errors: TourValidationError[]
}

/** The line a human reads: the code, then the message. */
export function formatTourError(error: TourValidationError): string {
  return `${error.code} ${error.message}`
}

/** The high-risk labels the changed paths touch, in the order the config lists them. */
export function blastRadiusOf(
  files: ReadonlyArray<Pick<FileEntry, 'path'>>,
  rules: ReadonlyArray<{ pattern: string; label: string }>,
  matches: (pattern: string, filePath: string) => boolean
): string[] {
  const labels: string[] = []
  for (const rule of rules) {
    if (!labels.includes(rule.label) && files.some(f => matches(rule.pattern, f.path)))
      labels.push(rule.label)
  }
  return labels
}

/** Words in a blast-radius label that say the change touches stored data. */
const STATE_WORDS = /schema|migration|database|storage|stored data/i

/**
 * The budget for one change: about one why landmark per `linesPerLandmark` changed lines, one more
 * when the blast radius is not empty, at least one, never over the project's ceiling.
 */
export function computeBudget(
  changedLines: number,
  blastRadius: readonly string[],
  ceilings: { whyLandmarks: number; decisions: number; quiz: number; linesPerLandmark: number }
): TourBudget {
  const risky = blastRadius.length > 0 ? 1 : 0
  const bySize = Math.ceil(changedLines / Math.max(1, ceilings.linesPerLandmark))
  return {
    why: Math.min(ceilings.whyLandmarks, Math.max(1, bySize + risky)),
    whyMax: ceilings.whyLandmarks,
    decisions: ceilings.decisions,
    quiz: ceilings.quiz,
  }
}

/**
 * Paths that hold the shape of stored data in most stacks: a migrations directory (Django, Rails,
 * Alembic, Knex, Prisma), an SQL file, or a schema file. A project with no `highRisk` patterns still
 * gets its state landmark when the change touches one of these.
 */
const STATE_PATHS = [
  /(^|\/)(migrations?|alembic|db\/migrate)\//i,
  /\.sql$/i,
  /(^|\/)schema\.(prisma|rb|graphql|sql)$/i,
]

/** The change touches stored data: a state-labelled blast radius, or a migration or schema file. */
export function stateRequiredFor(blastRadius: readonly string[], paths: readonly string[] = []): boolean {
  return (
    blastRadius.some(label => STATE_WORDS.test(label)) || paths.some(p => STATE_PATHS.some(re => re.test(p)))
  )
}
