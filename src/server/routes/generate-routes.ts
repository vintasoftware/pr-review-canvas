// Generating a canvas from the review page, or a tour from the tour page: start a job, read where
// it is, stop it, under `/prs/:n/generate` and `/tours/:n/generate`. Like the chat, these routes do
// not exist when the project config turns chat off, because both put an agent in the loop.
import { Hono, type MiddlewareHandler } from 'hono'
import {
  GenerateInputSchema,
  type GenerationKind,
  type GenerationResponse,
  type GenerationSkillResponse,
  type GenerationTargetResponse,
} from '../../contract/generation.js'
import { isLocalKey, keyToString, type ReviewKey } from '../../contract/review-key.js'
import { resolveSharing, resolveTourSharing } from '../../contract/settings.js'
import { GenerationBusyError, type GenerationManager } from '../../generate/generation-manager.js'
import { tourGeneratePermission, tourReviewer } from '../../tour/bundle.js'
import { createPrLoader, type PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { branchPr } from '../start-page.js'
import { parseTargetKey } from './api.js'
import { readBody, requirePosting } from './review-routes.js'

/** Whether publish would post this kind's comment on a pull request, with the reader's settings. */
async function sharesOnPr(ctx: AppContext, kind: GenerationKind): Promise<boolean> {
  const { sharing, tour } = ctx.projectConfig.config
  const settings = await ctx.settings.read()
  return kind === 'canvas'
    ? resolveSharing(sharing, settings).canvasComment
    : resolveTourSharing({ sharing, tourShare: tour.share }, settings)
}

/**
 * Refuses a generation whose canvas or tour could not be shared, before minutes of agent time go
 * into it: publish shares a pull request's artifact with the host CLI's login, so the login must be
 * one that may post, read afresh so a login made since the page loaded counts. Local reviews, a
 * project or reader with sharing off, and a job started with `share: false` post nothing, so they
 * need no login.
 */
export async function requireSharingLogin(
  ctx: AppContext,
  key: ReviewKey,
  share = true,
  kind: GenerationKind = 'canvas'
): Promise<void> {
  if (isLocalKey(key) || !share || !(await sharesOnPr(ctx, kind))) {
    return
  }
  await requirePosting(ctx, {
    refresh: true,
    otherwise:
      kind === 'canvas'
        ? 'turn sharing off with `canvasComment: false` in .pr-review/settings.yml'
        : 'turn sharing off with `tourComment: false` in .pr-review/settings.yml',
  })
}

/**
 * Refuses a tour generation `tour.generate` does not allow this reader, before any agent time: the
 * tour's agent runs with every permission, so by default only the change's author starts one.
 */
async function requireTourGenerate(ctx: AppContext, loader: PrLoader, key: ReviewKey): Promise<void> {
  const reviewer = isLocalKey(key)
    ? await tourReviewer(ctx, key, { author: '' })
    : await tourReviewer(ctx, key, await loader.currentTarget(key))
  const permission = tourGeneratePermission(ctx, reviewer)
  if (permission === 'off') {
    throw new AppError(
      'NOT_FOUND',
      'generating a tour from the review app is off for this repository (tour.generate: off)',
      404,
      `run /pr-tour ${keyToString(key)} from Claude Code or Codex, or set tour.generate in pr-review.config.yml`
    )
  }
  if (permission === 'not-author') {
    throw new AppError(
      'NOT_AUTHOR',
      `only the author of #${keyToString(key)} generates its tour from the review app (tour.generate: author): the agent runs with every permission, and a diff someone else wrote could steer it`,
      403,
      `run /pr-tour ${keyToString(key)} from Claude Code or Codex, or set tour.generate: on in pr-review.config.yml`
    )
  }
}

export function generateRoutes(ctx: AppContext): Hono {
  const loader = createPrLoader(ctx)
  const api = new Hono()
  const managers: Record<
    GenerationKind,
    { prefix: 'prs' | 'tours'; manager: GenerationManager; page: string }
  > = {
    canvas: { prefix: 'prs', manager: ctx.generation, page: 'review page' },
    tour: { prefix: 'tours', manager: ctx.tourGeneration, page: 'tour page' },
  }

  const requireAgent: MiddlewareHandler = async (_c, next) => {
    if (!ctx.projectConfig.config.chat.enabled) {
      throw new AppError(
        'NOT_FOUND',
        'agents are turned off for this repository',
        404,
        'set chat.enabled in pr-review.config.yml, or run the skill from Claude Code or Codex'
      )
    }
    await next()
  }
  api.use('/generate/skill', requireAgent)
  api.use('/generate/target', requireAgent)

  // Which skill a run would follow, for the start screen to say before the reader starts one:
  // `?kind=tour` asks for the tour's.
  api.get('/generate/skill', async c => {
    const kind = c.req.query('kind') === 'tour' ? 'tour' : 'canvas'
    const body: GenerationSkillResponse = { skill: await managers[kind].manager.nextSkill() }
    return c.json(body)
  })

  // The review `pr-review generate` and `tour generate` with no target mean: the open PR of the
  // checked-out branch.
  api.get('/generate/target', async c => {
    const body: GenerationTargetResponse = { prNumber: await branchPr(ctx) }
    return c.json(body)
  })

  for (const [kind, { prefix, manager, page }] of Object.entries(managers) as [
    GenerationKind,
    (typeof managers)[GenerationKind],
  ][]) {
    const route = `/${prefix}/:n/generate` as const
    api.use(route, requireAgent)

    api.get(route, c => {
      const body: GenerationResponse = { job: manager.status(parseTargetKey(c.req.param('n'))) }
      return c.json(body)
    })

    api.post(route, async c => {
      const key = parseTargetKey(c.req.param('n'))
      const input = await readBody(c.req.raw, GenerateInputSchema, '{ "force": false }')
      if (input.base !== undefined && !isLocalKey(key)) {
        throw new AppError(
          'BAD_REQUEST',
          'a base is for the branch and uncommitted reviews',
          400,
          'a pull request is compared against its own base'
        )
      }
      if (!(await ctx.preflight.get()).installed) {
        throw new AppError(
          'GENERATION_FAILED',
          'acpx is not installed',
          503,
          'install it with `npm install -g acpx@latest`, or run the skill from Claude Code or Codex'
        )
      }
      if (kind === 'tour') {
        await requireTourGenerate(ctx, loader, key)
      }
      await requireSharingLogin(ctx, key, input.share !== false, kind)
      try {
        const body: GenerationResponse = { job: await manager.start(key, input) }
        return c.json(body, 202)
      } catch (err) {
        if (err instanceof GenerationBusyError) {
          throw new AppError(
            'GENERATION_BUSY',
            err.message,
            409,
            `wait for it to finish, or stop it from the ${page} that started it`
          )
        }
        throw err
      }
    })

    api.delete(route, async c => {
      const key = parseTargetKey(c.req.param('n'))
      const cancelled = await manager.cancel(key)
      return c.json({ cancelled, job: manager.status(key) })
    })
  }

  return api
}
