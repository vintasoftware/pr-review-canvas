import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { FileEntry, Repo } from '../contract/review-artifact.js'
import type { HostClient } from '../host/client.js'
import { findDiscussionId, GlNoteSchema, mapGitLabIssueComment, mapGitLabReviewComment } from './comments.js'
import { fetchMrDiffRefs, type MrDiffRefs } from './mr.js'
import { gitlabProjectApi } from './project.js'

/** A new discussion comes back as the thread holding its first note. */
const GlDiscussionSchema = z.object({ notes: z.tuple([GlNoteSchema]).rest(z.unknown()) })

/** GitLab's id for one diff line: the path hash and the line on each side. */
function lineCode(filePath: string, oldLine: number | null, newLine: number | null): string {
  return `${createHash('sha1').update(filePath).digest('hex')}_${oldLine ?? ''}_${newLine ?? ''}`
}

/** The `position` GitLab anchors an inline comment to. A range names both of its ends by line code. */
export function inlinePosition(
  refs: MrDiffRefs,
  input: Extract<PostCommentInput, { kind: 'inline' }>,
  files: ReadonlyArray<FileEntry>
): Record<string, unknown> {
  const newPath = input.path
  const oldPath = files.find(f => f.path === input.path)?.oldPath ?? input.path
  const at = (line: number): [old: number | null, current: number | null] =>
    input.side === 'old' ? [line, null] : [null, line]
  const [oldLine, newLine] = at(input.line)
  const position: Record<string, unknown> = {
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    position_type: 'text',
    old_path: oldPath,
    new_path: newPath,
    ...(oldLine === null ? {} : { old_line: oldLine }),
    ...(newLine === null ? {} : { new_line: newLine }),
  }
  if (input.startLine !== undefined && input.startLine !== input.line) {
    position['line_range'] = {
      start: { line_code: lineCode(newPath, ...at(input.startLine)), type: input.side },
      end: { line_code: lineCode(newPath, oldLine, newLine), type: input.side },
    }
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
  opts: { webBase: string; files: ReadonlyArray<FileEntry> }
): Promise<PostCommentResult> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  const mapped = { webBase: opts.webBase, repo, iid: number, headSha }
  switch (input.kind) {
    case 'inline': {
      const refs = await fetchMrDiffRefs(client, repo, number)
      const raw = await client.post(`${base}/discussions`, {
        body: input.body,
        position: inlinePosition(refs, input, opts.files),
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
