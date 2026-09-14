import { z } from 'zod'
import { SideSchema } from './review-artifact.js'

export const ReviewCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable(),
  originalLine: z.number().int().nullable(),
  side: SideSchema,
  startLine: z.number().int().optional(),
  outdated: z.boolean(),
  commitId: z.string(),
  inReplyToId: z.number().int().optional(),
  createdAt: z.string(),
  /** When the comment was last edited, which is its creation time until someone edits it. */
  updatedAt: z.string(),
  url: z.string(),
  resolved: z.boolean(),
})
export type ReviewComment = z.infer<typeof ReviewCommentSchema>

export const IssueCommentSchema = z.object({
  id: z.number().int(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  /** When the comment was last edited, which is its creation time until someone edits it. */
  updatedAt: z.string(),
  url: z.string(),
})
export type IssueComment = z.infer<typeof IssueCommentSchema>

export const CommentsPayloadSchema = z.object({
  fetchedAt: z.string(),
  headSha: z.string(),
  reviewComments: z.array(ReviewCommentSchema),
  issueComments: z.array(IssueCommentSchema),
})
export type CommentsPayload = z.infer<typeof CommentsPayloadSchema>

/** GitHub rejects a comment body over 65 536 characters, so the tool rejects it first. */
export const COMMENT_BODY_MAX = 65536

const BodySchema = z.string().min(1).max(COMMENT_BODY_MAX)
const HeadShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .optional()

/** What the page sends to `POST /api/prs/:n/comments`. */
export const PostCommentInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline'),
    path: z.string().min(1),
    line: z.number().int().positive(),
    side: SideSchema,
    startLine: z.number().int().positive().optional(),
    body: BodySchema,
    /** Set when the comment comes from an attention point, so the sign-off body can name it. */
    pointFingerprint: z.string().min(1).optional(),
    /** The commit the page was showing. The server refuses the post when the head moved on. */
    headSha: HeadShaSchema,
  }),
  z.object({
    kind: z.literal('reply'),
    inReplyToId: z.number().int().positive(),
    body: BodySchema,
    headSha: HeadShaSchema,
  }),
  z.object({ kind: z.literal('issue'), body: BodySchema, headSha: HeadShaSchema }),
])
export type PostCommentInput = z.infer<typeof PostCommentInputSchema>

/** The posted comment: a review comment for inline and reply, an issue comment for PR-level. */
export type PostCommentResult = { kind: 'review'; comment: ReviewComment } | { kind: 'issue'; comment: IssueComment }

// The proposed-comment block a chat answer can carry. The parser lives in
// static/js/proposed-comment.js so the browser loads the same code without a bundler.
export type { ChatSegment, CommentTargets, ProposedComment } from '../../static/js/proposed-comment.js'
export {
  PROPOSED_BODY_MAX,
  parseProposedComment,
  splitChatAnswer,
  targetsFromFiles,
} from '../../static/js/proposed-comment.js'

export function emptyComments(headSha: string, fetchedAt: string): CommentsPayload {
  return { fetchedAt, headSha, reviewComments: [], issueComments: [] }
}
