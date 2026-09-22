import { z } from 'zod'
import type { PendingComment } from '../contract/pending.js'
import type { Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'
import type { Derived } from '../store/derived-store.js'
import { fetchGitlabComments } from './comments.js'
import { fetchMrDiffRefs } from './mr.js'
import { inlinePosition } from './post-comment.js'
import { gitlabProjectApi } from './project.js'

const DraftSchema = z.object({ id: z.number().int() })

/** Stage this submission privately, then publish it as one GitLab review. */
export async function publishGitlabDrafts(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: { body: string; comments?: ReadonlyArray<PendingComment> },
  webBase: string,
  diff: Derived
) {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}/draft_notes`
  const list = async () => z.array(DraftSchema).parse(await client.api(base))
  if ((await list()).length > 0) {
    throw new Error('Finish or discard your pending review in GitLab before submitting from the canvas.')
  }
  const refs = await fetchMrDiffRefs(client, repo, number)
  if (refs.head_sha !== headSha) throw new Error('The merge request changed. Refresh before submitting.')
  const notes: Array<{ note: string; position?: Record<string, unknown> }> = (input.comments ?? []).map(
    p => ({
      note: p.body,
      position: inlinePosition(refs, { ...p, kind: 'inline' }, diff),
    })
  )
  if (input.body.trim() !== '') notes.push({ note: input.body })
  const fetchComments = () => fetchGitlabComments(client, repo, number, headSha, () => new Date(), webBase)
  const before = new Set((await fetchComments()).payload.reviewComments.map(c => c.id))
  const staged: number[] = []
  try {
    for (const note of notes) staged.push(DraftSchema.parse(await client.post(base, note)).id)
    const current = await list()
    if (current.length !== staged.length || current.some(d => !staged.includes(d.id))) {
      throw new Error(
        'Your pending review changed in GitLab. Finish it there before submitting from the canvas.'
      )
    }
    await client.post(`${base}/bulk_publish`, {})
  } catch (error) {
    // Delete only drafts created by this attempt; local copies remain available for retry.
    const cleanup = await Promise.allSettled(staged.map(id => client.post(`${base}/${id}`, {}, 'DELETE')))
    if (cleanup.some(result => result.status === 'rejected')) {
      throw new Error(
        'Submission failed and some staged drafts remain in GitLab. Inspect your pending review there before retrying.',
        { cause: error }
      )
    }
    throw error
  }
  try {
    const { payload } = await fetchComments()
    return { comments: payload.reviewComments.filter(c => !before.has(c.id)), warnings: [] as string[] }
  } catch {
    return {
      comments: [],
      warnings: ['Review published, but its comments could not be refreshed. Reload to see them.'],
    }
  }
}
