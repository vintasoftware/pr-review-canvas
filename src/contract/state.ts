import { z } from 'zod'

export const ChatThreadSchema = z.object({
  name: z.string(),
  agent: z.string(),
  rev: z.number().int(),
  title: z.string(),
  createdAt: z.string(),
  seededHeadSha: z.string(),
})

export type ChatThread = z.infer<typeof ChatThreadSchema>

/**
 * Version 1 keyed a reviewed mark by the layer's position in the canvas (`layer:layer-2`). Marks
 * are keyed by the layer's own key now, so a regenerated canvas that reorders its layers keeps
 * them straight, and the old positional marks cannot be translated without the canvas they were
 * made on. They are dropped; the rest of the file (dismissals, posted comments, chat threads)
 * carries over untouched.
 */
const dropPositionalMarks = (raw: unknown): unknown => {
  if (raw === null || typeof raw !== 'object') {
    return raw
  }
  const { reviewedHeadSha: _reviewedHeadSha, ...rest } = raw as Record<string, unknown>
  if (rest['version'] !== 1) {
    return rest
  }
  return { ...rest, version: 2, reviewed: {}, reviewedCanvasSha: undefined }
}

export const PrStateSchema = z.preprocess(
  dropPositionalMarks,
  z.object({
    version: z.literal(2),
    /**
     * Counts the writes to this file. The page uses it to tell a newer answer from an older one
     * when two of its requests overlap. Absent in state files of older tool versions.
     */
    rev: z.number().int().nonnegative().optional(),
    reviewed: z.record(z.string(), z.literal(true)),
    /**
     * The commit of the canvas the reviewed marks were made on: the head, or the commit a carried-over
     * canvas was generated for. A canvas for another commit describes other code, so the marks start
     * again with it, unless that canvas names this one as its basis and the code behind a mark is
     * untouched. Absent in state files of older tool versions.
     */
    reviewedCanvasSha: z.string().optional(),
    hiddenThreads: z.record(z.string(), z.object({ at: z.string() })),
    posted: z.array(
      z.object({ commentId: z.number().int(), pointFingerprint: z.string().optional(), at: z.string() })
    ),
    dismissed: z.record(z.string(), z.object({ at: z.string(), reason: z.string().optional() })),
    chat: z.object({ threads: z.array(ChatThreadSchema), activeThread: z.string().optional() }),
    updatedAt: z.string(),
  })
)
export type PrState = z.infer<typeof PrStateSchema>

export function emptyState(updatedAt: string): PrState {
  return {
    version: 2,
    rev: 0,
    reviewed: {},
    hiddenThreads: {},
    posted: [],
    dismissed: {},
    chat: { threads: [] },
    updatedAt,
  }
}
