// The routes that write: local review state, and the three things the tool posts to GitHub.
import { Hono } from 'hono'
import { z } from 'zod'
import type { ReviewBodyResponse, StateResponse } from '../../contract/api.js'
import { PostCommentInputSchema, type PostCommentResult } from '../../contract/comments.js'
import type { Pr, ReviewArtifact } from '../../contract/review-artifact.js'
import { checkInlineTarget } from '../../git/patch-lines.js'
import { PostReviewInputSchema } from '../../contract/reviews.js'
import { lookupCanvas, reviewStateFor } from '../../review/carry-over.js'
import { buildReviewBody, unreviewedLayers } from '../../review/review-body.js'
import { isReviewedId } from '../../store/state-store.js'
import type { Derived } from '../../store/derived-store.js'
import type { PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { parsePrNumber } from './api.js'

const ReviewedBodySchema = z.object({
  reviewed: z.boolean(),
  /** The commit the page was showing; a mark made on another commit is refused. */
  headSha: z
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

/**
 * The canvas the reviewer is signing off on: the one written for the pull request's head, or
 * for another commit with an identical diff.
 */
async function artifactForHead(ctx: AppContext, number: number, pr: Pr): Promise<ReviewArtifact> {
  if (ctx.fixtureArtifact !== null) {
    return { ...ctx.fixtureArtifact, pr }
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
  return artifact
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

  const stateBody = (number: number, state: StateResponse['state']): StateResponse => ({
    prNumber: number,
    state,
  })

  api.get('/prs/:n/state', async c => {
    const number = parsePrNumber(c.req.param('n'))
    return c.json(stateBody(number, await ctx.state.read(number)))
  })

  api.put('/prs/:n/reviewed/:id{.+}', async c => {
    const number = parsePrNumber(c.req.param('n'))
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
    const pr = await loader.currentPr(number)
    requireSameHead(body.headSha, pr.headSha)
    return c.json(stateBody(number, await ctx.state.setReviewed(number, id, body.reviewed, pr.headSha)))
  })

  api.put('/prs/:n/points/:fingerprint/dismissed', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const fingerprint = c.req.param('fingerprint')
    const body = await readBody(c.req.raw, DismissedBodySchema, '{ "dismissed": true, "reason": "…" }')
    const next = await ctx.state.setDismissed(number, fingerprint, body.dismissed, body.reason)
    return c.json(stateBody(number, next))
  })

  api.put('/prs/:n/threads/:rootCommentId/hidden', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const rootId = z.coerce.number().int().positive().safeParse(c.req.param('rootCommentId'))
    if (!rootId.success) {
      throw new AppError('BAD_REQUEST', 'the thread id is the numeric id of its first comment', 400)
    }
    const { hidden } = await readBody(c.req.raw, HiddenBodySchema, '{ "hidden": true }')
    return c.json(stateBody(number, await ctx.state.setThreadHidden(number, rootId.data, hidden)))
  })

  api.get('/prs/:n/capabilities', async c => {
    parsePrNumber(c.req.param('n'))
    return c.json(await ctx.capabilities.get({ refresh: c.req.query('refresh') === '1' }))
  })

  api.post('/prs/:n/comments', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const input = await readBody(c.req.raw, PostCommentInputSchema, 'an inline, reply, or issue comment')
    await requirePosting()
    const pr = await loader.currentPr(number)
    requireSameHead(input.headSha, pr.headSha)
    let diff: Derived = { files: [], patches: {} }
    if (input.kind === 'inline') {
      const derived = await ctx.derived.read(pr.headSha)
      if (derived === null) {
        throw new AppError(
          'NOT_FOUND',
          'the diff of this head is not available locally, so the line cannot be checked',
          404,
          'fetch the PR head and reload'
        )
      }
      const problem = checkInlineTarget(derived.files, input)
      if (problem !== null) {
        throw new AppError('COMMENT_LINE_NOT_IN_DIFF', problem, 422, 'comment on a line the diff shows')
      }
      diff = derived
    }
    const posted = await ctx.config.host.postComment(ctx.gh, ctx.config.repo, number, pr.headSha, input, diff)
    await appendComment(ctx, number, posted)
    const entry =
      input.kind === 'inline' && input.pointFingerprint !== undefined
        ? { commentId: posted.comment.id, pointFingerprint: input.pointFingerprint }
        : { commentId: posted.comment.id }
    const state = await ctx.state.addPosted(number, entry)
    return c.json({ ...posted, state }, 201)
  })

  api.get('/prs/:n/review/body', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const pr = await loader.currentPr(number)
    const artifact = await artifactForHead(ctx, number, pr)
    const state = await reviewStateFor(ctx, number, pr)
    const comments = (await ctx.prs.readComments(number)) ?? (await loader.refreshComments(number)).comments
    const body: ReviewBodyResponse = {
      headSha: pr.headSha,
      body: buildReviewBody({ artifact, state, comments, headSha: pr.headSha }),
      unreviewed: unreviewedLayers(artifact, state).map(l => l.title),
    }
    return c.json(body)
  })

  api.post('/prs/:n/review', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const input = await readBody(c.req.raw, PostReviewInputSchema, '{ "event": "APPROVE" }')
    await requirePosting()
    const pr = await loader.currentPr(number)
    requireSameHead(input.headSha, pr.headSha)
    const artifact = await artifactForHead(ctx, number, pr)
    const state = await reviewStateFor(ctx, number, pr)
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
    const review = await ctx.config.host.postReview(ctx.gh, ctx.config.repo, number, pr.headSha, {
      event: input.event,
      body,
    })
    return c.json({ review }, 201)
  })

  return api
}

/** One append at a time per PR, so two posts that land together do not overwrite each other. */
const appendChains = new Map<number, Promise<unknown>>()

function appendComment(ctx: AppContext, number: number, posted: PostCommentResult): Promise<void> {
  const run = () => writeAppendedComment(ctx, number, posted)
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
async function writeAppendedComment(
  ctx: AppContext,
  number: number,
  posted: PostCommentResult
): Promise<void> {
  const comments = await ctx.prs.readComments(number)
  if (comments === null) {
    return
  }
  if (posted.kind === 'review') {
    if (comments.reviewComments.some(c => c.id === posted.comment.id)) {
      return
    }
    await ctx.prs.writeComments(number, {
      ...comments,
      reviewComments: [...comments.reviewComments, posted.comment],
    })
    return
  }
  if (comments.issueComments.some(c => c.id === posted.comment.id)) {
    return
  }
  await ctx.prs.writeComments(number, {
    ...comments,
    issueComments: [...comments.issueComments, posted.comment],
  })
}
