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
      /** The artifact's `revisedAt`: an import compares it, so the index answers without the file. */
      revisedAt: z.string().optional(),
      source: z.enum(['local', 'import']),
      importedAt: z.string().optional(),
      /**
       * The canvas this one was generated from. Kept here as well as on the artifact so the line
       * of descent can be walked from the index alone, without opening every canvas on the way.
       */
      basisCanvasSha: z.string().optional(),
      /** A snapshot of uncommitted work: it sits on no branch, so no pull request can claim it. */
      worktree: z.boolean().optional(),
    })
  ),
})
export type CanvasIndex = z.infer<typeof CanvasIndexSchema>

/** How new a copy of a commit's canvas is: the author's last revision, or its generation. */
export function canvasRevision(entry: { generatedAt: string; revisedAt?: string | undefined }): string {
  return entry.revisedAt ?? entry.generatedAt
}
