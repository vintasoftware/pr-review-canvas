import { z } from 'zod'
import type { ReviewSummary } from '../contract/api.js'
import type { PendingComment } from '../contract/pending.js'
import type { Repo } from '../contract/review-artifact.js'
import type { ReviewEvent } from '../contract/reviews.js'
import type { HostClient } from '../host/client.js'
import type { Derived } from '../store/derived-store.js'
import { postGitlabComment } from './post-comment.js'
import { gitlabMrUrl, gitlabNoteUrl, gitlabProjectApi } from './project.js'

const GlNoteSchema = z.object({
  id: z.number().int(),
  created_at: z.string().optional(),
})

const GlMrSchema = z.object({
  id: z.number().int().optional(),
  iid: z.number().int().optional(),
  web_url: z.string().optional(),
})

/**
 * GitLab has no batch review call, so the pending comments go out one discussion at a time,
 * before the verdict, in the order the reviewer wrote them. The first failure stops the run and
 * nothing else is posted, so the drafts that are left stay in the pending review.
 */
async function postPending(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  pending: ReadonlyArray<PendingComment>,
  opts: Derived & { webBase: string }
): Promise<void> {
  for (const p of pending) {
    await postGitlabComment(
      client,
      repo,
      number,
      headSha,
      {
        kind: 'inline',
        path: p.path,
        line: p.line,
        side: p.side,
        ...(p.startLine === undefined ? {} : { startLine: p.startLine }),
        body: p.body,
      },
      opts
    )
  }
}

/**
 * GitLab has no GitHub-style review event. Approve calls the approvals API; request-changes and a
 * comment-only review post the review body as an MR note so the text still lands on the merge
 * request. Pending comments are posted as inline discussions either way.
 */
export async function postGitlabReview(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string; comments?: ReadonlyArray<PendingComment> },
  webBase: string,
  diff: Derived = { files: [], patches: {} }
): Promise<ReviewSummary> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  const mrUrl = gitlabMrUrl(webBase, repo, number)
  await postPending(client, repo, number, headSha, input.comments ?? [], { webBase, ...diff })
  if (input.event === 'APPROVE') {
    if (input.body.trim() !== '') {
      await client.post(`${base}/notes`, { body: input.body })
    }
    const raw = await client.post(`${base}/approve`, { sha: headSha })
    const mr = GlMrSchema.safeParse(raw).data ?? {}
    return {
      id: mr.id ?? mr.iid ?? number,
      state: 'APPROVED',
      url: mr.web_url ?? mrUrl,
      submittedAt: new Date().toISOString(),
    }
  }
  const raw = await client.post(`${base}/notes`, { body: input.body })
  const note = GlNoteSchema.parse(raw)
  return {
    id: note.id,
    state: input.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED',
    url: gitlabNoteUrl(webBase, repo, number, note.id),
    submittedAt: note.created_at ?? new Date().toISOString(),
  }
}
