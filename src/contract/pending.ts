// A review the reviewer is still writing: comments kept on this machine until the review is
// submitted, the way a pending review works on the forge's own page.
import { z } from 'zod'
import { SideSchema } from './review-artifact.js'
import { COMMENT_BODY_MAX } from './comments.js'

/**
 * One comment waiting in the pending review. It names a line the way a posted inline comment
 * does, so submitting it needs nothing the page has to look up again.
 */
export const PendingCommentSchema = z.object({
  /** Local id, unique inside one target's state. Never a forge id: nothing was posted yet. */
  id: z.string().min(1),
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: SideSchema,
  /** The first line of a multi-line comment, absent when it covers one line. */
  startLine: z.number().int().positive().optional(),
  body: z.string().min(1).max(COMMENT_BODY_MAX),
  /** Set when the comment came from an attention point, so the point can be marked posted. */
  pointFingerprint: z.string().min(1).optional(),
  /** The commit the reviewer was reading when they wrote it. */
  headSha: z.string(),
  createdAt: z.string(),
  /** Creation time until the reviewer edits the draft. */
  updatedAt: z.string(),
})
export type PendingComment = z.infer<typeof PendingCommentSchema>

/** What the page sends to `POST /api/prs/:n/pending`. */
export const AddPendingInputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: SideSchema,
  startLine: z.number().int().positive().optional(),
  body: z.string().min(1).max(COMMENT_BODY_MAX),
  pointFingerprint: z.string().min(1).optional(),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
})
export type AddPendingInput = z.infer<typeof AddPendingInputSchema>

/** What the page sends to `PATCH /api/prs/:n/pending/:id`. */
export const EditPendingInputSchema = z.object({
  body: z.string().min(1).max(COMMENT_BODY_MAX),
})
export type EditPendingInput = z.infer<typeof EditPendingInputSchema>

/** The label the page and the review body use for a count of drafts. */
export function pendingLabel(count: number): string {
  return count === 1 ? '1 pending comment' : `${count} pending comments`
}
