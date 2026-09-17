import { z } from 'zod'

export const REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES'] as const
export const ReviewEventSchema = z.enum(REVIEW_EVENTS)
export type ReviewEvent = (typeof REVIEW_EVENTS)[number]

export const PostReviewInputSchema = z.object({
  event: ReviewEventSchema,
  /** The dialog sends the body the user read, edited or not. */
  body: z.string().min(1).max(65536).optional(),
  /** The commit the dialog named. The server refuses the review when the head moved on. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
})
export type PostReviewInput = z.infer<typeof PostReviewInputSchema>
