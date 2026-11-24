import { z } from 'zod'
import { CanvasTimeSchema, GeneratorSchema, RepoSchema } from './review-artifact.js'

export const CanvasManifestSchema = z.object({
  formatVersion: z.literal(1),
  tool: z.object({ name: z.string(), version: z.string() }),
  repo: RepoSchema,
  prNumber: z.number().int().positive().optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  mergeBaseSha: z.string().regex(/^[0-9a-f]{40}$/),
  baseRef: z.string(),
  headRef: z.string(),
  /**
   * A copy of the canvas's own `generatedAt`, as publish writes it. Only the canvas's times are
   * judged (see `revisionTime`); an earlier version stored whatever a shared manifest said here.
   */
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
      /**
       * The linked worktree whose local review the canvas was made for. Absent for the main
       * checkout's local reviews, and for a pull request's canvas, which every worktree shares.
       */
      checkout: z.string().optional(),
    })
  ),
})
export type CanvasIndex = z.infer<typeof CanvasIndexSchema>

/** How far ahead of this machine's clock a canvas may be dated: clocks differ, by far less. */
const CLOCK_ALLOWANCE_MS = 24 * 60 * 60 * 1000

/**
 * How new a copy of a commit's canvas is: the time of the author's last revision, or of its
 * generation. Null when the copy states a time the canvas schema would refuse, or one more than a
 * day ahead of `now`. The newest copy wins, so a copy dated ahead would win over every copy made
 * later: it is never imported, and one an earlier version stored loses to any copy that is, and
 * is replaced without being read.
 */
export function revisionTime(
  entry: { generatedAt: string; revisedAt?: string | undefined },
  now: Date
): number | null {
  const revised = entry.revisedAt ?? entry.generatedAt
  const trusted = (time: string) =>
    CanvasTimeSchema.safeParse(time).success && Date.parse(time) <= now.getTime() + CLOCK_ALLOWANCE_MS
  return trusted(entry.generatedAt) && trusted(revised) ? Date.parse(revised) : null
}
