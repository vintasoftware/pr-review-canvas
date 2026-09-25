import { z } from 'zod'
import { SETTLEMENT_REASON_MAX, type Settlement } from './review-artifact.js'
import type { PrState } from './state.js'

/** The commit the page was showing. The server refuses the change when the head moved on. */
const HeadShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .optional()

/**
 * The author settles a point with a reason, or reopens it. `comment` also posts the reason on the
 * point's line, which only a pull request has.
 */
export const SettleInputSchema = z.discriminatedUnion('settled', [
  z.object({
    settled: z.literal(true),
    reason: z.string().trim().min(1).max(SETTLEMENT_REASON_MAX),
    comment: z.boolean().default(false),
    headSha: HeadShaSchema,
  }),
  z.object({ settled: z.literal(false), headSha: HeadShaSchema }),
])
export type SettleInput = z.input<typeof SettleInputSchema>

/** How a stored canvas reached its pull request: shared as the canvas comment, or not. */
export type CanvasSharing =
  | { status: 'shared'; url: string }
  | { status: 'failed'; warning: string; zipPath: string }

/** The answer of `PUT /prs/:n/points/:fingerprint/settled`. */
export interface SettleResponse {
  /** Every settled point of the canvas, by fingerprint, after this change. */
  settled: Record<string, Settlement>
  state: PrState
  /** `local` for a review with no pull request, where there is nothing to share. */
  sharing: CanvasSharing | { status: 'local' }
}
