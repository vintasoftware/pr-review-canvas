import { createHash } from 'node:crypto'
import type { PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { FileEntry, Repo, Side } from '../contract/review-artifact.js'
import type { GitHubClient } from '../github/gh.js'
import { findDiscussionId, mapGitLabIssueComment, mapGitLabReviewComment, parseGlNote } from './comments.js'
import { fetchMrMeta } from './mr.js'
import { gitlabNoteUrl, gitlabProjectApi } from './project.js'

function lineCode(filePath: string, oldLine: number | null, newLine: number | null): string {
  const hash = createHash('sha1').update(filePath).digest('hex')
  return `${hash}_${oldLine ?? ''}_${newLine ?? ''}`
}

function pathsFor(
  files: ReadonlyArray<FileEntry> | undefined,
  path: string
): {
  oldPath: string
  newPath: string
} {
  const file = files?.find(f => f.path === path)
  return { oldPath: file?.oldPath ?? path, newPath: path }
}

function positionFor(
  refs: { baseSha: string; startSha: string; headSha: string },
  input: Extract<PostCommentInput, { kind: 'inline' }>,
  files: ReadonlyArray<FileEntry> | undefined
): Record<string, unknown> {
  const { oldPath, newPath } = pathsFor(files, input.path)
  const side: Side = input.side
  const oldLine = side === 'old' ? input.line : null
  const newLine = side === 'new' ? input.line : null
  const position: Record<string, unknown> = {
    base_sha: refs.baseSha,
    start_sha: refs.startSha,
    head_sha: refs.headSha,
    position_type: 'text',
    old_path: oldPath,
    new_path: newPath,
  }
  if (newLine !== null) {
    position['new_line'] = newLine
  }
  if (oldLine !== null) {
    position['old_line'] = oldLine
  }
  const startLine = input.startLine
  if (startLine !== undefined && startLine !== input.line) {
    const startOld = side === 'old' ? startLine : null
    const startNew = side === 'new' ? startLine : null
    position['line_range'] = {
      start: {
        line_code: lineCode(newPath, startOld, startNew),
        type: side === 'old' ? 'old' : 'new',
      },
      end: {
        line_code: lineCode(newPath, oldLine, newLine),
        type: side === 'old' ? 'old' : 'new',
      },
    }
  }
  return position
}

function firstNote(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object' && 'notes' in raw) {
    const notes = (raw as { notes?: unknown[] }).notes
    if (Array.isArray(notes) && notes[0] !== undefined) {
      return notes[0]
    }
  }
  return raw
}

export async function postGitlabComment(
  client: GitHubClient,
  repo: Repo,
  number: number,
  headSha: string,
  input: PostCommentInput,
  opts: { webBase: string; files?: ReadonlyArray<FileEntry> }
): Promise<PostCommentResult> {
  const base = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  switch (input.kind) {
    case 'inline': {
      const meta = await fetchMrMeta(client, repo, number)
      const refs = meta.diffRefs ?? {
        baseSha: meta.mergeCommitSha ?? headSha,
        startSha: meta.mergeCommitSha ?? headSha,
        headSha,
      }
      const raw = await client.post(`${base}/discussions`, {
        body: input.body,
        position: positionFor(refs, input, opts.files),
      })
      const note = parseGlNote(firstNote(raw))
      return {
        kind: 'review',
        comment: mapGitLabReviewComment(note, { webBase: opts.webBase, repo, iid: number, headSha }),
      }
    }
    case 'reply': {
      const discussionId = await findDiscussionId(client, repo, number, input.inReplyToId)
      if (discussionId === null) {
        throw new Error(`no GitLab discussion contains note ${input.inReplyToId}`)
      }
      const raw = await client.post(`${base}/discussions/${discussionId}/notes`, { body: input.body })
      const note = parseGlNote(firstNote(raw))
      return {
        kind: 'review',
        comment: mapGitLabReviewComment(note, {
          webBase: opts.webBase,
          repo,
          iid: number,
          headSha,
          inReplyToId: input.inReplyToId,
        }),
      }
    }
    case 'issue': {
      const raw = await client.post(`${base}/notes`, { body: input.body })
      const note = parseGlNote(firstNote(raw))
      return {
        kind: 'issue',
        comment: mapGitLabIssueComment(note, { webBase: opts.webBase, repo, iid: number }),
      }
    }
  }
}

export function postedCommentUrl(webBase: string, repo: Repo, number: number, commentId: number): string {
  return gitlabNoteUrl(webBase, repo, number, commentId)
}
