import { z } from 'zod'
import type { CommentsPayload, IssueComment, ReviewComment } from '../contract/comments.js'
import type { Repo } from '../contract/review-artifact.js'
import type { GitHubClient } from '../github/gh.js'
import { gitlabNoteUrl, gitlabProjectApi } from './project.js'

const GlPositionSchema = z
  .object({
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
  .nullable()
  .optional()

const GlNoteSchema = z.object({
  id: z.number().int(),
  type: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  system: z.boolean().optional(),
  author: z.object({ username: z.string(), avatar_url: z.string().optional() }).nullable().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  position: GlPositionSchema,
})

const GlDiscussionSchema = z.object({
  id: z.string(),
  individual_note: z.boolean().optional(),
  notes: z.array(GlNoteSchema),
})

export const COMMENTS_PAGE_SIZE = 100

export async function fetchAllPages(client: GitHubClient, path: string): Promise<unknown[]> {
  const out: unknown[] = []
  for (let page = 1; ; page++) {
    const batch = z
      .array(z.unknown())
      .parse(await client.api(path, { per_page: String(COMMENTS_PAGE_SIZE), page: String(page) }))
    out.push(...batch)
    if (batch.length < COMMENTS_PAGE_SIZE) {
      return out
    }
  }
}

function isDiffNote(note: z.infer<typeof GlNoteSchema>): boolean {
  const pos = note.position
  if (pos === undefined || pos === null) {
    return false
  }
  return Boolean(pos.new_path || pos.old_path)
}

function sideAndLine(pos: NonNullable<z.infer<typeof GlPositionSchema>>): {
  side: 'new' | 'old'
  line: number | null
  originalLine: number | null
  startLine?: number
} {
  const newLine = pos.new_line ?? null
  const oldLine = pos.old_line ?? null
  const side = newLine !== null ? 'new' : 'old'
  const line = side === 'new' ? newLine : oldLine
  const start = pos.line_range?.start
  const startRaw = side === 'new' ? start?.new_line : start?.old_line
  const out: {
    side: 'new' | 'old'
    line: number | null
    originalLine: number | null
    startLine?: number
  } = { side, line, originalLine: oldLine ?? newLine }
  if (typeof startRaw === 'number' && startRaw !== line) {
    out.startLine = startRaw
  }
  return out
}

export function mapGitLabReviewComment(
  note: z.infer<typeof GlNoteSchema>,
  opts: { webBase: string; repo: Repo; iid: number; headSha: string; inReplyToId?: number }
): ReviewComment {
  const pos = note.position
  const path = pos?.new_path || pos?.old_path || ''
  const loc = pos ? sideAndLine(pos) : { side: 'new' as const, line: null, originalLine: null }
  const commitId = pos?.head_sha ?? opts.headSha
  const outdated = loc.line === null || (pos?.head_sha !== undefined && pos.head_sha !== opts.headSha)
  const comment: ReviewComment = {
    id: note.id,
    author: note.author?.username ?? 'ghost',
    body: note.body ?? '',
    path,
    line: loc.line,
    originalLine: loc.originalLine,
    side: loc.side,
    outdated,
    commitId,
    createdAt: note.created_at,
    updatedAt: note.updated_at ?? note.created_at,
    url: gitlabNoteUrl(opts.webBase, opts.repo, opts.iid, note.id),
    resolved: note.resolved === true,
  }
  if (note.author?.avatar_url) {
    comment.avatarUrl = note.author.avatar_url
  }
  if (loc.startLine !== undefined) {
    comment.startLine = loc.startLine
  }
  if (opts.inReplyToId !== undefined) {
    comment.inReplyToId = opts.inReplyToId
  }
  return comment
}

export function mapGitLabIssueComment(
  note: z.infer<typeof GlNoteSchema>,
  opts: { webBase: string; repo: Repo; iid: number }
): IssueComment {
  const comment: IssueComment = {
    id: note.id,
    author: note.author?.username ?? 'ghost',
    body: note.body ?? '',
    createdAt: note.created_at,
    updatedAt: note.updated_at ?? note.created_at,
    url: gitlabNoteUrl(opts.webBase, opts.repo, opts.iid, note.id),
  }
  if (note.author?.avatar_url) {
    comment.avatarUrl = note.author.avatar_url
  }
  return comment
}

export function parseGlNote(raw: unknown): z.infer<typeof GlNoteSchema> {
  return GlNoteSchema.parse(raw)
}

export interface FetchCommentsResult {
  payload: CommentsPayload
  warnings: string[]
}

export async function fetchGitlabComments(
  client: GitHubClient,
  repo: Repo,
  number: number,
  headSha: string,
  now: () => Date,
  webBase: string
): Promise<FetchCommentsResult> {
  const raw = await fetchAllPages(client, `${gitlabProjectApi(repo)}/merge_requests/${number}/discussions`)
  const reviewComments: ReviewComment[] = []
  const issueComments: IssueComment[] = []
  for (const item of raw) {
    const discussion = GlDiscussionSchema.safeParse(item)
    if (!discussion.success) {
      continue
    }
    const notes = discussion.data.notes.filter(n => n.system !== true)
    if (notes.length === 0) {
      continue
    }
    const first = notes[0]
    if (first !== undefined && isDiffNote(first)) {
      for (const [i, note] of notes.entries()) {
        reviewComments.push(
          mapGitLabReviewComment(note, {
            webBase,
            repo,
            iid: number,
            headSha,
            ...(i === 0 ? {} : { inReplyToId: first.id }),
          })
        )
      }
    } else {
      for (const note of notes) {
        issueComments.push(mapGitLabIssueComment(note, { webBase, repo, iid: number }))
      }
    }
  }
  return {
    payload: { fetchedAt: now().toISOString(), headSha, reviewComments, issueComments },
    warnings: [],
  }
}

/** Finds the discussion that contains a note, so a reply can be posted to that thread. */
export async function findDiscussionId(
  client: GitHubClient,
  repo: Repo,
  number: number,
  noteId: number
): Promise<string | null> {
  const raw = await fetchAllPages(client, `${gitlabProjectApi(repo)}/merge_requests/${number}/discussions`)
  for (const item of raw) {
    const discussion = GlDiscussionSchema.safeParse(item)
    if (!discussion.success) {
      continue
    }
    if (discussion.data.notes.some(n => n.id === noteId)) {
      return discussion.data.id
    }
  }
  return null
}
