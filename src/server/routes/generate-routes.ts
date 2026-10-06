// Generating a canvas from the review page: start a job, read where it is, stop it. Like the chat,
// these routes do not exist when the project config turns chat off, because both put an agent in
// the loop.
import { Hono, type MiddlewareHandler } from 'hono'
import {
  GenerateInputSchema,
  type GenerationResponse,
  type GenerationSkillResponse,
} from '../../contract/generation.js'
import { isLocalKey, type ReviewKey } from '../../contract/review-key.js'
import { resolveSharing } from '../../contract/settings.js'
import {
  createGenerationManager,
  GenerationBusyError,
  type GenerationManager,
} from '../../generate/generation-manager.js'
import { loadGenerationSkill } from '../../generate/skill.js'
import { describeFixes, fixModel } from '../../review/fix-model.js'
import { prepare } from '../../review/prepare.js'
import { publish, readContext } from '../../review/publish.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { parseTargetKey } from './api.js'
import { readBody, requirePosting } from './review-routes.js'

/** The generation manager over the real pipeline: the same prepare and publish the CLI runs. */
export function createContextGeneration(ctx: AppContext): GenerationManager {
  return createGenerationManager({
    runner: ctx.runner,
    checkouts: ctx.checkouts,
    steps: {
      prepare: (input, opts) => prepare(ctx, input, opts),
      publish: (canvasDir, opts) => publish(ctx, canvasDir, opts),
      fix: async (canvasDir, modelPath, text) => {
        const context = await readContext(canvasDir)
        const { patches } = await ctx.derived.ensure(context.headSha, context.mergeBaseSha)
        return describeFixes(await fixModel(modelPath, text, context, patches))
      },
    },
    settings: () => ctx.chat.effectiveSettings(),
    skill: agent => loadGenerationSkill(ctx.config.repoRoot, agent, ctx.version),
    generation: ctx.projectConfig.config.generation,
    repo: ctx.config.repo,
    repoRoot: ctx.config.repoRoot,
    currentBranch: () => ctx.git.currentBranch(),
    log: ctx.log,
    now: ctx.now,
  })
}

/**
 * Refuses a generation whose canvas could not be shared, before minutes of agent time go into
 * it: publish shares a pull request's canvas with the host CLI's login, so the login must be one
 * that may post, read afresh so a login made since the page loaded counts. Local reviews and a
 * project or reader with sharing off post nothing, so they need no login.
 */
export async function requireSharingLogin(ctx: AppContext, key: ReviewKey): Promise<void> {
  if (isLocalKey(key)) {
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

export function generateRoutes(
  ctx: AppContext,
  generation: GenerationManager = createContextGeneration(ctx)
): Hono {
  const api = new Hono()

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

  // Which skill a run would follow, for the start screen to say before the reader starts one.
  api.get('/generate/skill', async c => {
    const body: GenerationSkillResponse = { skill: await generation.nextSkill() }
    return c.json(body)
  })

  api.get('/prs/:n/generate', c => {
    const body: GenerationResponse = { job: generation.status(parseTargetKey(c.req.param('n'))) }
    return c.json(body)
  })

  api.post('/prs/:n/generate', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const input = await readBody(c.req.raw, GenerateInputSchema, '{ "force": false }')
    if (!(await ctx.preflight.get()).installed) {
      throw new AppError(
        'GENERATION_FAILED',
        'acpx is not installed',
        503,
        'install it with `npm install -g acpx@latest`, or run the skill from Claude Code or Codex'
      )
    }
    await requireSharingLogin(ctx, key)
    try {
      const body: GenerationResponse = { job: await generation.start(key, input) }
      return c.json(body, 202)
    } catch (err) {
      if (err instanceof GenerationBusyError) {
        throw new AppError(
          'GENERATION_BUSY',
          err.message,
          409,
          'stop it from its review page, or wait for it to finish'
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
