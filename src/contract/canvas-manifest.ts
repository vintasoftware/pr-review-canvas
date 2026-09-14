import { z } from 'zod'
import { GeneratorSchema, RepoSchema } from './review-artifact.js'

export const CanvasManifestSchema = z.object({
  formatVersion: z.literal(1),
  tool: z.object({ name: z.string(), version: z.string() }),
  repo: RepoSchema,
  prNumber: z.number().int().positive().optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseRef: z.string(),
  headRef: z.string(),
  generatedAt: z.string(),
  generator: GeneratorSchema,
})
export type CanvasManifest = z.infer<typeof CanvasManifestSchema>

export const CanvasIndexSchema = z.object({
  canvases: z.record(
    z.string(),
    z.object({
      prNumber: z.number().int().positive().optional(),
      generatedAt: z.string(),
      source: z.enum(['local', 'import']),
      importedAt: z.string().optional(),
    })
  ),
})
export type CanvasIndex = z.infer<typeof CanvasIndexSchema>
