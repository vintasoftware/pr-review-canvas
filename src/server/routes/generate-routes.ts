// Generating a canvas from the review page: start a job, read where it is, stop it. Like the chat,
// these routes do not exist when the project config turns chat off, because both put an agent in
// the loop.
import { Hono, type MiddlewareHandler } from 'hono'
import {
  GenerateInputSchema,
  type GenerationResponse,
  type GenerationSkillResponse,
  type GenerationTargetResponse,
} from '../../contract/generation.js'
import { isLocalKey, type ReviewKey } from '../../contract/review-key.js'
import { resolveSharing } from '../../contract/settings.js'
import { GenerationBusyError } from '../../generate/generation-manager.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { branchPr } from '../start-page.js'
import { parseTargetKey } from './api.js'
import { readBody, requirePosting } from './review-routes.js'

/**
 * Refuses a generation whose canvas could not be shared, before minutes of agent time go into
 * it: publish shares a pull request's canvas with the host CLI's login, so the login must be one
 * that may post, read afresh so a login made since the page loaded counts. Local reviews, a
 * project or reader with sharing off, and a job started with `share: false` post nothing, so they
 * need no login.
 */
export async function requireSharingLogin(ctx: AppContext, key: ReviewKey, share = true): Promise<void> {
  if (isLocalKey(key) || !share) {
    return
  }
  if (!resolveSharing(ctx.projectConfig.config.sharing, await ctx.settings.read()).canvasComment) {
    return
  }
  await requirePosting(ctx, {
    refresh: true,
    otherwise: 'turn sharing off with `canvasComment: false` in .pr-review/settings.yml',
  })
}

export function generateRoutes(ctx: AppContext): Hono {
  const api = new Hono()
  const { generation } = ctx

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
  api.use('/prs/:n/generate', requireAgent)
  api.use('/generate/skill', requireAgent)
  api.use('/generate/target', requireAgent)

  // Which skill a run would follow, for the start screen to say before the reader starts one.
  api.get('/generate/skill', async c => {
    const body: GenerationSkillResponse = { skill: await generation.nextSkill() }
    return c.json(body)
  })

  // The review `pr-review generate` with no target means: the open PR of the checked-out branch.
  api.get('/generate/target', async c => {
    const body: GenerationTargetResponse = { prNumber: await branchPr(ctx) }
    return c.json(body)
  })

  api.get('/prs/:n/generate', c => {
    const body: GenerationResponse = { job: generation.status(parseTargetKey(c.req.param('n'))) }
    return c.json(body)
  })

  api.post('/prs/:n/generate', async c => {
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
    await requireSharingLogin(ctx, key, input.share !== false)
    try {
      const body: GenerationResponse = { job: await generation.start(key, input) }
      return c.json(body, 202)
    } catch (err) {
      if (err instanceof GenerationBusyError) {
        throw new AppError(
          'GENERATION_BUSY',
          err.message,
          409,
          'wait for it to finish, or stop it from the review page that started it'
        )
      }
      throw err
    }
  })

  api.delete('/prs/:n/generate', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const cancelled = await generation.cancel(key)
    return c.json({ cancelled, job: generation.status(key) })
  })

  return api
}
