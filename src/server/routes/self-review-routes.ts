// The author's side of self-review: settling an attention point with a reason, or reopening it. The
// answer is written into the canvas itself and shared again, so it reaches every reviewer.
import { Hono } from 'hono'
import { SettleInputSchema, type SettleResponse } from '../../contract/self-review.js'
import type { Pr, Settlement } from '../../contract/review-artifact.js'
import { isLocalKey, type ReviewKey } from '../../contract/review-key.js'
import { shareCanvasOnPr } from '../../canvas/share.js'
import { lookupCanvas } from '../../review/carry-over.js'
import { isAuthor, settlementCommentBody, withSettlement } from '../../review/self-review.js'
import type { PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { parseTargetKey, requirePrNumber } from './api.js'
import { postOnPr, readBody, requireSameHead } from './review-routes.js'

/** Settling changes what every reviewer reads, so only the pull request's author may do it. */
async function requireAuthor(ctx: AppContext, pr: Pr): Promise<void> {
  const { login } = await ctx.capabilities.get()
  if (!isAuthor(login, pr)) {
    throw new AppError(
      'NOT_AUTHOR',
      `only ${pr.author}, who wrote this ${ctx.config.host.noun}, settles its attention points`,
      403,
      'dismiss the point instead; a dismissal stays on your machine'
    )
  }
}

/** The commit of the canvas the page shows, when that canvas describes the current head. */
async function currentCanvasSha(ctx: AppContext, key: ReviewKey, pr: Pr): Promise<string> {
  const found = isLocalKey(key)
    ? await ctx.canvases.findForLocal(key, pr.headSha)
    : await lookupCanvas(ctx, key, pr)
  if (found.status !== 'ready') {
    throw new AppError(
      'CANVAS_STALE',
      'the canvas on screen was generated for another commit',
      409,
      'regenerate the canvas for the current head, then settle its points'
    )
  }
  return found.headSha
}

/** One revision of a canvas at a time, so the comment shared last holds every settlement. */
const revisions = new Map<string, Promise<unknown>>()

function oneAtATime<T>(canvasSha: string, run: () => Promise<T>): Promise<T> {
  const chained = (revisions.get(canvasSha) ?? Promise.resolve()).then(run, run)
  revisions.set(
    canvasSha,
    chained.catch(() => undefined)
  )
  return chained
}

export function selfReviewRoutes(ctx: AppContext, loader: PrLoader): Hono {
  const api = new Hono()

  api.put('/prs/:n/points/:fingerprint/settled', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const fingerprint = c.req.param('fingerprint')
    const input = await readBody(c.req.raw, SettleInputSchema, '{ "settled": true, "reason": "…" }')
    if (ctx.fixtureArtifact !== null) {
      throw new AppError('NOT_IMPLEMENTED', 'a --fixture-canvas artifact is read-only', 501)
    }
    const pr = await loader.currentTarget(key)
    if (!isLocalKey(key)) {
      requireSameHead(input.headSha, pr.headSha)
      await requireAuthor(ctx, pr)
    }
    const canvasSha = await currentCanvasSha(ctx, key, pr)
    // Each revision of this canvas runs in turn, reading the review.json the one before it wrote.
    const answer = await oneAtATime(canvasSha, async (): Promise<SettleResponse> => {
      const artifact = await ctx.canvases.readArtifact(canvasSha)
      const point = artifact?.points.find(p => p.fingerprint === fingerprint)
      if (artifact === null || point === undefined) {
        throw new AppError(
          'NOT_FOUND',
          `no attention point ${fingerprint} on this canvas`,
          404,
          'reload the page'
        )
      }
      let state = await ctx.state.read(key)
      let settlement: Settlement | undefined
      if (input.settled) {
        settlement = { reason: input.reason, at: ctx.now().toISOString() }
        if (input.comment) {
          const posted = await postOnPr(ctx, loader, requirePrNumber(key, 'posting the reason'), {
            kind: 'inline',
            path: point.path,
            line: point.line,
            side: point.side ?? 'new',
            body: settlementCommentBody(point, input.reason),
            pointFingerprint: point.fingerprint,
            headSha: pr.headSha,
          })
          settlement.commentUrl = posted.comment.url
          state = posted.state
        }
      }
      const revised = withSettlement(artifact, fingerprint, settlement, ctx.now().toISOString())
      await ctx.canvases.revise(canvasSha, revised)
      return {
        settled: revised.settled,
        state,
        sharing: isLocalKey(key) ? { status: 'local' } : await shareCanvasOnPr(ctx, canvasSha, key),
      }
    })
    return c.json(answer)
  })

  return api
}
