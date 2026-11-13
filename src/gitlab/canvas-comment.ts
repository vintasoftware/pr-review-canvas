import { z } from 'zod'
import type { IssueComment } from '../contract/comments.js'
import { CANVAS_COMMENT_MARKER } from '../canvas/comment.js'
import type { Repo } from '../contract/review-artifact.js'
import { fetchAllPages, type HostClient } from '../host/client.js'
import { GlNoteSchema, mapGitLabIssueComment } from './comments.js'
import { gitlabProjectApi } from './project.js'

export async function shareGitlabCanvas(
  client: HostClient,
  repo: Repo,
  number: number,
  body: string,
  webBase: string,
  marker: string = CANVAS_COMMENT_MARKER
): Promise<IssueComment> {
  const user = z.object({ username: z.string() }).parse(await client.api('user'))
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}/notes`
  const notes = (await fetchAllPages(client, base)).map(raw => GlNoteSchema.parse(raw))
  const existing = notes.find(n => n.author?.username === user.username && n.body?.includes(marker))
  const response =
    existing === undefined
      ? await client.post(base, { body })
      : await client.post(`${base}/${existing.id}`, { body }, 'PUT')
  return mapGitLabIssueComment(GlNoteSchema.parse(response), { webBase, repo, iid: number })
}
