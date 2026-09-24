import { z } from 'zod'
import { DefaultLayerSchema, GenerationModeSchema, HighRiskRuleSchema } from '../project-config.js'
import { DEFAULT_TEST_PATTERNS } from '../review/test-paths.js'
import { type LocalKey, LocalKeySchema } from './review-key.js'
import {
  FileEntrySchema,
  LIMITS,
  POINT_KINDS,
  PrSchema,
  RepoSchema,
  SideSchema,
  type TextCaps,
} from './review-artifact.js'

/**
 * What `prepare` was asked to describe: a pull request, two refs, or one of the two reviews of
 * work in this clone that has no pull request yet. A `local` target names only its base, because
 * its head is whatever the branch or the working tree holds when the command runs.
 */
export const LocalPrepareTargetSchema = z.object({
  kind: z.literal('local'),
  base: z.string().min(1),
  /** Which local review this is, which is also the key it is filed and served under. */
  source: LocalKeySchema,
})
export type LocalPrepareTarget = z.infer<typeof LocalPrepareTargetSchema>

export const PrepareTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), number: z.number().int().positive() }),
  z.object({ kind: z.literal('refs'), base: z.string().min(1), head: z.string().min(1) }),
  LocalPrepareTargetSchema,
])
export type PrepareTarget = z.infer<typeof PrepareTargetSchema>

/**
 * What the CLI parsed, before git has been asked anything. A local review's base may still be
 * open here: only the clone knows which branch `origin/HEAD` points at. `prepare` resolves it and
 * records the answer, so `publish` reads a base that cannot drift.
 */
export type PrepareTargetInput =
  | Extract<PrepareTarget, { kind: 'pr' } | { kind: 'refs' }>
  | { kind: 'local'; base?: string | undefined; source: LocalKey }

const capsShape = {
  summary: z.number().int().positive(),
  layerTitle: z.number().int().positive(),
  rationale: z.number().int().positive(),
  decisions: z.number().int().positive(),
  checkByHand: z.number().int().positive(),
  annotation: z.number().int().positive(),
  pointTitle: z.number().int().positive(),
  pointBody: z.number().int().positive(),
  testBehavior: z.number().int().positive(),
  diagram: z.number().int().positive(),
} satisfies Record<keyof TextCaps, z.ZodNumber>

/** Which files the head changes relative to the basis canvas's diff, by path. */
export const FileDeltaSchema = z.object({
  unchanged: z.array(z.string()),
  changed: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
})
export type FileDelta = z.infer<typeof FileDeltaSchema>

export const BasisSplitLayerSchema = z.object({
  key: z.string().min(1),
  title: z.string(),
  /** `carried` when the head touches none of the layer's files. */
  status: z.enum(['carried', 're-judged']),
  carriedFiles: z.array(z.string()),
  reJudgedFiles: z.array(z.string()),
})
export type BasisSplitLayer = z.infer<typeof BasisSplitLayerSchema>

/** Where a point's lines sit in the head, on the side the point is anchored to. */
export const BasisPointLinesSchema = z.object({
  side: SideSchema,
  line: z.number().int().positive(),
  endLine: z.number().int().positive(),
})
export type BasisPointLines = z.infer<typeof BasisPointLinesSchema>

export const BasisSplitPointSchema = z.object({
  kind: z.enum(POINT_KINDS),
  path: z.string().min(1),
  title: z.string(),
  status: z.enum(['carried', 're-judged']),
  /**
   * Set on a point carried from a changed file: its own lines are unchanged in text and in the
   * diff, and sit here in the head. A point of an untouched file keeps its lines and has none.
   */
  headLines: BasisPointLinesSchema.optional(),
})
export type BasisSplitPoint = z.infer<typeof BasisSplitPointSchema>

/**
 * The basis canvas of an incremental run, already divided into what the head leaves untouched and
 * what has to be decided anew. `prepare` computes it, so the generator reads two lists instead of
 * comparing diffs itself, and `publish` records `canvasSha` on the canvas it stores.
 */
export const BasisSplitSchema = z.object({
  canvasSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** Absolute path of the basis canvas's `review.json`, in the canvas store. */
  reviewJsonPath: z.string().min(1),
  files: FileDeltaSchema,
  layers: z.array(BasisSplitLayerSchema),
  points: z.array(BasisSplitPointSchema),
})
export type BasisSplit = z.infer<typeof BasisSplitSchema>

/**
 * `context.json`: everything the agent and `publish` need about one prepared canvas. Written by
 * `prepare` next to `prompt.md`; `publish` validates `model.json` against the hunk index and the
 * caps recorded here, so a config change between the two commands does not change the rules.
 */
export const GenerationContextSchema = z.object({
  version: z.literal(1),
  target: PrepareTargetSchema,
  repo: RepoSchema,
  pr: PrSchema,
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  canvasDir: z.string().min(1),
  /** Absolute paths: the PR head files, the merge-base files, and one labeled patch per file. */
  paths: z.object({ head: z.string(), base: z.string(), patches: z.string(), model: z.string() }),
  /** The manifest: every changed file with its hunk ids and headers. */
  files: z.array(FileEntrySchema),
  defaultLayers: z.array(DefaultLayerSchema),
  rulebook: z.object({ path: z.string().nullable(), text: z.string().nullable() }),
  highRisk: z.array(HighRiskRuleSchema),
  caps: z.object(capsShape),
  limits: z.object({
    maxPoints: z.number().int().positive(),
    maxDiagramsPerLayer: z.number().int().positive(),
    maxDiagramLinks: z.number().int().positive().default(LIMITS.maxDiagramLinks),
  }),
  generation: z.object({
    mode: GenerationModeSchema.default('strict'),
    maxRepairRounds: z.number().int().positive(),
    inlineDiffMaxLines: z.number().int().positive(),
    smallPrHunks: z.number().int().positive(),
  }),
  /** The globs that make a file a test here. Defaulted, so a context written before this
   * field existed still reads. */
  tests: z
    .object({ patterns: z.array(z.string().min(1)) })
    .default(() => ({ patterns: [...DEFAULT_TEST_PATTERNS] })),
  /** At most `generation.smallPrHunks` hunks: one layer unless concerns differ, fewer annotations. */
  smallPr: z.boolean(),
  /** More than 400 files or 50 000 changed lines: the prompt inlines nothing and tightens the caps. */
  largePr: z.boolean(),
  /** Absent when this canvas is generated from a blank page: no basis, `--force`, or turned off. */
  basis: BasisSplitSchema.optional(),
  preparedAt: z.string(),
})
export type GenerationContext = z.infer<typeof GenerationContextSchema>

export const LARGE_PR = { files: 400, lines: 50_000 } as const

/**
 * A change set big enough that the prompt stops inlining diffs, the model keeps to 6 annotations
 * per file, and the page says so in its header.
 */
export function isLargePr(counts: { files: number; additions: number; deletions: number }): boolean {
  return counts.files > LARGE_PR.files || counts.additions + counts.deletions > LARGE_PR.lines
}
