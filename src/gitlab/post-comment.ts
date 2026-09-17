import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { Repo, Side } from '../contract/review-artifact.js'
import { splitChunks } from '../git/patch-lines.js'
import type { Derived } from '../store/derived-store.js'
import type { HostClient } from '../host/client.js'
import { findDiscussionId, GlNoteSchema, mapGitLabIssueComment, mapGitLabReviewComment } from './comments.js'
import { fetchMrDiffRefs, type MrDiffRefs } from './mr.js'
import { gitlabProjectApi } from './project.js'

/** A new discussion comes back as the thread holding its first note. */
const GlDiscussionSchema = z.object({ notes: z.tuple([GlNoteSchema]).rest(z.unknown()) })

/** Context lines need both coordinates, including offsets introduced by earlier changes. */
function diffLine(patch: string, side: Side, line: number): { old_line?: number; new_line?: number } {
  for (const chunk of splitChunks(patch)) {
    let oldLine = chunk.oldStart
    let newLine = chunk.newStart
    for (const text of chunk.lines) {
      if (![' ', '+', '-'].includes(text[0] ?? '')) continue
      const point = {
        ...(text.startsWith('+') ? {} : { old_line: oldLine++ }),
        ...(text.startsWith('-') ? {} : { new_line: newLine++ }),
      }
      if ((side === 'old' ? point.old_line : point.new_line) === line) return point
    }
  }
  throw new Error(`${side}-side line ${line} is not in the patch`)
}

/** The `position` GitLab anchors an inline comment to. A range names both of its ends by line code. */
export function inlinePosition(
  refs: MrDiffRefs,
  input: Extract<PostCommentInput, { kind: 'inline' }>,
  diff: Derived
): Record<string, unknown> {
  const newPath = input.path
  const file = diff.files.find(f => f.path === input.path)
  const patch = file === undefined ? undefined : diff.patches[file.key]
  if (file === undefined || patch === undefined) {
    throw new Error(`no diff available for ${input.path}`)
  }
  const oldPath = file.oldPath ?? input.path
  const position: Record<string, unknown> = {
    ...refs,
    position_type: 'text',
    old_path: oldPath,
    new_path: newPath,
    ...diffLine(patch, input.side, input.line),
  }
  if (input.startLine !== undefined && input.startLine !== input.line) {
    const hash = createHash('sha1').update(newPath).digest('hex')
    const endpoint = (line: number) => {
      const point = diffLine(patch, input.side, line)
      return {
        ...point,
        line_code: `${hash}_${point.old_line ?? ''}_${point.new_line ?? ''}`,
        type: point.old_line === undefined ? 'new' : 'old',
      }
    }
    position['line_range'] = { start: endpoint(input.startLine), end: endpoint(input.line) }
  }
  return position
}

/**
 * Posts one comment and maps GitLab's answer into the shape the page already renders. An inline
 * comment opens a discussion positioned on the live diff refs; a reply joins the discussion that
 * holds its parent; a review-level comment is a plain note.
 */
export async function postGitlabComment(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: PostCommentInput,
  opts: Derived & { webBase: string }
): Promise<PostCommentResult> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  const mapped = { webBase: opts.webBase, repo, iid: number, headSha }
  switch (input.kind) {
    case 'inline': {
      const refs = await fetchMrDiffRefs(client, repo, number)
      const raw = await client.post(`${base}/discussions`, {
        body: input.body,
        position: inlinePosition(refs, input, opts),
      })
      return {
        kind: 'review',
        comment: mapGitLabReviewComment(GlDiscussionSchema.parse(raw).notes[0], mapped),
      }
    }
    case 'reply': {
      const discussionId = await findDiscussionId(client, repo, number, input.inReplyToId)
      if (discussionId === null) {
        throw new Error(`no GitLab discussion contains note ${input.inReplyToId}`)
      }
      const raw = await client.post(`${base}/discussions/${discussionId}/notes`, { body: input.body })
      const note = GlNoteSchema.parse(raw)
      return {
        kind: 'review',
        comment: mapGitLabReviewComment(note, { ...mapped, inReplyToId: input.inReplyToId }),
      }
    }
    case 'issue': {
      const raw = await client.post(`${base}/notes`, { body: input.body })
      return { kind: 'issue', comment: mapGitLabIssueComment(GlNoteSchema.parse(raw), mapped) }
    }
  }
}
