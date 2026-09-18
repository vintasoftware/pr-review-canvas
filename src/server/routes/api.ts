import { Hono } from 'hono'
import { z } from 'zod'
import { buildCanvasZipFor } from '../../canvas/export.js'
import { importCanvas } from '../../canvas/import.js'
import { CANVAS_ZIP_MAX_BYTES } from '../../canvas/zip.js'
import type {
  ContextResponse,
  HealthResponse,
  PatchesResponse,
  SharedCanvasFetchResponse,
} from '../../contract/api.js'
import { isLocalKey, parseReviewKey, type ReviewKey } from '../../contract/review-key.js'
import { AppearanceInputSchema, type AppearanceResponse } from '../../contract/settings.js'
import { publicHost } from '../../host/host.js'
import { lookupCanvas } from '../../review/carry-over.js'
import { createPrLoader, resolveBundle, resolveLocalBundle, runDiscovery } from '../bundle.js'
import { BodyTooLargeError, readCappedBody } from '../capped-body.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { chatRoutes } from './chat-routes.js'
import { reviewRoutes } from './review-routes.js'

/** The target a route's `:n` names: a pull request number, or `local` for work with no PR yet. */
export function parseTargetKey(raw: string): ReviewKey {
  const key = parseReviewKey(raw)
  if (key === null) {
    throw new AppError(
      'BAD_REQUEST',
      `not a review target: ${raw}`,
      400,
      'use a PR number, `branch`, or `uncommitted`'
    )
  }
  return key
}

/**
 * The pull request behind a key, for the routes that talk to the forge. Local work has none, and
 * saying so is better than letting the call fail somewhere inside the host client.
 */
export function requirePrNumber(key: ReviewKey, what: string): number {
  if (isLocalKey(key)) {
    throw new AppError(
      'BAD_REQUEST',
      `${what} needs a pull request, and this canvas describes work that has none yet`,
      400,
      'open the pull request, then review it at /review/<number>'
    )
  }
  return key
}

const ContextQuerySchema = z.object({
  path: z.string().min(1),
  side: z.enum(['new', 'old']),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
})

export const CONTEXT_MAX_LINES = 500

const SHA_RE = /^[0-9a-f]{40}$/

/** The multipart envelope of a 20 MB zip, with room for the field headers. */
export const MAX_UPLOAD_BYTES = CANVAS_ZIP_MAX_BYTES + 64 * 1024

/**
 * The multipart form of an upload, read under the cap first. Parsing is done on the bytes we
 * already hold, so a request that never declares its length cannot buffer without limit.
 */
async function readUpload(request: Request): Promise<{ file: unknown; force: unknown }> {
  let body: Uint8Array<ArrayBuffer>
  try {
    body = await readCappedBody(request, MAX_UPLOAD_BYTES)
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      throw new AppError('CANVAS_TOO_LARGE', 'the upload is larger than the canvas size limit', 413)
    }
    throw err
  }
  const contentType = request.headers.get('content-type')
  if (contentType === null || !contentType.startsWith('multipart/form-data')) {
    throw new AppError('BAD_REQUEST', 'send the zip as multipart/form-data', 400)
  }
  const form = await new Response(new Blob([body]), { headers: { 'content-type': contentType } }).formData()
  return { file: form.get('file'), force: form.get('force') }
}

function parseHeadShaQuery(raw: string | undefined): string | undefined {
  if (raw !== undefined && !SHA_RE.test(raw)) {
    throw new AppError('BAD_REQUEST', 'headSha must be a 40-character lowercase hex sha', 400)
  }
  return raw
}

/** The canvas the page is showing: the one for the head, else the stale one it fell back to. */
async function currentCanvasSha(
  ctx: AppContext,
  loader: ReturnType<typeof createPrLoader>,
  key: ReviewKey
): Promise<string> {
  const pr = await loader.currentTarget(key)
  const found = isLocalKey(key)
    ? await ctx.canvases.findForLocal(key, pr.headSha)
    : await lookupCanvas(ctx, key, pr)
  if (found.status === 'missing') {
    throw new AppError('CANVAS_NOT_FOUND', `no canvas for ${String(key)}`, 404, 'generate one first')
  }
  return found.headSha
}

export function apiRoutes(ctx: AppContext): Hono {
  const api = new Hono()
  const loader = createPrLoader(ctx)
  api.route('/', reviewRoutes(ctx, loader))
  api.route('/', chatRoutes(ctx, loader))

  // How the page is painted. It lives in the same settings file the chat settings do, but on its
  // own route, because a repository with chat off still has a page to paint.
  const appearanceOf = (settings: {
    skin: AppearanceResponse['skin']
    theme: AppearanceResponse['theme']
  }) => ({
    skin: settings.skin,
    theme: settings.theme,
  })

  api.get('/appearance', async c => {
    const body: AppearanceResponse = appearanceOf(await ctx.settings.read())
    return c.json(body)
  })

  api.put('/appearance', async c => {
    const expected = 'send a JSON body: { "skin": "github", "theme": "dark" }'
    let raw: unknown
    try {
      raw = await c.req.raw.json()
    } catch {
      throw new AppError('BAD_REQUEST', expected, 400)
    }
    const parsed = AppearanceInputSchema.safeParse(raw)
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', expected, 400, parsed.error.issues[0]?.message)
    }
    const body: AppearanceResponse = appearanceOf(await ctx.settings.write(parsed.data))
    return c.json(body)
  })

  api.get('/health', async c => {
    const chatEnabled = ctx.projectConfig.config.chat.enabled
    const [gitCheck, ghStatus, acpx, agents] = await Promise.all([
      ctx.git
        .topLevel()
        .then(() => ({ ok: true }))
        .catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) })),
      ctx.gh.authStatus(),
      chatEnabled ? ctx.preflight.get() : Promise.resolve({ installed: false, version: null }),
      chatEnabled ? ctx.agents.list() : Promise.resolve(null),
    ])
    const settings = chatEnabled ? await ctx.chat.effectiveSettings() : null
    const active = settings === null ? null : (agents?.agents.find(a => a.id === settings.agent) ?? null)
    const body: HealthResponse = {
      ok: gitCheck.ok && ghStatus.installed && ghStatus.authenticated,
      version: ctx.version,
      checks: {
        git: gitCheck,
        origin: { ok: true, detail: `${ctx.config.repo.owner}/${ctx.config.repo.name}` },
        gh: ghStatus.installed ? { ok: true } : { ok: false, detail: ghStatus.detail },
        ghAuth: ghStatus.authenticated ? { ok: true } : { ok: false, detail: ghStatus.detail },
        ...(chatEnabled
          ? {
              acpx: acpx.installed
                ? { ok: true, detail: acpx.version ?? '' }
                : { ok: false, detail: 'acpx is not on PATH' },
              agentInstalled: {
                ok: active?.installed === true,
                ...(active?.reason === undefined ? {} : { detail: active.reason }),
              },
              agentAuth: { ok: active?.authenticated === true },
            }
          : {}),
      },
      repo: ctx.config.repo,
      host: publicHost(ctx.config.host),
      dataDir: ctx.config.dataDir,
      chat: {
        enabled: chatEnabled,
        acpx: acpx.installed,
        ...(settings === null ? {} : { agent: settings.agent, model: settings.model }),
      },
    }
    return c.json(body)
  })

  api.get('/prs/:n', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const opts = { refresh: c.req.query('refresh') === '1' }
    const bundle = isLocalKey(key)
      ? await resolveLocalBundle(ctx, key, opts)
      : await resolveBundle(ctx, loader, key, opts)
    return c.json(bundle)
  })

  api.get('/prs/:n/patches', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const pr = await loader.currentTarget(key)
    const headSha = parseHeadShaQuery(c.req.query('headSha')) ?? pr.headSha
    // Only the target's own head has a merge base to build from; any other sha the page names is
    // an older canvas, whose diffs were written when that canvas was drawn.
    const derived = await ctx.derived.readOrBuild(
      headSha,
      headSha === pr.headSha ? pr.mergeBaseSha : undefined
    )
    if (derived === null) {
      throw new AppError(
        'NOT_FOUND',
        'diffs for this head are not available locally',
        404,
        'fetch the PR head and reload'
      )
    }
    const body: PatchesResponse = { headSha, patches: derived.patches }
    return c.json(body)
  })

  api.get('/prs/:n/comments', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'reading comments')
    const { comments } = await loader.refreshComments(number)
    return c.json(comments)
  })

  api.get('/prs/:n/context', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const parsed = ContextQuerySchema.safeParse(c.req.query())
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'context needs path, side (new|old), from, to', 400)
    }
    const q = parsed.data
    if (q.to < q.from || q.to - q.from + 1 > CONTEXT_MAX_LINES) {
      throw new AppError('BAD_REQUEST', `request between 1 and ${CONTEXT_MAX_LINES} lines`, 400)
    }
    const pr = await loader.currentTarget(key)
    const lines = await ctx.derived.readLines(
      pr.headSha,
      q.side === 'new' ? 'head' : 'base',
      q.path,
      q.from,
      q.to
    )
    if (lines === null) {
      throw new AppError('NOT_FOUND', `${q.path} is not materialized for this head`, 404)
    }
    const body: ContextResponse = {
      path: q.path,
      side: q.side,
      from: q.from,
      to: q.from + lines.length - 1,
      lines,
    }
    return c.json(body)
  })

  api.get('/prs/:n/export', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const requested = parseHeadShaQuery(c.req.query('headSha'))
    const headSha = requested ?? (await currentCanvasSha(ctx, loader, key))
    // A local canvas is exported without a number, which is what makes it importable on the
    // pull request once that exists.
    const zip = await buildCanvasZipFor(ctx, headSha, isLocalKey(key) ? undefined : key)
    // The name is built from the repo slug, the PR number, and the sha, so it holds no user text.
    return new Response(new Blob([zip.bytes]), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${zip.name}"`,
      },
    })
  })

  api.post('/prs/:n/import', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'importing a shared canvas')
    const { file, force } = await readUpload(c.req.raw)
    if (!(file instanceof File)) {
      throw new AppError('BAD_REQUEST', 'send the zip as the multipart field `file`', 400)
    }
    if (file.size > CANVAS_ZIP_MAX_BYTES) {
      throw new AppError(
        'CANVAS_TOO_LARGE',
        `the canvas zip is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`,
        413
      )
    }
    const result = await importCanvas(ctx, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      prNumber: number,
      currentHead: await loader.currentPr(number),
      force: force === '1',
    })
    return c.json(result)
  })

  api.post('/prs/:n/shared-canvas/fetch', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'looking for a shared canvas')
    // Looking again means looking at the pull request as it is now, not at the cached copy.
    const { pr, comments } = await loader.load(number, { refresh: true })
    const discovery = await runDiscovery(ctx, pr, comments, { refresh: true })
    const found = await lookupCanvas(ctx, number, pr)
    const body: SharedCanvasFetchResponse = {
      imported: discovery.imported,
      status: found.status,
      sharedCanvas: discovery.sharedCanvas,
      warnings: discovery.warnings,
    }
    return c.json(body)
  })

  return api
}
