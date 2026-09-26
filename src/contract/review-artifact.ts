import { z } from 'zod'
import { DEFAULT_FOLD_LEVEL, FOLD_LEVELS } from '../../static/js/fold-levels.js'

/** Character caps applied to model output. Numbers, so the prompt can print them. */
export const TEXT_CAPS = {
  summary: 1200,
  layerTitle: 60,
  rationale: 300,
  decisions: 600,
  checkByHand: 400,
  annotation: 240,
  pointTitle: 90,
  pointBody: 600,
  testBehavior: 120,
  /** Mermaid source. Measured raw, since it is code and not text a reader reads. */
  diagram: 1500,
} as const
export type TextCaps = { -readonly [K in keyof typeof TEXT_CAPS]: number }

export const LIMITS = { maxPoints: 12, maxDiagramsPerLayer: 1, maxDiagramLinks: 12 } as const
export type Limits = { -readonly [K in keyof typeof LIMITS]: number }

export const TEXT_CAP_KEYS = [
  'summary',
  'layerTitle',
  'rationale',
  'decisions',
  'checkByHand',
  'annotation',
  'pointTitle',
  'pointBody',
  'testBehavior',
  'diagram',
] as const satisfies ReadonlyArray<keyof TextCaps>

function mapCaps(fn: (key: keyof TextCaps) => number): TextCaps {
  return {
    summary: fn('summary'),
    layerTitle: fn('layerTitle'),
    rationale: fn('rationale'),
    decisions: fn('decisions'),
    checkByHand: fn('checkByHand'),
    annotation: fn('annotation'),
    pointTitle: fn('pointTitle'),
    pointBody: fn('pointBody'),
    testBehavior: fn('testBehavior'),
    diagram: fn('diagram'),
  }
}

/** The project config may raise or lower a cap; the result is what the validator and the prompt use. */
export function effectiveCaps(
  overrides: { [K in keyof TextCaps]?: number | undefined } | undefined
): TextCaps {
  return mapCaps(key => overrides?.[key] ?? TEXT_CAPS[key])
}

/**
 * The raw-text ceiling behind a cap: four times the cap. The cap itself is measured on the visible
 * text (review/text-length.ts) by the validator; the schema only refuses pathological input.
 */
export const HARD_CAP_FACTOR = 4
export function hardCaps(caps: TextCaps): TextCaps {
  return mapCaps(key => caps[key] * HARD_CAP_FACTOR)
}

/**
 * Ceilings on a stored or imported artifact: four times the default caps and point limit. A project
 * may raise its caps, but a zip from elsewhere must not hand the browser unbounded text.
 */
export const ARTIFACT_HARD_CAPS: TextCaps = hardCaps(TEXT_CAPS)
export const ARTIFACT_MAX_POINTS = LIMITS.maxPoints * HARD_CAP_FACTOR

export const FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed', 'binary'] as const
export const POINT_KINDS = ['decision', 'risk', 'drift', 'tests', 'debt', 'question'] as const
export const POINT_LEVELS = ['decide', 'check', 'fyi'] as const
export const TEST_STATUSES = ['covered', 'missing', 'not-needed'] as const
export const HARNESSES = ['claude-code', 'codex', 'other'] as const

export const SideSchema = z.enum(['new', 'old'])
export type Side = z.infer<typeof SideSchema>

export {
  contains,
  coveredRows,
  fileRows,
  foldLevelRank,
  hiddenLines,
  UNDISCUSSED,
} from '../../static/js/fold-levels.js'
export { FOLD_LEVELS }
export const FoldLevelSchema = z.enum(FOLD_LEVELS)
export type FoldLevel = z.infer<typeof FoldLevelSchema>

/**
 * How a stored canvas names its levels. One written before levels existed says `collapsed: true`
 * and gives its folds no level; both read as light, so it hides exactly what it hid before. Past
 * this parse every canvas names a level wherever it hides something.
 */
const STORED_LEVELS = {
  collapsed: z
    .union([z.boolean(), FoldLevelSchema])
    .transform(value => (value === true ? DEFAULT_FOLD_LEVEL : value === false ? undefined : value)),
  fold: FoldLevelSchema.default(DEFAULT_FOLD_LEVEL),
}
/** The model names a level for every fold and every collapsed file. */
const MODEL_LEVELS = { collapsed: FoldLevelSchema, fold: FoldLevelSchema }
type Levels = typeof STORED_LEVELS | typeof MODEL_LEVELS

export const HunkSchema = z.object({
  id: z.string().min(1),
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
})
export type Hunk = z.infer<typeof HunkSchema>

export const FileEntrySchema = z.object({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  key: z.string().min(1),
  status: z.enum(FILE_STATUSES),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  lang: z.string().optional(),
  hunks: z.array(HunkSchema),
})
export type FileEntry = z.infer<typeof FileEntrySchema>

export const RepoSchema = z.object({ owner: z.string().min(1), name: z.string().min(1) })
export type Repo = z.infer<typeof RepoSchema>

export const PrSchema = z.object({
  number: z.number().int().positive().nullable(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  /**
   * When the pull request was last edited; the body's attachment links are ranked by it. Absent
   * in a canvas written before this field existed, so an older zip still imports.
   */
  updatedAt: z.string().optional(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
  repo: RepoSchema,
})
export type Pr = z.infer<typeof PrSchema>

export const RiskTagSchema = z.object({
  label: z.string().min(1),
  source: z.enum(['config', 'model']),
  reason: z.string().optional(),
})
export type RiskTag = z.infer<typeof RiskTagSchema>

/** A link in one of the four canvas forms. Parsed and resolved by contract/links. */
export const LinkSchema = z.string().regex(/^#(layer|file|hunk|line):.+/)

/**
 * One diagram of a layer. `links` maps a node id of the mermaid source to a canvas link, so a
 * reader can click a node and land on the code it stands for. The validator checks that every key
 * names a node of the source and that every value resolves.
 */
export function diagramSchema(caps: Caps) {
  return z.object({
    mermaid: z.string().min(1).max(caps.diagram),
    links: z.record(z.string(), LinkSchema),
  })
}
export const DiagramSchema = diagramSchema(ARTIFACT_HARD_CAPS)
export type Diagram = z.infer<typeof DiagramSchema>

/**
 * The model output is checked against the caps in force; the artifact is the published result of
 * a validated output, so it reads back under the generous hard ceilings instead.
 */
type Caps = TextCaps

function text(caps: Caps, key: keyof TextCaps): z.ZodString {
  return textOrEmpty(caps, key).min(1)
}

function textOrEmpty(caps: Caps, key: keyof TextCaps): z.ZodString {
  const visibleCap = caps[key] / HARD_CAP_FACTOR
  const diagrams =
    key === 'summary' || key === 'rationale'
      ? ' Mermaid fences count toward the separate diagram cap, not this prose cap.'
      : ''
  return z
    .string()
    .max(caps[key])
    .meta({
      description: `At most ${visibleCap} visible characters. Link targets, backticks, and code-fence lines do not count. maxLength is only the raw Markdown ceiling.${diagrams}`,
      'x-visibleMaxLength': visibleCap,
    })
}

export function testEntrySchema(caps: Caps) {
  return z.object({
    behavior: text(caps, 'testBehavior'),
    status: z.enum(TEST_STATUSES),
    testPath: z.string().min(1).optional(),
    note: z.string().optional(),
  })
}
export const TestEntrySchema = testEntrySchema(ARTIFACT_HARD_CAPS)
export type TestEntry = z.infer<typeof TestEntrySchema>

export function annotationSchema(caps: Caps) {
  return z.object({
    side: SideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: text(caps, 'annotation'),
  })
}
export const AnnotationSchema = annotationSchema(ARTIFACT_HARD_CAPS)
export type Annotation = z.infer<typeof AnnotationSchema>

function codeFoldSchema(caps: Caps, level: Levels['fold']) {
  return z.object({
    title: z.string().max(caps.pointTitle).regex(/\S/, 'A fold title must contain visible text'),
    side: SideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    /** The lowest reading level that hides this range. */
    level,
  })
}
export const CodeFoldSchema = codeFoldSchema(ARTIFACT_HARD_CAPS, STORED_LEVELS.fold)
export type CodeFold = z.infer<typeof CodeFoldSchema>

function layerFileBase<L extends Levels>(caps: Caps, foldTitleCap: number, levels: L) {
  return {
    path: z.string().min(1),
    hunks: z.array(z.string().min(1)).min(1),
    note: textOrEmpty(caps, 'annotation').optional(),
    annotations: z.array(annotationSchema(caps)),
    /** The lowest reading level that hides the whole file body. */
    collapsed: levels.collapsed.optional(),
    folds: z.array(codeFoldSchema({ ...caps, pointTitle: foldTitleCap }, levels.fold)).optional(),
  }
}

export const LayerFileSchema = z.object({
  ...layerFileBase(ARTIFACT_HARD_CAPS, ARTIFACT_HARD_CAPS.pointTitle, STORED_LEVELS),
  isTest: z.boolean(),
})
export type LayerFile = z.infer<typeof LayerFileSchema>

export const LayerKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/)

function layerBase(caps: Caps) {
  return {
    key: LayerKeySchema,
    title: text(caps, 'layerTitle'),
    rationale: textOrEmpty(caps, 'rationale'),
    /** Markdown: decisions and trade-offs a human should agree with. */
    decisions: text(caps, 'decisions').optional(),
    /** Markdown: what tests cannot verify (UI feel, migrations on real data, ...). */
    checkByHand: text(caps, 'checkByHand').optional(),
    kind: z.enum(['layer', 'other']),
    defaultLayerId: z.string().optional(),
    diagram: diagramSchema(caps).optional(),
    tests: z.array(testEntrySchema(caps)),
  }
}

export const LayerSchema = z.object({
  ...layerBase(ARTIFACT_HARD_CAPS),
  id: z.string().min(1),
  risk: z.array(RiskTagSchema),
  files: z.array(LayerFileSchema).min(1),
})
export type Layer = z.infer<typeof LayerSchema>

function pointBase(caps: Caps) {
  return {
    kind: z.enum(POINT_KINDS),
    level: z.enum(POINT_LEVELS),
    title: text(caps, 'pointTitle'),
    path: z.string().min(1),
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    side: SideSchema.optional(),
    body: text(caps, 'pointBody'),
    /**
     * The key of a decision the author settled in a self-review deck that this point asks again,
     * because the code at this head contradicts the side they picked. Only a `decide` point may.
     */
    reopens: z.string().min(1).optional(),
    /** The key of a self-review card the author skipped, which this `decide` point raises for reviewers. */
    asks: z.string().min(1).optional(),
  }
}

export const PointSchema = z.object({
  ...pointBase(ARTIFACT_HARD_CAPS),
  id: z.string().min(1),
  fingerprint: z.string().min(1),
  origin: z.enum(['model', 'tests']),
  /** The layer that owns the point's hunk; publish fills it from the file's layer. */
  layerId: z.string().optional(),
})
export type Point = z.infer<typeof PointSchema>

export const GeneratorSchema = z.object({
  agent: z.string().min(1),
  model: z.string().optional(),
  harness: z.enum(HARNESSES),
  attempts: z.number().int().positive(),
})
export type Generator = z.infer<typeof GeneratorSchema>

export const ReviewArtifactSchema = z.object({
  version: z.literal(1),
  pr: PrSchema,
  files: z.array(FileEntrySchema),
  /** Markdown, PR-wide "what changes": behavior before and after, no required sections. */
  summary: textOrEmpty(ARTIFACT_HARD_CAPS, 'summary'),
  risk: z.array(RiskTagSchema),
  layers: z.array(LayerSchema).min(1),
  points: z.array(PointSchema).max(ARTIFACT_MAX_POINTS),
  generatedAt: z.string(),
  generator: GeneratorSchema,
  source: z.enum(['local', 'import']),
  importedAt: z.string().optional(),
  /**
   * The basis canvas this one was generated from, when the run was incremental. It records where
   * the carried content came from; a reviewer's server recomputes for itself which marks may
   * follow, so this sha is a pointer and never a claim about what was reviewed.
   */
  basisCanvasSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
})
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>

/**
 * What the agent writes to model.json. The schema bounds raw text at the hard limit (4x the cap);
 * the validator measures the visible text against the cap itself. Ids, fingerprints, layerId,
 * isTest, and config risk are added by publish. A layer may list no files here so the validator
 * can name the problem (`LAYER_EMPTY`) instead of a schema failure; the point count is checked by
 * the validator too, together with the points that missing tests add.
 */
export function modelOutputSchema(textCaps: TextCaps) {
  const caps = hardCaps(textCaps)
  return z.object({
    summary: textOrEmpty(caps, 'summary'),
    layers: z
      .array(
        z.object({
          ...layerBase(caps),
          risk: z.array(z.object({ label: z.string().min(1), reason: z.string().min(1) })).optional(),
          files: z.array(z.object(layerFileBase(caps, textCaps.pointTitle, MODEL_LEVELS))),
        })
      )
      .min(1),
    points: z.array(z.object(pointBase(caps))),
  })
}
export const ModelOutputSchema = modelOutputSchema(TEXT_CAPS)
export type ModelOutput = z.infer<typeof ModelOutputSchema>
export type ModelLayer = ModelOutput['layers'][number]
export type ModelPoint = ModelOutput['points'][number]
