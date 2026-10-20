// Self-review on the server: the author settles an attention point with a reason, or reopens it.
// The answer is written into the canvas itself and shared again, and every reviewer's page reads it
// back from the canvas comment while it stays open.
import { Hono } from 'hono'
import { SettleInputSchema, type SettledResponse, type SettleResponse } from '../../contract/self-review.js'
import type { Pr, Settlement } from '../../contract/review-artifact.js'
import { isLocalKey, type ReviewKey } from '../../contract/review-key.js'
import { shareCanvasOnPr } from '../../canvas/share.js'
import { lookupCanvas } from '../../review/carry-over.js'
import { isAuthor, settlementCommentBody, withSettlement } from '../../review/self-review.js'
import { type PrLoader, runDiscovery } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { oneAtATime } from '../one-at-a-time.js'
import { parseHeadShaQuery, parseTargetKey, requirePrNumber } from './api.js'
import { mentionsCanvas, postOnPr, readBody, requireSameDiff } from './review-routes.js'

/** Settling changes what every reviewer reads, so only the pull request's author may do it. */
async function requireAuthor(ctx: AppContext, pr: Pr): Promise<void> {
  const { login } = await ctx.capabilities.get()
  if (!isAuthor(login, pr)) {
    throw new AppError(
      'NOT_AUTHOR',
      `only ${pr.author}, who wrote this ${ctx.config.host.noun}, resolves its attention points`,
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
      'the canvas on screen was generated for another commit or another base',
      409,
      'regenerate the canvas for the current head, then resolve its points'
    )
  }
  return found.headSha
}

/** One revision of a canvas at a time, so the comment shared last holds every settlement. */
const reviseInTurn = oneAtATime<string>()

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
    requireSameDiff(input, pr)
    if (!isLocalKey(key)) {
      await requireAuthor(ctx, pr)
    }
    const canvasSha = await currentCanvasSha(ctx, key, pr)
    // Each revision of this canvas runs in turn, reading the review.json the one before it wrote.
    const answer = await reviseInTurn(canvasSha, async (): Promise<SettleResponse> => {
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
            line: point.endLine ?? point.line,
            ...(point.endLine !== undefined && point.endLine !== point.line ? { startLine: point.line } : {}),
            side: point.side ?? 'new',
            body: settlementCommentBody(point, input.reason, await mentionsCanvas(ctx)),
            // The reason is not the point: the settlement links it, and a point reopened later
            // reads as open, not as posted.
            headSha: pr.headSha,
          })
          settlement.commentUrl = posted.comment.url
          state = posted.state
        }
      }
      const revised = withSettlement(artifact, fingerprint, settlement, ctx.now().toISOString())
      await ctx.canvases.revise(canvasSha, revised)
      const sharing = isLocalKey(key)
        ? { status: 'local' as const }
        : await shareCanvasOnPr(ctx, canvasSha, key)
      const comments = isLocalKey(key) ? null : await ctx.prs.readComments(key)
      return {
        settled: revised.settled,
        ...(comments === null ? {} : { issueComments: comments.issueComments }),
        state,
        sharing,
      }
    })
    return c.json(answer)
  })

  // A reviewer's page asks when it opens and every few minutes after. The comments are read again,
  // and the canvas comment imported again only when the pull request's text changed, which a
  // settlement does by updating it.
  api.get('/prs/:n/settled', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'reading resolutions')
    const canvasSha = parseHeadShaQuery(c.req.query('headSha'))
    if (canvasSha === undefined) {
      throw new AppError('BAD_REQUEST', 'name the canvas on screen with ?headSha=<sha>', 400)
    }
    const { comments } = await loader.refreshComments(number)
    if (ctx.fixtureArtifact === null) {
      await runDiscovery(ctx, await loader.currentPr(number), comments, { refresh: false })
    }
    const artifact = ctx.fixtureArtifact ?? (await ctx.canvases.readArtifact(canvasSha))
    if (artifact === null) {
      throw new AppError('NOT_FOUND', `no canvas for ${canvasSha.slice(0, 7)}`, 404, 'reload the page')
    }
    const body: SettledResponse = {
      generatedAt: artifact.generatedAt,
      settled: artifact.settled ?? {},
      issueComments: comments.issueComments,
    }
    return c.json(body)
  })

  return api
}
