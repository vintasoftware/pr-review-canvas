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

export const HighRiskRuleSchema = z.object({ pattern: z.string().min(1), label: z.string().min(1) })
export type HighRiskRule = z.infer<typeof HighRiskRuleSchema>

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

export const PromptOverridesSchema = z.object({
  'generation-format.md': z.string().min(1).optional(),
  'generation-strict.md': z.string().min(1).optional(),
  'generation-surfacing.md': z.string().min(1).optional(),
  'quality-standards.md': z.string().min(1).optional(),
  'layering-guidance.md': z.string().min(1).optional(),
  'chat-seed.md': z.string().min(1).optional(),
}).strict()
export type PromptOverrides = z.infer<typeof PromptOverridesSchema>

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
  }),
  /** Which paths count as tests, for the layering rules and the `isTest` flag on a file. */
  tests: z.object({ patterns: z.array(z.string().min(1)) }),
  chat: z.object({ enabled: z.boolean() }),
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
    })
    .optional(),
  tests: z.object({ patterns: z.array(z.string().min(1)).optional() }).optional(),
  chat: z.object({ enabled: z.boolean().optional() }).optional(),
})

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  layers: [],
  highRisk: [],
  generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrHunks: 10 },
  tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
  chat: { enabled: true },
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
    inlineDiffMaxLines: user.generation?.inlineDiffMaxLines ?? DEFAULT_PROJECT_CONFIG.generation.inlineDiffMaxLines,
    smallPrHunks: user.generation?.smallPrHunks ?? DEFAULT_PROJECT_CONFIG.generation.smallPrHunks,
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
