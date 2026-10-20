// The tour's API: the bundle the page opens with, the reader's state between visits, finishing,
// the zip a tour travels in, and the agent: the grilling and the tour's AI Chat.
import { Hono } from 'hono'
import { isThreadNameFor } from '../../chat/threads.js'
import {
  type ChatHistoryResponse,
  TourChatSendSchema,
  type TourGrillContext,
  TourGrillSendSchema,
  type TourPlace,
} from '../../contract/chat.js'
import type { ReviewKey } from '../../contract/review-key.js'
import {
  type SharedTourFetchResponse,
  TourFinishInputSchema,
  TourReaderInputSchema,
} from '../../contract/tour-api.js'
import { resolveTourBundle, tourReviewer } from '../../tour/bundle.js'
import { finishTour } from '../../tour/finish.js'
import { CANVAS_ZIP_MAX_BYTES } from '../../canvas/zip.js'
import { isLocalKey } from '../../contract/review-key.js'
import { fetchSharedTour, importTour } from '../../tour/import.js'
import { lookupTour, requireTourOf } from '../../tour/lookup.js'
import { zipStoredTour } from '../../tour/share.js'
import { readReaderState, savedReaderState, writeReaderState } from '../../tour/reader.js'
import type { PrLoader } from '../bundle.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'
import { oneAtATime } from '../one-at-a-time.js'
import { parseHeadShaQuery, parseTargetKey, readUpload, requirePrNumber } from './api.js'
import { turnResponse } from './chat-routes.js'
import { readBody } from './review-routes.js'

/** The stored tour the page is on, which must be the one a write names. */
async function tourOnScreen(
  ctx: AppContext,
  loader: PrLoader,
  key: ReturnType<typeof parseTargetKey>,
  headSha: string
) {
  const found = await lookupTour(ctx, loader, key)
  if (found.status === 'missing') {
    throw new AppError('CANVAS_NOT_FOUND', `no tour of ${String(key)}`, 404, 'generate one with /pr-tour')
  }
  if (found.headSha !== headSha) {
    throw new AppError(
      'CANVAS_STALE',
      `the tour on screen is of ${headSha.slice(0, 7)}, and this server now shows ${found.headSha.slice(0, 7)}`,
      409,
      'reload the page'
    )
  }
  return found
}

/** One finish of a tour at a time, so the record shared last holds every reader. */
const finishInTurn = oneAtATime<string>()

export function tourRoutes(ctx: AppContext, loader: PrLoader): Hono {
  const api = new Hono()

  api.get('/tours/:n', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const bundle = await resolveTourBundle(ctx, loader, key, {
      preview: c.req.query('preview') !== undefined,
      refresh: c.req.query('refresh') === '1',
      poll: c.req.query('poll') === '1',
    })
    return c.json(bundle)
  })

  // The tour on screen as a zip, or the one `headSha` names, when it is a tour of this review. A
  // local tour is exported without a number, as a local canvas is.
  api.get('/tours/:n/export', async c => {
    const key = parseTargetKey(c.req.param('n'))
    let headSha = parseHeadShaQuery(c.req.query('headSha'))
    if (headSha === undefined) {
      const found = await lookupTour(ctx, loader, key)
      if (found.status === 'missing') {
        throw new AppError('CANVAS_NOT_FOUND', `no tour of ${String(key)}`, 404, 'generate one with /pr-tour')
      }
      headSha = found.headSha
    } else {
      await requireTourOf(ctx, loader, key, headSha)
    }
    const { zip } = await zipStoredTour(ctx, headSha, isLocalKey(key) ? undefined : key)
    // The name is built from the repo slug, the PR number, and the sha, so it holds no user text.
    return new Response(new Blob([zip.bytes]), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${zip.name}"`,
      },
    })
  })

  api.post('/tours/:n/import', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'importing a shared tour')
    const { file, force } = await readUpload(c.req.raw)
    if (!(file instanceof File)) {
      throw new AppError('BAD_REQUEST', 'send the zip as the multipart field `file`', 400)
    }
    if (file.size > CANVAS_ZIP_MAX_BYTES) {
      throw new AppError('CANVAS_TOO_LARGE', `the tour zip is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`, 413)
    }
    const result = await importTour(ctx, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      prNumber: number,
      force: force === '1',
    })
    return c.json(result)
  })

  // Looks on the pull request, as it is now, for a tour someone shared, and imports the best one.
  api.post('/tours/:n/shared-tour/fetch', async c => {
    const number = requirePrNumber(parseTargetKey(c.req.param('n')), 'looking for a shared tour')
    const { pr, comments } = await loader.load(number, { refresh: true })
    const body: SharedTourFetchResponse = await fetchSharedTour(ctx, pr, comments)
    return c.json(body)
  })

  // Saved on every step, pick, and keystroke, so it asks the index alone which tour the page is on.
  api.put('/tours/:n/reader', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const input = await readBody(c.req.raw, TourReaderInputSchema, '{ "headSha": "…", "reader": { … } }')
    await requireTourOf(ctx, loader, key, input.headSha)
    // What was already finished stays finished: the page never unfinishes a tour by saving.
    const finished = (await savedReaderState(ctx, input.headSha))?.finished
    const reader = finished === undefined ? input.reader : { ...input.reader, finished }
    await writeReaderState(ctx, input.headSha, reader)
    return c.json(reader)
  })

  api.post('/tours/:n/finish', async c => {
    const key = parseTargetKey(c.req.param('n'))
    const input = await readBody(c.req.raw, TourFinishInputSchema, '{ "headSha": "…" }')
    // The tour is read inside the turn, so a finish sees the record the one before it wrote.
    const answer = await finishInTurn(input.headSha, async () => {
      const found = await tourOnScreen(ctx, loader, key, input.headSha)
      const reviewer = await tourReviewer(ctx, key, found.pr)
      const reader = await readReaderState(ctx, found.headSha, found.artifact, reviewer.author)
      return finishTour(ctx, {
        key,
        headSha: found.headSha,
        artifact: found.artifact,
        reader,
        reviewer,
        current: found.status === 'ready',
        basis: input.basis,
      })
    })
    return c.json(answer)
  })

  // The grilling: a change pick talks to the chat agent in the tour's own thread, read-only.
  const requireChat = (): void => {
    if (!ctx.projectConfig.config.chat.enabled) {
      throw new AppError(
        'NOT_FOUND',
        'chat is turned off for this repository',
        404,
        'set chat.enabled in pr-review.config.yml'
      )
    }
  }

  /**
   * A turn about the tour of `key`, read against the diff of the tour's own commit, so a stale tour
   * is talked about on the code it describes.
   */
  const tourTurn = async (
    key: ReviewKey,
    message: string,
    about: { grill: TourGrillContext } | { chat: TourPlace; thread?: string | undefined }
  ) => {
    const found = await lookupTour(ctx, loader, key)
    if (found.status === 'missing') {
      throw new AppError('CANVAS_NOT_FOUND', `no tour of ${String(key)}`, 404, 'generate one with /pr-tour')
    }
    const reviewer = await tourReviewer(ctx, key, found.pr)
    const reader = await readReaderState(ctx, found.headSha, found.artifact, reviewer.author)
    const diff = { headSha: found.headSha, mergeBaseSha: found.artifact.mergeBaseSha }
    const derived = await ctx.derived.readOrBuild(diff)
    if (derived === null) {
      throw new AppError(
        'NOT_FOUND',
        'the diff of this tour is not available locally, so the agent cannot quote it',
        404,
        'fetch the head and reload'
      )
    }
    const tour = { artifact: found.artifact, reader }
    return ctx.chat.send(
      {
        key,
        headSha: found.headSha,
        subject:
          'grill' in about
            ? { kind: 'tour', ...tour, context: about.grill }
            : { kind: 'tour-chat', ...tour, context: about.chat, thread: about.thread },
        files: derived.files,
        patches: derived.patches,
        derivedDir: ctx.derived.derivedDir(diff),
        readLines: (side, filePath, from, to) => ctx.derived.readLines(diff, side, filePath, from, to),
      },
      message
    )
  }

  api.post('/tours/:n/grill', async c => {
    requireChat()
    const key = parseTargetKey(c.req.param('n'))
    const input = await readBody(
      c.req.raw,
      TourGrillSendSchema,
      '{ "message": "…", "context": { "kind": "tour-decision", "key": "…" } }'
    )
    return turnResponse(ctx, c.req, key, await tourTurn(key, input.message, { grill: input.context }))
  })

  api.get('/tours/:n/grill/history', async c => {
    requireChat()
    return c.json(await ctx.chat.tourHistory(parseTargetKey(c.req.param('n'))))
  })

  api.post('/tours/:n/grill/cancel', async c => {
    requireChat()
    return c.json({ cancelled: await ctx.chat.cancel(parseTargetKey(c.req.param('n'))) })
  })

  // The tour's AI Chat: a thread per place of the tour, apart from the grilling's and the canvas's.
  api.post('/tours/:n/chat', async c => {
    requireChat()
    const key = parseTargetKey(c.req.param('n'))
    const input = await readBody(
      c.req.raw,
      TourChatSendSchema,
      '{ "message": "…", "context": { "kind": "tour-landmark", "id": "…" } }'
    )
    return turnResponse(
      ctx,
      c.req,
      key,
      await tourTurn(key, input.message, { chat: input.context, thread: input.thread })
    )
  })

  api.get('/tours/:n/chat/threads', async c => {
    requireChat()
    return c.json(await ctx.chat.tourThreads(parseTargetKey(c.req.param('n'))))
  })

  api.get('/tours/:n/chat/threads/:name/history', async c => {
    requireChat()
    const key = parseTargetKey(c.req.param('n'))
    const name = c.req.param('name')
    if (!isThreadNameFor(name, key)) {
      throw new AppError('NOT_FOUND', `no chat thread named ${name} on this review`, 404)
    }
    const body: ChatHistoryResponse = { name, turns: await ctx.transcripts.read(key, name) }
    return c.json(body)
  })

  api.post('/tours/:n/chat/cancel', async c => {
    requireChat()
    return c.json({ cancelled: await ctx.chat.cancel(parseTargetKey(c.req.param('n'))) })
  })

  return api
}
