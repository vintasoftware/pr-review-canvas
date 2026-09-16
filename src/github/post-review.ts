import { z } from 'zod'
import type { ReviewEvent } from '../contract/reviews.js'
import type { ReviewSummary } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'

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
