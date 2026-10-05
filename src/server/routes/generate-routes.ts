// Generating a canvas from the review page: start a job, read where it is, stop it. Like the chat,
// these routes do not exist when the project config turns chat off, because both put an agent in
// the loop.
import { Hono, type MiddlewareHandler } from 'hono'
import { GenerateInputSchema, type GenerationResponse } from '../../contract/generation.js'
import {
  createGenerationManager,
  GenerationBusyError,
  type GenerationManager,
} from '../../generate/generation-manager.js'
import { describeFixes, fixModel } from '../../review/fix-model.js'
import { prepare } from '../../review/prepare.js'
import { publish, readContext } from '../../review/publish.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { parseTargetKey } from './api.js'

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
    generation: ctx.projectConfig.config.generation,
    repo: ctx.config.repo,
    repoRoot: ctx.config.repoRoot,
    log: ctx.log,
    now: ctx.now,
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

  api.get('/prs/:n/generate', c => {
    const body: GenerationResponse = { job: generation.status(parseTargetKey(c.req.param('n'))) }
    return c.json(body)
  })

  api.post('/prs/:n/generate', async c => {
    const key = parseTargetKey(c.req.param('n'))
    let raw: unknown = {}
    const text = await c.req.text()
    if (text !== '') {
      try {
        raw = JSON.parse(text)
      } catch {
        throw new AppError('BAD_REQUEST', 'send a JSON body: { "force": false }', 400)
      }
    }
    const input = GenerateInputSchema.safeParse(raw)
    if (!input.success) {
      throw new AppError(
        'BAD_REQUEST',
        'send a JSON body: { "force": false }',
        400,
        input.error.issues[0]?.message
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
    try {
      const body: GenerationResponse = { job: await generation.start(key, input.data) }
      return c.json(body, 202)
    } catch (err) {
      if (err instanceof GenerationBusyError) {
        throw new AppError(
          'GENERATION_BUSY',
          err.message,
          409,
          'stop the running generation, or wait for it to finish'
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
