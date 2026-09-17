import { z } from 'zod'
import { CANVAS_COMMENT_MARKER } from '../canvas/comment.js'
import type { Repo } from '../contract/review-artifact.js'
import { fetchAllPages, type HostClient } from '../host/client.js'
import { mapIssueComment } from './comments.js'

export async function shareGithubCanvas(
  client: HostClient,
  repo: Repo,
  number: number,
  body: string
): Promise<string> {
  const user = z.object({ login: z.string() }).parse(await client.api('user'))
  const base = `repos/${repo.owner}/${repo.name}`
  const comments = (await fetchAllPages(client, `${base}/issues/${number}/comments`)).map(mapIssueComment)
  const existing = comments.find(c => c.author === user.login && c.body.includes(CANVAS_COMMENT_MARKER))
  const response =
    existing === undefined
      ? await client.post(`${base}/issues/${number}/comments`, { body })
      : await client.post(`${base}/issues/comments/${existing.id}`, { body }, 'PATCH')
  return mapIssueComment(response).url
}
