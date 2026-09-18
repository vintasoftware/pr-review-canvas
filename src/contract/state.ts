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

export const PrStateSchema = z.object({
  version: z.literal(1),
  /**
   * Counts the writes to this file. The page uses it to tell a newer answer from an older one
   * when two of its requests overlap. Absent in state files of older tool versions.
   */
  rev: z.number().int().nonnegative().optional(),
  reviewed: z.record(z.string(), z.literal(true)),
  /**
   * The commit of the canvas the reviewed marks were made on: the head, or the commit a carried-over
   * canvas was generated for. A canvas for another commit describes other code, so the marks start
   * again with it. Absent in state files of older tool versions.
   */
  reviewedHeadSha: z.string().optional(),
  hiddenThreads: z.record(z.string(), z.object({ at: z.string() })),
  posted: z.array(
    z.object({ commentId: z.number().int(), pointFingerprint: z.string().optional(), at: z.string() })
  ),
  dismissed: z.record(z.string(), z.object({ at: z.string(), reason: z.string().optional() })),
  chat: z.object({ threads: z.array(ChatThreadSchema), activeThread: z.string().optional() }),
  updatedAt: z.string(),
})
export type PrState = z.infer<typeof PrStateSchema>

export function emptyState(updatedAt: string): PrState {
  return {
    version: 1,
    rev: 0,
    reviewed: {},
    hiddenThreads: {},
    posted: [],
    dismissed: {},
    chat: { threads: [] },
    updatedAt,
  }
}
