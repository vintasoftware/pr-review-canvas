import { z } from 'zod'
import type { PendingComment } from '../contract/pending.js'
import type { ReviewEvent } from '../contract/reviews.js'
import type { ReviewSummary } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'
import { ghSide } from './post-comment.js'

const GhReviewSchema = z.object({
  id: z.number().int(),
  state: z.string(),
  html_url: z.string(),
  submitted_at: z.string().nullable().optional(),
})

/** One entry of the `comments` array GitHub reads when a review is created with its comments. */
interface GhReviewComment {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

/**
 * The pending comments as GitHub's review payload names them. A range is sent only when it covers
 * more than the anchor line, because GitHub rejects a start_line equal to line.
 */
export function reviewComments(pending: ReadonlyArray<PendingComment>): GhReviewComment[] {
  return pending.map(p => ({
    path: p.path,
    body: p.body,
    line: p.line,
    side: ghSide(p.side),
    ...(p.startLine !== undefined && p.startLine !== p.line
      ? { start_line: p.startLine, start_side: ghSide(p.side) }
      : {}),
  }))
}

/**
 * Posts the review. GitHub decides what the event means; the tool only fills the body, the sha,
 * and the comments the reviewer had waiting, which land as part of the same review.
 */
export async function postReview(
  gh: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string; comments?: ReadonlyArray<PendingComment> }
): Promise<ReviewSummary> {
  const comments = input.comments ?? []
  const raw = await gh.post(`repos/${repo.owner}/${repo.name}/pulls/${number}/reviews`, {
    event: input.event,
    body: input.body,
    commit_id: headSha,
    ...(comments.length === 0 ? {} : { comments: reviewComments(comments) }),
  })
  const r = GhReviewSchema.parse(raw)
  return { id: r.id, state: r.state, url: r.html_url, submittedAt: r.submitted_at ?? null }
}
