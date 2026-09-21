import { z } from 'zod'

/**
 * `COMMENT` leaves a review with no verdict, the way a thread-level review does: the body and the
 * comments land, and nothing is approved or rejected.
 */
export const REVIEW_EVENTS = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const
export const ReviewEventSchema = z.enum(REVIEW_EVENTS)
export type ReviewEvent = (typeof REVIEW_EVENTS)[number]

export const PostReviewInputSchema = z.object({
  event: ReviewEventSchema,
  /** The dialog sends the body the user read, edited or not. */
  body: z.string().min(1).max(65536).optional(),
  /**
   * Whether the pending comments go out with this review. True unless the page says otherwise, so
   * a reviewer who wrote drafts never submits a review that silently leaves them behind.
   */
  includePending: z.boolean().default(true),
  /** The commit the dialog named. The server refuses the review when the head moved on. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
})
export type PostReviewInput = z.infer<typeof PostReviewInputSchema>

/** How the forge names the state of a review it accepted, for a review the tool posted itself. */
export function reviewStateFor(event: ReviewEvent): string {
  switch (event) {
    case 'APPROVE':
      return 'APPROVED'
    case 'REQUEST_CHANGES':
      return 'CHANGES_REQUESTED'
    case 'COMMENT':
      return 'COMMENTED'
  }
}
