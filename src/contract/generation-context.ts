import { z } from 'zod'
import { readChunkLimit } from './chunk-compat.js'
import { DefaultLayerSchema, GenerationModeSchema, HighRiskRuleSchema } from '../project-config.js'
import { DEFAULT_TEST_PATTERNS } from '../review/test-paths.js'
import { FileEntrySchema, LIMITS, PrSchema, RepoSchema, type TextCaps } from './review-artifact.js'

/** What `prepare` was asked to describe: a pull request, or two refs before a PR exists. */
export const PrepareTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pr'), number: z.number().int().positive() }),
  z.object({ kind: z.literal('refs'), base: z.string().min(1), head: z.string().min(1) }),
])
export type PrepareTarget = z.infer<typeof PrepareTargetSchema>

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

/**
 * `context.json`: everything the agent and `publish` need about one prepared canvas. Written by
 * `prepare` next to `prompt.md`; `publish` validates `model.json` against the chunk index and the
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
  /** The manifest: every changed file with its chunk ids and headers. */
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
  generation: z.preprocess(
    readChunkLimit,
    z.object({
      mode: GenerationModeSchema.default('strict'),
      maxRepairRounds: z.number().int().positive(),
      inlineDiffMaxLines: z.number().int().positive(),
      smallPrChunks: z.number().int().positive(),
    })
  ),
  /** The globs that make a file a test here. Defaulted, so a context written before this
   * field existed still reads. */
  tests: z
    .object({ patterns: z.array(z.string().min(1)) })
    .default(() => ({ patterns: [...DEFAULT_TEST_PATTERNS] })),
  /** At most `generation.smallPrChunks` chunks: one layer unless concerns differ, fewer annotations. */
  smallPr: z.boolean(),
  /** More than 400 files or 50 000 changed lines: the prompt inlines nothing and tightens the caps. */
  largePr: z.boolean(),
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
