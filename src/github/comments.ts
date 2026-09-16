import { z } from 'zod'
import type { CommentsPayload, IssueComment, ReviewComment } from '../contract/comments.js'
import type { Repo } from '../contract/review-artifact.js'
import type { GitHubClient } from './gh.js'
import { fetchResolvedCommentIds } from './threads.js'

const GhReviewCommentSchema = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable(),
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  side: z.enum(['LEFT', 'RIGHT']).nullable().optional(),
  start_line: z.number().int().nullable().optional(),
  commit_id: z.string(),
  in_reply_to_id: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  html_url: z.string(),
})

const GhIssueCommentSchema = z.object({
  id: z.number().int(),
  user: z.object({ login: z.string(), avatar_url: z.string().optional() }).nullable(),
  body: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  html_url: z.string(),
})

export function mapReviewComment(raw: unknown, resolvedIds: ReadonlySet<number>): ReviewComment {
  const c = GhReviewCommentSchema.parse(raw)
  const line = c.line ?? null
  const out: ReviewComment = {
    id: c.id,
    author: c.user?.login ?? 'ghost',
    ...(c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}),
    body: c.body,
    path: c.path,
    line,
    originalLine: c.original_line ?? null,
    side: c.side === 'LEFT' ? 'old' : 'new',
    // GitHub clears `line` when the commented code is no longer in the diff.
    outdated: line === null,
    commitId: c.commit_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at ?? c.created_at,
    url: c.html_url,
    resolved: resolvedIds.has(c.id),
  }
  if (typeof c.start_line === 'number') {
    out.startLine = c.start_line
  }
  if (c.in_reply_to_id !== undefined) {
    out.inReplyToId = c.in_reply_to_id
  }
  return out
}

export function mapIssueComment(raw: unknown): IssueComment {
  const c = GhIssueCommentSchema.parse(raw)
  return {
    id: c.id,
    author: c.user?.login ?? 'ghost',
    ...(c.user?.avatar_url ? { avatarUrl: c.user.avatar_url } : {}),
    body: c.body ?? '',
    createdAt: c.created_at,
    updatedAt: c.updated_at ?? c.created_at,
    url: c.html_url,
  }
}

export interface FetchCommentsResult {
  payload: CommentsPayload
  warnings: string[]
}

export const COMMENTS_PAGE_SIZE = 100

/** Every item of a REST list endpoint, following `page=` until a page comes back short. */
export async function fetchAllPages(gh: GitHubClient, path: string): Promise<unknown[]> {
  const out: unknown[] = []
  for (let page = 1; ; page++) {
    const batch = z
      .array(z.unknown())
      .parse(await gh.api(path, { per_page: String(COMMENTS_PAGE_SIZE), page: String(page) }))
    out.push(...batch)
    if (batch.length < COMMENTS_PAGE_SIZE) {
      return out
    }
  }
}

/**
 * Review comments (on diff lines) and issue comments (PR-level), with the resolved flag from
 * GraphQL. A GraphQL failure degrades to `resolved: false` everywhere plus a warning.
 */
export async function fetchComments(
  gh: GitHubClient,
  repo: Repo,
  number: number,
  headSha: string,
  now: () => Date
): Promise<FetchCommentsResult> {
  const warnings: string[] = []
  const base = `repos/${repo.owner}/${repo.name}`
  const [reviewRaw, issueRaw] = await Promise.all([
    fetchAllPages(gh, `${base}/pulls/${number}/comments`),
    fetchAllPages(gh, `${base}/issues/${number}/comments`),
  ])
  const reviews = (await fetchAllPages(gh, `${base}/pulls/${number}/reviews`)).flatMap(raw => {
    const review = GhIssueCommentSchema.omit({ created_at: true })
      .extend({
        submitted_at: z.string().nullable().optional(),
        state: z.string(),
      })
      .parse(raw)
    if (!review.submitted_at || review.state === 'PENDING') return []
    return [{ ...mapIssueComment({ ...review, created_at: review.submitted_at }), state: review.state }]
  })
  let resolvedIds: Set<number>
  try {
    resolvedIds = await fetchResolvedCommentIds(gh, repo, number)
  } catch (err) {
    resolvedIds = new Set()
    warnings.push(`resolved state unavailable: ${err instanceof Error ? err.message : String(err)}`)
  }
  const reviewComments = reviewRaw.map(c => mapReviewComment(c, resolvedIds))
  const issueComments = issueRaw.map(mapIssueComment)
  return {
    payload: { fetchedAt: now().toISOString(), headSha, reviewComments, issueComments, reviews },
    warnings,
  }
}
