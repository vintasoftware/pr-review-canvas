import type { PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { Repo, Side } from '../contract/review-artifact.js'
import { mapIssueComment, mapReviewComment } from './comments.js'
import type { HostClient } from '../host/client.js'

/** GitHub names the two sides of a diff LEFT and RIGHT. */
export function ghSide(side: Side): 'LEFT' | 'RIGHT' {
  return side === 'old' ? 'LEFT' : 'RIGHT'
}

/** The fields GitHub reads for a comment on a diff line. */
interface InlineCommentBody {
  body: string
  commit_id: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

export type CommentRequestBody = InlineCommentBody | { body: string }

/** The JSON body of the REST call for one comment, next to the path it goes to. */
export function commentRequest(
  repo: Repo,
  number: number,
  headSha: string,
  input: PostCommentInput
): { path: string; body: CommentRequestBody } {
  const base = `repos/${repo.owner}/${repo.name}`
  switch (input.kind) {
    case 'inline': {
      // A range is sent only when it covers more than the anchor line; GitHub rejects a
      // start_line equal to line.
      const range =
        input.startLine !== undefined && input.startLine !== input.line
          ? { start_line: input.startLine, start_side: ghSide(input.side) }
          : {}
      const body: InlineCommentBody = {
        body: input.body,
        commit_id: headSha,
        path: input.path,
        line: input.line,
        side: ghSide(input.side),
        ...range,
      }
      return { path: `${base}/pulls/${number}/comments`, body }
    }
    case 'reply':
      return {
        path: `${base}/pulls/${number}/comments/${input.inReplyToId}/replies`,
        body: { body: input.body },
      }
    case 'issue':
      return { path: `${base}/issues/${number}/comments`, body: { body: input.body } }
  }
}

/** Posts one comment and maps GitHub's answer into the shape the page already renders. */
export async function postComment(
  gh: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: PostCommentInput
): Promise<PostCommentResult> {
  const { path, body } = commentRequest(repo, number, headSha, input)
  const raw = await gh.post(path, body)
  if (input.kind === 'issue') {
    return { kind: 'issue', comment: mapIssueComment(raw) }
  }
  return { kind: 'review', comment: mapReviewComment(raw, new Set()) }
}
