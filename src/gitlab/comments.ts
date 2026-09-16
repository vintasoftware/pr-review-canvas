import { z } from 'zod'
import type { IssueComment, ReviewComment } from '../contract/comments.js'
import type { Repo } from '../contract/review-artifact.js'
import { type FetchCommentsResult, fetchAllPages } from '../github/comments.js'
import type { HostClient } from '../host/client.js'
import { gitlabNoteUrl, gitlabProjectApi } from './project.js'

const GlPositionSchema = z.object({
  new_path: z.string().nullable().optional(),
  old_path: z.string().nullable().optional(),
  new_line: z.number().int().nullable().optional(),
  old_line: z.number().int().nullable().optional(),
  head_sha: z.string().optional(),
  line_range: z
    .object({
      start: z
        .object({
          new_line: z.number().int().nullable().optional(),
          old_line: z.number().int().nullable().optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
})

/** The subset of a GitLab note the tool reads. A note on a diff line carries a `position`. */
export const GlNoteSchema = z.object({
  id: z.number().int(),
  body: z.string().nullable().optional(),
  system: z.boolean().optional(),
  author: z.object({ username: z.string(), avatar_url: z.string().optional() }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  resolved: z.boolean().optional(),
  position: GlPositionSchema.nullable().optional(),
})
type GlNote = z.infer<typeof GlNoteSchema>
type GlPosition = z.infer<typeof GlPositionSchema>

const GlDiscussionSchema = z.object({ id: z.string(), notes: z.array(GlNoteSchema) })

function isDiffNote(note: GlNote): boolean {
  return Boolean(note.position?.new_path || note.position?.old_path)
}

/** Which side and line the note sits on, and where a range starts when it spans more than one line. */
function sideAndLine(
  pos: GlPosition
): Pick<ReviewComment, 'side' | 'line' | 'originalLine'> & { startLine?: number } {
  const side = pos.new_line !== null && pos.new_line !== undefined ? 'new' : 'old'
  const line = (side === 'new' ? pos.new_line : pos.old_line) ?? null
  const start = pos.line_range?.start
  const startLine = (side === 'new' ? start?.new_line : start?.old_line) ?? null
  return {
    side,
    line,
    originalLine: pos.old_line ?? pos.new_line ?? null,
    ...(startLine !== null && startLine !== line ? { startLine } : {}),
  }
}

export interface NoteContext {
  webBase: string
  repo: Repo
  iid: number
  headSha: string
  inReplyToId?: number
}

export function mapGitLabReviewComment(note: GlNote, ctx: NoteContext): ReviewComment {
  const pos = note.position ?? null
  const loc = pos === null ? { side: 'new' as const, line: null, originalLine: null } : sideAndLine(pos)
  const comment: ReviewComment = {
    id: note.id,
    author: note.author?.username ?? 'ghost',
    ...(note.author?.avatar_url ? { avatarUrl: note.author.avatar_url } : {}),
    body: note.body ?? '',
    path: pos?.new_path || pos?.old_path || '',
    line: loc.line,
    originalLine: loc.originalLine,
    side: loc.side,
    // GitLab keeps the note's position on the head it was made for; a note whose head is not the
    // current one, or that lost its line, is about code the diff no longer shows.
    outdated: loc.line === null || (pos?.head_sha !== undefined && pos.head_sha !== ctx.headSha),
    commitId: pos?.head_sha ?? ctx.headSha,
    createdAt: note.created_at,
    updatedAt: note.updated_at ?? note.created_at,
    url: gitlabNoteUrl(ctx.webBase, ctx.repo, ctx.iid, note.id),
    resolved: note.resolved === true,
  }
  if (loc.startLine !== undefined) {
    comment.startLine = loc.startLine
  }
  if (ctx.inReplyToId !== undefined) {
    comment.inReplyToId = ctx.inReplyToId
  }
  return comment
}

export function mapGitLabIssueComment(
  note: GlNote,
  ctx: Pick<NoteContext, 'webBase' | 'repo' | 'iid'>
): IssueComment {
  return {
    id: note.id,
    author: note.author?.username ?? 'ghost',
    ...(note.author?.avatar_url ? { avatarUrl: note.author.avatar_url } : {}),
    body: note.body ?? '',
    createdAt: note.created_at,
    updatedAt: note.updated_at ?? note.created_at,
    url: gitlabNoteUrl(ctx.webBase, ctx.repo, ctx.iid, note.id),
  }
}

/** Every discussion of the merge request that the tool can read; anything else GitLab lists is skipped. */
async function fetchDiscussions(client: HostClient, repo: Repo, number: number) {
  const raw = await fetchAllPages(client, `${gitlabProjectApi(repo)}/merge_requests/${number}/discussions`)
  return raw.flatMap(item => {
    const parsed = GlDiscussionSchema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * GitLab has one list of discussions; each is a thread on a diff line or a thread of merge request
 * notes. The former become review comments with the thread's first note as the parent, the latter
 * issue comments. System notes (assigned, pushed) are not comments.
 */
export async function fetchGitlabComments(
  client: HostClient,
  repo: Repo,
  number: number,
  headSha: string,
  now: () => Date,
  webBase: string
): Promise<FetchCommentsResult> {
  const reviewComments: ReviewComment[] = []
  const issueComments: IssueComment[] = []
  const ctx: NoteContext = { webBase, repo, iid: number, headSha }
  for (const discussion of await fetchDiscussions(client, repo, number)) {
    const [first, ...replies] = discussion.notes.filter(n => n.system !== true)
    if (first === undefined) {
      continue
    }
    if (isDiffNote(first)) {
      reviewComments.push(
        mapGitLabReviewComment(first, ctx),
        ...replies.map(note => mapGitLabReviewComment(note, { ...ctx, inReplyToId: first.id }))
      )
    } else {
      issueComments.push(...[first, ...replies].map(note => mapGitLabIssueComment(note, ctx)))
    }
  }
  return {
    payload: { fetchedAt: now().toISOString(), headSha, reviewComments, issueComments },
    warnings: [],
  }
}

/** Finds the discussion that contains a note, so a reply can be posted to that thread. */
export async function findDiscussionId(
  client: HostClient,
  repo: Repo,
  number: number,
  noteId: number
): Promise<string | null> {
  const discussions = await fetchDiscussions(client, repo, number)
  return discussions.find(d => d.notes.some(n => n.id === noteId))?.id ?? null
}
