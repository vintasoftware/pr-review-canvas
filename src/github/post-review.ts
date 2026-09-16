import { z } from 'zod'
import type { ReviewSummary } from './../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'

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

const GhReviewSchema = z.object({
  id: z.number().int(),
  state: z.string(),
  html_url: z.string(),
  submitted_at: z.string().nullable().optional(),
})

/** Posts the review. GitHub decides what the event means; the tool only fills the body and sha. */
export async function postReview(
  gh: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string }
): Promise<ReviewSummary> {
  const raw = await gh.post(`repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`, {
    event: input.event,
    body: input.body,
    commit_id: headSha,
  })
  const r = GhReviewSchema.parse(raw)
  return { id: r.id, state: r.state, url: r.html_url, submittedAt: r.submitted_at ?? null }
}
