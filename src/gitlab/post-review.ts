import { z } from 'zod'
import type { PostedReview } from '../host/host.js'
import type { PendingComment } from '../contract/pending.js'
import type { Repo } from '../contract/review-artifact.js'
import type { ReviewEvent } from '../contract/reviews.js'
import type { HostClient } from '../host/client.js'
import type { Derived } from '../store/derived-store.js'
import { publishGitlabDrafts } from './publish-drafts.js'
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
 * GitLab has no GitHub-style review event. Approve calls the approvals API; request-changes and a
 * comment-only review post the review body as an MR note so the text still lands on the merge
 * request. Pending comments and the summary publish together through the Draft Notes API.
 */
export async function postGitlabReview(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string; comments?: ReadonlyArray<PendingComment> },
  webBase: string,
  diff: Derived = { files: [], patches: {} }
): Promise<PostedReview> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  const mrUrl = gitlabMrUrl(webBase, repo, number)
  const batched = (input.comments?.length ?? 0) > 0
  const { comments, warnings } = batched
    ? await publishGitlabDrafts(client, repo, number, headSha, input, webBase, diff)
    : { comments: [], warnings: [] }
  if (input.event === 'APPROVE') {
    if (!batched && input.body.trim() !== '') {
      await client.post(`${base}/notes`, { body: input.body })
    }
    let raw: unknown
    try {
      raw = await client.post(`${base}/approve`, { sha: headSha })
    } catch (error) {
      if (!batched) throw error
      return {
        comments,
        warnings: [
          ...warnings,
          'Comments published, but approval failed. Approve the merge request in GitLab.',
        ],
        id: number,
        state: 'COMMENTED',
        url: mrUrl,
        submittedAt: new Date().toISOString(),
      }
    }
    const mr = GlMrSchema.safeParse(raw).data ?? {}
    return {
      comments,
      warnings,
      id: mr.id ?? mr.iid ?? number,
      state: 'APPROVED',
      url: mr.web_url ?? mrUrl,
      submittedAt: new Date().toISOString(),
    }
  }
  if (batched) {
    return {
      comments,
      warnings,
      id: number,
      state: input.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED',
      url: mrUrl,
      submittedAt: new Date().toISOString(),
    }
  }
  const raw = await client.post(`${base}/notes`, { body: input.body })
  const note = GlNoteSchema.parse(raw)
  return {
    comments,
    warnings: [],
    id: note.id,
    state: input.event === 'COMMENT' ? 'COMMENTED' : 'CHANGES_REQUESTED',
    url: gitlabNoteUrl(webBase, repo, number, note.id),
    submittedAt: note.created_at ?? new Date().toISOString(),
  }
}
