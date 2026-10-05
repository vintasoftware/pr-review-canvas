// Generating a canvas from the review page: start a job, read where it is, stop it. Like the chat,
// these routes do not exist when the project config turns chat off, because both put an agent in
// the loop.
import { Hono, type MiddlewareHandler } from 'hono'
import type { ErrorCode } from '../../contract/api.js'
import { GenerateInputSchema, type GenerationResponse } from '../../contract/generation.js'
import { isLocalKey, type ReviewKey } from '../../contract/review-key.js'
import { resolveSharing } from '../../contract/settings.js'
import { CLI_INFO, type HostCli } from '../../host/client.js'
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

/** The code a logged-out host CLI answers with, per CLI. */
const UNAUTHENTICATED: Record<HostCli, ErrorCode> = { gh: 'GH_UNAUTHENTICATED', glab: 'GLAB_UNAUTHENTICATED' }

/**
 * Refuses a generation whose canvas could not be shared, before minutes of agent time go into
 * it: publish shares a pull request's canvas with the host CLI's login. The probe is read fresh,
 * so a login made since the page loaded counts. A login whose rights the probe cannot read (a
 * fine-grained token) is let through, as publish lets the host decide. Local reviews and a
 * project or reader with sharing off post nothing, so they need no login.
 */
export async function requireSharingLogin(ctx: AppContext, key: ReviewKey): Promise<void> {
  if (isLocalKey(key)) {
    return
  }
  const sharing = resolveSharing(ctx.projectConfig.config.sharing, await ctx.settings.read())
  if (!sharing.canvasComment) {
    return
  }
  const { host, repo } = ctx.config
  const caps = await ctx.capabilities.get({ refresh: true })
  const off = 'or turn sharing off with `canvasComment: false` in .pr-review/settings.yml'
  if (caps.login === null) {
    const { cli } = host.cli
    throw new AppError(
      UNAUTHENTICATED[cli],
      `${cli} is not logged in, so the canvas could not be shared on the ${host.nounShort}`,
      401,
      `run \`${CLI_INFO[cli].loginCommand}\` in a terminal, ${off}`
    )
  }
  if (caps.canComment === false) {
    throw new AppError(
      'COMMENT_FORBIDDEN',
      `${caps.login} cannot comment on ${repo.owner}/${repo.name}${caps.reason === undefined ? '' : `: ${caps.reason}`}`,
      403,
      `${caps.hint ?? 'log in with an account that can comment'}, ${off}`
    )
  }
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
    await requireSharingLogin(ctx, key)
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
