// The AI Chat pane's routes and the personal settings behind it. Every route here answers 404
// when the project config turns chat off, so a repository that does not want an agent in the
// loop has no agent surface at all.
import { Hono, type MiddlewareHandler } from 'hono'
import { ChatBusyError } from '../../chat/chat-manager.js'
import { ChatContextError } from '../../chat/context.js'
import { isThreadNameFor } from '../../chat/threads.js'
import type { ChatEvent, ChatHistoryResponse } from '../../contract/chat.js'
import { ChatSendSchema } from '../../contract/chat.js'
import type { Pr, ReviewArtifact } from '../../contract/review-artifact.js'
import type { SettingsResponse } from '../../contract/settings.js'
import { isChatAgent, SettingsInputSchema } from '../../contract/settings.js'
import { lookupCanvas } from '../../review/carry-over.js'
import type { Derived } from '../../store/derived-store.js'
import type { PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError, logRequestError } from '../errors.js'
import { SSE_HEADERS, sseStream } from '../sse.js'
import { parsePrNumber } from './api.js'

async function readJsonBody<T>(
  request: Request,
  schema: {
    safeParse: (raw: unknown) => {
      success: boolean
      data?: T
      error?: { issues: Array<{ message: string }> }
    }
  },
  expected: string
): Promise<T> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new AppError('BAD_REQUEST', `send a JSON body: ${expected}`, 400)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success || parsed.data === undefined) {
    throw new AppError('BAD_REQUEST', `send a JSON body: ${expected}`, 400, parsed.error?.issues[0]?.message)
  }
  return parsed.data
}

function settingsResponse(ctx: AppContext, settings: SettingsResponse['settings']): SettingsResponse {
  const project = ctx.projectConfig.config
  return {
    settings,
    overrides: ctx.config.chatOverrides,
    file: ctx.settings.file,
    project: {
      file: ctx.projectConfig.source,
      chatEnabled: project.chat.enabled,
      rulebook: project.rulebook ?? null,
      maxRepairRounds: project.generation.maxRepairRounds,
      inlineDiffMaxLines: project.generation.inlineDiffMaxLines,
      smallPrHunks: project.generation.smallPrHunks,
      keepForIdenticalDiff: project.canvas.keepForIdenticalDiff,
      layers: project.layers.length,
      highRisk: project.highRisk.length,
    },
  }
}

/** What the chat talks about: the canvas on screen, and the diff that canvas is shown with. */
interface ChatSubject {
  artifact: ReviewArtifact
  /** The head for a current canvas; the canvas's own commit for an outdated one, as the page shows it. */
  headSha: string
  files: Derived['files']
  patches: Derived['patches']
}

/**
 * The canvas the chat talks about. A current canvas is read with the head's diff. An outdated one
 * is still a canvas: the page shows it with the diff of its own commit, so the chat quotes that.
 */
async function subjectForChat(ctx: AppContext, number: number, pr: Pr): Promise<ChatSubject> {
  if (ctx.fixtureArtifact !== null) {
    return withDiff({ ...ctx.fixtureArtifact, pr }, pr.headSha, await ctx.derived.read(pr.headSha))
  }
  const found = await lookupCanvas(ctx, number, pr)
  const artifact = found.status === 'missing' ? null : await ctx.canvases.readArtifact(found.headSha)
  if (found.status === 'missing' || artifact === null) {
    throw new AppError(
      'CANVAS_NOT_FOUND',
      'there is no canvas for this pull request, so the chat has nothing to talk about',
      404,
      'generate a canvas for the current head first'
    )
  }
  if (found.status === 'stale') {
    const manifest = await ctx.canvases.readManifest(found.headSha)
    return withDiff(
      artifact,
      found.headSha,
      await ctx.derived.readOrBuild(found.headSha, manifest?.mergeBaseSha)
    )
  }
  return withDiff(artifact, pr.headSha, await ctx.derived.read(pr.headSha))
}

/** The subject with its diff, or the 404 that says the diff is not on this machine. */
function withDiff(artifact: ReviewArtifact, headSha: string, derived: Derived | null): ChatSubject {
  if (derived === null) {
    throw new AppError(
      'NOT_FOUND',
      'the diff of this head is not available locally, so the chat cannot quote it',
      404,
      'fetch the PR head and reload'
    )
  }
  return { artifact, headSha, files: derived.files, patches: derived.patches }
}

/** Every path this file serves, so the chat-disabled check covers all of them and nothing else. */
export const CHAT_ROUTE_PATTERNS = ['/settings', '/settings/*', '/prs/:n/chat', '/prs/:n/chat/*'] as const

export function chatRoutes(ctx: AppContext, loader: PrLoader): Hono {
  const api = new Hono()

  // With chat off, none of these routes exist. The patterns are listed rather than `*`: this
  // app is mounted at the API root, so a blanket middleware would answer for every route.
  const requireChat: MiddlewareHandler = async (_c, next) => {
    if (!ctx.projectConfig.config.chat.enabled) {
      throw new AppError(
        'NOT_FOUND',
        'chat is turned off for this repository',
        404,
        'set chat.enabled in pr-review.config.yml'
      )
    }
    await next()
  }
  for (const pattern of CHAT_ROUTE_PATTERNS) {
    api.use(pattern, requireChat)
  }

  api.get('/settings', async c => {
    await ctx.settings.ensureFile()
    return c.json(settingsResponse(ctx, await ctx.settings.read()))
  })

  api.put('/settings', async c => {
    const input = await readJsonBody(c.req.raw, SettingsInputSchema, '{ "agent": "claude", "model": null }')
    return c.json(settingsResponse(ctx, await ctx.settings.write(input)))
  })

  api.get('/settings/agents', async c =>
    c.json(await ctx.agents.list({ refresh: c.req.query('refresh') === '1' }))
  )

  api.post('/settings/agents/:id/probe', async c => {
    const id = c.req.param('id')
    if (!isChatAgent(id)) {
      throw new AppError('BAD_REQUEST', `not an agent this tool knows: ${id}`, 400)
    }
    return c.json(await ctx.agents.probe(id, { refresh: c.req.query('refresh') === '1' }))
  })

  api.get('/prs/:n/chat/threads', async c => c.json(await ctx.chat.threads(parsePrNumber(c.req.param('n')))))

  api.post('/prs/:n/chat/threads', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const thread = await ctx.chat.createThread(number)
    return c.json({ thread, ...(await ctx.chat.threads(number)) }, 201)
  })

  api.get('/prs/:n/chat/threads/:name/history', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const name = c.req.param('name')
    if (!isThreadNameFor(name, number)) {
      throw new AppError('NOT_FOUND', `no chat thread named ${name} on this pull request`, 404)
    }
    const body: ChatHistoryResponse = { name, turns: await ctx.transcripts.read(number, name) }
    return c.json(body)
  })

  api.post('/prs/:n/chat/cancel', async c => {
    const number = parsePrNumber(c.req.param('n'))
    return c.json({ cancelled: await ctx.chat.cancel(number) })
  })

  api.post('/prs/:n/chat', async c => {
    const number = parsePrNumber(c.req.param('n'))
    const input = await readJsonBody(
      c.req.raw,
      ChatSendSchema,
      '{ "message": "…", "context": { "kind": "pr" } }'
    )
    const pr = await loader.currentPr(number)
    const { artifact, headSha, files, patches } = await subjectForChat(ctx, number, pr)
    const events = ctx.chat.send(
      {
        prNumber: number,
        headSha,
        artifact,
        files,
        patches,
        derivedDir: ctx.derived.derivedDir(headSha),
        readLines: (side, filePath, from, to) => ctx.derived.readLines(headSha, side, filePath, from, to),
      },
      { message: input.message, context: input.context, thread: input.thread }
    )
    // The first event comes back before the response starts, so a refusal is a JSON envelope
    // with a status rather than an error frame inside a 200.
    const iterator = events[Symbol.asyncIterator]()
    let first: IteratorResult<ChatEvent>
    try {
      first = await iterator.next()
    } catch (err) {
      throw toChatError(err)
    }
    // A browser that goes away stops the agent; the turn is nobody's answer any more.
    return new Response(
      sseStream(
        replayFrom(first, iterator),
        undefined,
        () => {
          void ctx.chat.cancel(number)
        },
        err => logRequestError(ctx.log, c.req, err)
      ),
      { headers: SSE_HEADERS }
    )
  })

  return api
}

/**
 * The turn as a stream again, after its first event was read to see whether the route can answer
 * with a stream at all. A turn that ended on that first read is an empty stream.
 */
export function replayFrom(
  first: IteratorResult<ChatEvent>,
  rest: AsyncIterator<ChatEvent>
): AsyncIterable<ChatEvent> {
  let sent = first.done === true
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (sent) {
          return rest.next()
        }
        sent = true
        return Promise.resolve({ done: false, value: first.value })
      },
      return: async () => {
        await rest.return?.(undefined)
        return { done: true, value: undefined }
      },
    }),
  }
}

/** The status a refused turn answers with: busy, a context that does not resolve, or a failure. */
export function toChatError(err: unknown): AppError {
  if (err instanceof ChatBusyError) {
    return new AppError('CHAT_BUSY', err.message, 409, 'stop the running answer, or wait for it to finish')
  }
  if (err instanceof ChatContextError) {
    return new AppError('BAD_REQUEST', err.message, 400)
  }
  if (err instanceof AppError) return err
  const error = new AppError('INTERNAL', err instanceof Error ? err.message : String(err), 500)
  error.cause = err
  return error
}
