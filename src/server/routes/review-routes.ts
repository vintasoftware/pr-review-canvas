// The routes that write: local review state, and the three things the tool posts to GitHub.
import { Hono } from 'hono'
import { z } from 'zod'
import type { ReviewBodyResponse, StateResponse } from '../../contract/api.js'
import { PostCommentInputSchema, type PostCommentResult } from '../../contract/comments.js'
import { AddPendingInputSchema, EditPendingInputSchema, type PendingComment } from '../../contract/pending.js'
import type { Pr, ReviewArtifact } from '../../contract/review-artifact.js'
import type { PrState } from '../../contract/state.js'
import { checkInlineTarget } from '../../git/patch-lines.js'
import { PostReviewInputSchema } from '../../contract/reviews.js'
import { lookupCanvas, samePatches } from '../../review/carry-over.js'
import { buildReviewBody, stateForCanvas, unreviewedLayers } from '../../review/review-body.js'
import { isLocalKey, keyLabel, type ReviewKey } from '../../contract/review-key.js'
import { canvasBelongsTo } from '../../store/canvas-store.js'
import { isReviewedId } from '../../store/state-store.js'
import type { Derived } from '../../store/derived-store.js'
import { LOCAL_CAPABILITIES, type PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { parseTargetKey, requirePrNumber } from './api.js'

const ReviewedBodySchema = z.object({
  reviewed: z.boolean(),
  /** The commit the page was showing; a mark made on another commit is refused. */
  headSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /**
   * The commit of the canvas on the page, which the marks are keyed to. The head when absent. Any
   * other value must be a canvas indexed for this pull request.
   */
  canvasSha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
})
const DismissedBodySchema = z.object({ dismissed: z.boolean(), reason: z.string().max(500).optional() })
const HiddenBodySchema = z.object({ hidden: z.boolean() })

/**
 * The page says which commit it was showing. When the pull request has moved on, the post is
 * refused instead of landing on code the reader never saw.
 */
function requireSameHead(expected: string | undefined, current: string): void {
  if (expected !== undefined && expected !== current) {
    throw new AppError(
      'CANVAS_STALE',
      'the pull request has a new head commit since this page was drawn',
      409,
      'reload the page and try again'
    )
  }
}

/** A JSON body the route can read, or a 400 that says what shape it expected. */
async function readBody<T>(request: Request, schema: z.ZodType<T>, expected: string): Promise<T> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new AppError('BAD_REQUEST', `send a JSON body: ${expected}`, 400)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', `send a JSON body: ${expected}`, 400, parsed.error.issues[0]?.message)
  }
  return parsed.data
}

/** Refuses a commit that is not an indexed canvas of this target. */
async function requireCanvasOf(ctx: AppContext, key: ReviewKey, canvasSha: string): Promise<void> {
  const entry = (await ctx.canvases.readIndex()).canvases[canvasSha]
  // The same rule the lookups use, so a mark can only be keyed to a canvas this target shows.
  if (entry === undefined || !canvasBelongsTo(entry, key)) {
    throw new AppError(
      'CANVAS_NOT_FOUND',
      `${canvasSha.slice(0, 7)} is not a canvas of ${keyLabel(key)}`,
      404,
      'reload the page'
    )
  }
}

/**
 * The canvas the reviewer is signing off on, with the marks made on it: the canvas written for the
 * pull request's head, or for another commit with an identical diff.
 */
async function canvasForSignOff(
  ctx: AppContext,
  number: number,
  pr: Pr
): Promise<{ artifact: ReviewArtifact; state: PrState }> {
  const stored = await ctx.state.read(number)
  if (ctx.fixtureArtifact !== null) {
    return { artifact: { ...ctx.fixtureArtifact, pr }, state: stateForCanvas(stored, pr.headSha) }
  }
  const found = await lookupCanvas(ctx, number, pr)
  if (found.status !== 'ready') {
    throw new AppError(
      'SIGNOFF_INCOMPLETE',
      'the canvas on screen was generated for another commit',
      409,
      'regenerate the canvas for the current head, then review its layers'
    )
  }
  const artifact = await ctx.canvases.readArtifact(found.headSha)
  if (artifact === null) {
    throw new AppError('CANVAS_NOT_FOUND', `no canvas for pull request ${number}`, 404, 'generate one first')
  }
  return { artifact, state: stateForCanvas(stored, found.headSha) }
}

/**
 * The diff of this head as it is stored locally, which every inline target is checked against.
 * Without it the line a comment names cannot be checked, so the comment is refused rather than
 * sent to a coordinate nobody verified.
 */
async function requireDerived(ctx: AppContext, headSha: string): Promise<Derived> {
  const derived = await ctx.derived.read(headSha)
  if (derived === null) {
    throw new AppError(
      'NOT_FOUND',
      'the diff of this head is not available locally, so the line cannot be checked',
      404,
      'fetch the PR head and reload'
    )
  }
  return derived
}

/** Refuses a line the diff on screen does not show. */
function requireInlineTarget(diff: Derived, target: Parameters<typeof checkInlineTarget>[1]): void {
  const problem = checkInlineTarget(diff.files, target)
  if (problem !== null) {
    throw new AppError('COMMENT_LINE_NOT_IN_DIFF', problem, 422, 'comment on a line the diff shows')
  }
}

/**
 * The `posted` entries for drafts that came from attention points, found in the comment list the
 * forge created in this submission. Match the full range and body inside that receipt,
 * never against historical comments. A failed comment read is reported by the host adapter.
 */
export function postedFromPending(
  pending: ReadonlyArray<PendingComment>,
  comments: ReadonlyArray<{
    id: number
    path: string
    line: number | null
    startLine?: number | undefined
    side: string
    body: string
  }>
): Array<{ commentId: number; pointFingerprint: string }> {
  const entries: Array<{ commentId: number; pointFingerprint: string }> = []
  const used = new Set<number>()
  for (const draft of pending) {
    if (draft.pointFingerprint === undefined) {
      continue
    }
    const match = comments.find(
      c =>
        !used.has(c.id) &&
        c.path === draft.path &&
        c.line === draft.line &&
        (c.startLine ?? c.line) === (draft.startLine ?? draft.line) &&
        c.side === draft.side &&
        c.body === draft.body
    )
    if (match !== undefined) {
      used.add(match.id)
      entries.push({ commentId: match.id, pointFingerprint: draft.pointFingerprint })
    }
  }
  return entries
}

export function reviewRoutes(ctx: AppContext, loader: PrLoader): Hono {
  const api = new Hono()

  /** Posting is refused here as well as in the UI, so a stale page cannot post either. */
  const requirePosting = async (): Promise<void> => {
    const caps = await ctx.capabilities.get()
    if (caps.canComment === false) {
      throw new AppError(
        'COMMENT_FORBIDDEN',
        caps.reason ?? `this ${ctx.config.host.label} login cannot post on this repository`,
        403,
        caps.hint
      )
    }
  }

  const stateBody = (key: ReviewKey, state: StateResponse['state']): StateResponse => ({
    prNumber: key,
    state,
  })

  api.get('/prs/:n/state', async c => {
    const key = parseTargetKey(c.req.param('n'))
    return c.json(stateBody(key, await ctx.state.read(key)))
  })

  api.put('/prs/:n/reviewed/:id{.+}', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const id = c.req.param('id')
    if (!isReviewedId(id)) {
      throw new AppError(
        'BAD_REQUEST',
        `not a reviewed id: ${id}`,
        400,
        'use layer:<id> or layer:<id>/file:<key>'
      )
    }
    const body = await readBody(c.req.raw, ReviewedBodySchema, '{ "reviewed": true }')
    // A mark is made against the canvas on screen, which for a local review is the snapshot the
    // page was drawn from, not whatever the working tree holds a keystroke later.
    const pr = await loader.currentTarget(key)
    if (!isLocalKey(key)) {
      requireSameHead(body.headSha, pr.headSha)
    }
    // The page sends back the canvas commit the bundle keyed its marks to, so a toggle costs no
    // git work; the index, not git, says the commit is a canvas of this target.
    const canvasSha = body.canvasSha ?? pr.headSha
    if (canvasSha !== pr.headSha) {
      await requireCanvasOf(ctx, key, canvasSha)
    }
    return c.json(stateBody(key, await ctx.state.setReviewed(key, id, body.reviewed, canvasSha)))
  })

  api.put('/prs/:n/points/:fingerprint/dismissed', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const fingerprint = c.req.param('fingerprint')
    const body = await readBody(c.req.raw, DismissedBodySchema, '{ "dismissed": true, "reason": "…" }')
    const next = await ctx.state.setDismissed(key, fingerprint, body.dismissed, body.reason)
    return c.json(stateBody(key, next))
  })

  api.put('/prs/:n/threads/:rootCommentId/hidden', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'hiding a comment thread')
    const rootId = z.coerce.number().int().positive().safeParse(c.req.param('rootCommentId'))
    if (!rootId.success) {
      throw new AppError('BAD_REQUEST', 'the thread id is the numeric id of its first comment', 400)
    }
    const { hidden } = await readBody(c.req.raw, HiddenBodySchema, '{ "hidden": true }')
    return c.json(stateBody(number, await ctx.state.setThreadHidden(number, rootId.data, hidden)))
  })

  api.get('/prs/:n/capabilities', async c => {
    const key = parseTargetKey(c.req.param('n'))
    if (isLocalKey(key)) {
      return c.json(LOCAL_CAPABILITIES)
    }
    return c.json(await ctx.capabilities.get({ refresh: c.req.query('refresh') === '1' }))
  })

  api.post('/prs/:n/comments', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'posting a comment')
    const input = await readBody(c.req.raw, PostCommentInputSchema, 'an inline, reply, or issue comment')
    await requirePosting()
    const pr = await loader.currentPr(number)
    requireSameHead(input.headSha, pr.headSha)
    let diff: Derived = { files: [], patches: {} }
    if (input.kind === 'inline') {
      diff = await requireDerived(ctx, pr.headSha)
      requireInlineTarget(diff, input)
    }
    const posted = await ctx.config.host.postComment(ctx.gh, ctx.config.repo, number, pr.headSha, input, diff)
    await appendComments(ctx, number, [posted])
    const entry =
      input.kind === 'inline' && input.pointFingerprint !== undefined
        ? { commentId: posted.comment.id, pointFingerprint: input.pointFingerprint }
        : { commentId: posted.comment.id }
    const state = await ctx.state.addPosted(number, entry)
    return c.json({ ...posted, state }, 201)
  })

  // The pending review: comments the reviewer wrote and has not submitted. They are kept here,
  // never on the forge, until a review carries them out in one go.
  api.post('/prs/:n/pending', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'a pending review comment')
    const input = await readBody(c.req.raw, AddPendingInputSchema, 'a comment on a line of the diff')
    const pr = await loader.currentPr(number)
    requireSameHead(input.headSha, pr.headSha)
    // A draft is checked against the diff when it is written, so a line that cannot take a comment
    // is refused while the reviewer is still looking at it, not when the review is submitted.
    requireInlineTarget(await requireDerived(ctx, pr.headSha), input)
    const state = await ctx.state.addPending(number, input, pr.headSha)
    return c.json(stateBody(number, state), 201)
  })

  api.patch('/prs/:n/pending/:id', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'a pending review comment')
    const id = c.req.param('id')
    const { body } = await readBody(c.req.raw, EditPendingInputSchema, '{ "body": "…" }')
    const current = await ctx.state.read(number)
    if (!current.pending.some(p => p.id === id)) {
      throw new AppError('NOT_FOUND', `no pending comment ${id}`, 404, 'reload the page')
    }
    return c.json(stateBody(number, await ctx.state.editPending(number, id, body)))
  })

  api.delete('/prs/:n/pending/:id', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'a pending review comment')
    return c.json(stateBody(number, await ctx.state.removePending(number, c.req.param('id'))))
  })

  /** Discards the whole pending review. Nothing was on the forge, so nothing is withdrawn. */
  api.delete('/prs/:n/pending', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'a pending review')
    return c.json(stateBody(number, await ctx.state.clearPending(number)))
  })

  api.get('/prs/:n/review/body', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'the sign-off summary')
    const pr = await loader.currentPr(number)
    const { artifact, state } = await canvasForSignOff(ctx, number, pr)
    const comments = (await ctx.prs.readComments(number)) ?? (await loader.refreshComments(number)).comments
    const body: ReviewBodyResponse = {
      headSha: pr.headSha,
      body: buildReviewBody({ artifact, state, comments, headSha: pr.headSha }),
      unreviewed: unreviewedLayers(artifact, state).map(l => l.title),
      pending: state.pending.length,
    }
    return c.json(body)
  })

  api.post('/prs/:n/review', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'submitting a review')
    const input = await readBody(c.req.raw, PostReviewInputSchema, '{ "event": "APPROVE" }')
    await requirePosting()
    const pr = await loader.currentPr(number)
    requireSameHead(input.headSha, pr.headSha)
    const { artifact, state } = await canvasForSignOff(ctx, number, pr)
    if (input.event === 'APPROVE') {
      const missing = unreviewedLayers(artifact, state)
      if (missing.length > 0) {
        throw new AppError(
          'SIGNOFF_INCOMPLETE',
          `${missing.length} ${missing.length === 1 ? 'layer is' : 'layers are'} not reviewed yet`,
          409,
          missing.map(l => l.title).join(', ')
        )
      }
    }
    const comments = (await ctx.prs.readComments(number)) ?? (await loader.refreshComments(number)).comments
    const body = input.body ?? buildReviewBody({ artifact, state, comments, headSha: pr.headSha })
    // The drafts read here are the ones that go out. A draft written after this read stays in the
    // pending review instead of being dropped by the clear below.
    const pending = input.includePending ? (await ctx.state.read(number)).pending : []
    // GitLab needs the diff to position its draft notes.
    const diff = pending.length === 0 ? { files: [], patches: {} } : await requireDerived(ctx, pr.headSha)
    for (const head of new Set(pending.map(p => p.headSha))) {
      if (head === pr.headSha) continue
      const original = await ctx.derived.read(head)
      if (
        !ctx.projectConfig.config.canvas.keepForIdenticalDiff ||
        original === null ||
        !samePatches(original, diff)
      ) {
        throw new AppError(
          'CANVAS_STALE',
          'pending comments were written on a different diff',
          409,
          'copy or delete the earlier-commit drafts in the pending review, then comment on the current code'
        )
      }
    }
    const {
      comments: submittedComments,
      warnings,
      ...review
    } = await ctx.config.host.postReview(
      ctx.gh,
      ctx.config.repo,
      number,
      pr.headSha,
      { event: input.event, body, comments: pending },
      diff
    )
    const next =
      pending.length === 0
        ? await ctx.state.read(number)
        : await ctx.state.completePending(number, pending, postedFromPending(pending, submittedComments))
    if (submittedComments.length > 0) {
      await appendComments(
        ctx,
        number,
        submittedComments.map(comment => ({ kind: 'review', comment }))
      )
    }
    return c.json(
      { review, submitted: pending.length, state: next, comments: submittedComments, warnings },
      201
    )
  })

  return api
}

/** One append at a time per PR, so two posts that land together do not overwrite each other. */
const appendChains = new Map<number, Promise<unknown>>()

function appendComments(
  ctx: AppContext,
  number: number,
  posted: ReadonlyArray<PostCommentResult>
): Promise<void> {
  const run = () => writeAppendedComments(ctx, number, posted)
  const chained = (appendChains.get(number) ?? Promise.resolve()).then(run, run)
  appendChains.set(
    number,
    chained.catch(() => undefined)
  )
  return chained
}

/**
 * Keeps the cached comments in step with what was just posted, so a reload shows it once. With
 * nothing cached there is nothing to keep in step: the next read fetches the list from GitHub.
 */
async function writeAppendedComments(
  ctx: AppContext,
  number: number,
  posted: ReadonlyArray<PostCommentResult>
): Promise<void> {
  const comments = await ctx.prs.readComments(number)
  if (comments === null) {
    return
  }
  const reviewComments = [...comments.reviewComments]
  const issueComments = [...comments.issueComments]
  for (const entry of posted) {
    const list = entry.kind === 'review' ? reviewComments : issueComments
    if (list.some(c => c.id === entry.comment.id)) continue
    if (entry.kind === 'review') reviewComments.push(entry.comment)
    else issueComments.push(entry.comment)
  }
  if (
    reviewComments.length !== comments.reviewComments.length ||
    issueComments.length !== comments.issueComments.length
  ) {
    await ctx.prs.writeComments(number, { ...comments, reviewComments, issueComments })
  }
}
