import { z } from 'zod'
import type { ReviewSummary } from '../contract/api.js'
import type { Repo } from '../contract/review-artifact.js'
import type { ReviewEvent } from '../contract/reviews.js'
import type { HostClient } from '../host/client.js'
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
 * GitLab has no GitHub-style review event. Approve calls the approvals API; request-changes posts
 * the review body as an MR note so the text still lands on the merge request.
 */
export async function postGitlabReview(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string },
  webBase: string
): Promise<ReviewSummary> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  const mrUrl = gitlabMrUrl(webBase, repo, number)
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
    state: 'CHANGES_REQUESTED',
    url: gitlabNoteUrl(webBase, repo, number, note.id),
    submittedAt: note.created_at ?? new Date().toISOString(),
  }
}
