// @ts-check
// @vitest-environment node
import {
  ApiError,
  cancelChat,
  createThread,
  fetchAgents,
  fetchBundle,
  fetchCapabilities,
  fetchJson,
  fetchPatches,
  fetchReviewBody,
  fetchSettings,
  fetchState,
  fetchThreadHistory,
  fetchThreads,
  pollBundle,
  postComment,
  postReview,
  probeAgent,
  putDismissed,
  putReviewed,
  putThreadHidden,
  readSseFrames,
  saveAppearance,
  saveSettings,
  streamChat,
} from './api.js'

/**
 * @param {number} status
 * @param {unknown} body
 * @param {{ text?: boolean }} [opts]
 */
function fakeFetch(status, body, opts = {}) {
  const calls = /** @type {Array<{ url: string, init: RequestInit | undefined }>} */ ([])
  /** @type {typeof fetch} */
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    return new Response(opts.text ? String(body) : JSON.stringify(body), {
      status,
      statusText: status === 500 ? 'Internal Server Error' : 'OK',
      headers: { 'content-type': opts.text ? 'text/plain' : 'application/json' },
    })
  }
  return { impl, calls }
}

describe('fetchJson', () => {
  it('returns the parsed body and sends JSON bodies with the right headers', async () => {
    const f = fakeFetch(200, { ok: true })
    expect(await fetchJson('/x', { method: 'PUT', body: { a: 1 }, fetchImpl: f.impl })).toEqual({ ok: true })
    expect(f.calls[0]?.init).toEqual({
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"a":1}',
    })
  })

  it('throws ApiError from the envelope, or INTERNAL for a non-JSON failure', async () => {
    const env = fakeFetch(404, { error: { code: 'PR_NOT_FOUND', message: 'nope', hint: 'check' } })
    const err = await fetchJson('/x', { fetchImpl: env.impl }).catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'PR_NOT_FOUND', message: 'nope', hint: 'check', status: 404 })
    const plain = fakeFetch(500, 'boom', { text: true })
    const err2 = await fetchJson('/x', { fetchImpl: plain.impl }).catch(e => e)
    expect(err2).toMatchObject({ code: 'INTERNAL', message: '500 Internal Server Error', status: 500 })
  })

  it('uses the global fetch when none is given', async () => {
    const f = fakeFetch(200, { hi: 1 })
    vi.stubGlobal('fetch', f.impl)
    expect(await fetchJson('/y')).toEqual({ hi: 1 })
    vi.unstubAllGlobals()
  })

  it('builds the bundle and patches urls', async () => {
    const f = fakeFetch(200, {})
    await fetchBundle(42, { fetchImpl: f.impl })
    await fetchBundle(42, { refresh: true, fetchImpl: f.impl })
    await fetchPatches(42, { fetchImpl: f.impl })
    await fetchPatches(42, { headSha: 'abc', fetchImpl: f.impl })
    expect(f.calls.map(c => c.url)).toEqual([
      '/api/prs/42',
      '/api/prs/42?refresh=1',
      '/api/prs/42/patches',
      '/api/prs/42/patches?headSha=abc',
    ])
  })
})

describe('pollBundle', () => {
  /** @param {ReadonlyArray<{ status: number, body: unknown }>} answers */
  function sequence(answers) {
    let i = 0
    const urls = /** @type {string[]} */ ([])
    /** @type {typeof fetch} */
    const impl = async url => {
      urls.push(String(url))
      const a = answers[Math.min(i++, answers.length - 1)] ?? { status: 500, body: null }
      return new Response(JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json' },
      })
    }
    return { impl, urls }
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('polls every 5 s while missing, reports each bundle, and stops on ready', async () => {
    const f = sequence([
      { status: 200, body: { status: 'missing' } },
      { status: 200, body: { status: 'missing' } },
      { status: 200, body: { status: 'ready' } },
    ])
    const seen = /** @type {string[]} */ ([])
    pollBundle(7, { fetchImpl: f.impl, onBundle: b => seen.push(b.status) })
    expect(f.urls).toEqual([])
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.urls).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(f.urls).toEqual(['/api/prs/7'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.urls).toEqual(['/api/prs/7', '/api/prs/7', '/api/prs/7'])
    expect(seen).toEqual(['missing', 'missing', 'ready'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(f.urls.length).toBe(3)
  })

  it('slows from 5 s to 15 s once the wait passes five minutes', async () => {
    const f = sequence([{ status: 200, body: { status: 'missing' } }])
    let clock = 0
    pollBundle(7, { fetchImpl: f.impl, now: () => clock })
    // Five minutes of five-second polls: 60 requests, the last one at 300 s.
    for (let i = 0; i < 60; i++) {
      clock += 5000
      await vi.advanceTimersByTimeAsync(5000)
    }
    expect(f.urls.length).toBe(60)
    // From here each gap is 15 s, so 14 s more brings nothing and the next second brings one.
    clock += 14_000
    await vi.advanceTimersByTimeAsync(14_000)
    expect(f.urls.length).toBe(60)
    clock += 1000
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.urls.length).toBe(61)
  })

  it('never polls faster after the slow-down than the interval it was given', async () => {
    const f = sequence([{ status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } }])
    let clock = 0
    pollBundle(7, { fetchImpl: f.impl, intervalMs: 30_000, slowAfterMs: 0, now: () => clock })
    clock += 15_000
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.urls.length).toBe(0)
    clock += 15_000
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.urls.length).toBe(1)
  })

  it('keeps polling after a failed request and reports the error', async () => {
    const f = sequence([
      { status: 500, body: { error: { code: 'INTERNAL', message: 'boom' } } },
      { status: 200, body: { status: 'ready' } },
    ])
    const errors = /** @type {unknown[]} */ ([])
    const seen = /** @type {string[]} */ ([])
    pollBundle(7, {
      fetchImpl: f.impl,
      intervalMs: 100,
      onError: e => errors.push(e),
      onBundle: b => seen.push(b.status),
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(ApiError)
    expect(seen).toEqual(['ready'])
  })

  it('stops when asked, before or during a request, and honors a custom until', async () => {
    const f = sequence([{ status: 200, body: { status: 'ready', canvas: { headSha: 'a' } } }])
    const seen = /** @type {unknown[]} */ ([])
    const early = pollBundle(7, { fetchImpl: f.impl, intervalMs: 100, onBundle: b => seen.push(b) })
    early.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.urls).toEqual([])
    const custom = pollBundle(7, {
      fetchImpl: f.impl,
      intervalMs: 100,
      until: b => b.canvas?.headSha === 'b',
      onBundle: b => seen.push(b.status),
    })
    await vi.advanceTimersByTimeAsync(250)
    custom.stop()
    expect(seen).toEqual(['ready', 'ready'])
    // Stopping while a request is in flight drops its result.
    let resolve = /** @type {((r: Response) => void) | null} */ (null)
    const hanging = pollBundle(7, {
      fetchImpl: () => new Promise(r => (resolve = r)),
      intervalMs: 100,
      onBundle: b => seen.push(b.status),
    })
    await vi.advanceTimersByTimeAsync(100)
    hanging.stop()
    resolve?.(new Response(JSON.stringify({ status: 'ready' }), { status: 200 }))
    await vi.advanceTimersByTimeAsync(10)
    expect(seen).toEqual(['ready', 'ready'])
    // A stop during a failed request stops the retry too.
    const failing = pollBundle(7, {
      fetchImpl: () => new Promise(r => (resolve = r)),
      intervalMs: 100,
      onError: e => seen.push(e),
    })
    await vi.advanceTimersByTimeAsync(100)
    failing.stop()
    resolve?.(new Response('nope', { status: 500 }))
    await vi.advanceTimersByTimeAsync(300)
    expect(seen).toEqual(['ready', 'ready'])
  })
})

describe('the review routes', () => {
  it('builds the url, the method, and the body of every state call', async () => {
    const f = fakeFetch(200, { prNumber: 42, state: {} })
    await fetchState(42, { fetchImpl: f.impl })
    await putReviewed(42, 'layer:layer-1/file:src_app_ts', true, { fetchImpl: f.impl })
    await putDismissed(42, 'fp/1', true, { fetchImpl: f.impl })
    await putDismissed(42, 'fp-2', false, { reason: 'fine', fetchImpl: f.impl })
    await putThreadHidden(42, 1001, true, { fetchImpl: f.impl })
    expect(f.calls.map(c => [c.init?.method, c.url])).toEqual([
      ['GET', '/api/prs/42/state'],
      ['PUT', '/api/prs/42/reviewed/layer:layer-1/file:src_app_ts'],
      ['PUT', '/api/prs/42/points/fp%2F1/dismissed'],
      ['PUT', '/api/prs/42/points/fp-2/dismissed'],
      ['PUT', '/api/prs/42/threads/1001/hidden'],
    ])
    expect(f.calls.map(c => c.init?.body)).toEqual([
      undefined,
      '{"reviewed":true}',
      '{"dismissed":true}',
      '{"dismissed":false,"reason":"fine"}',
      '{"hidden":true}',
    ])
  })

  it('asks for the capabilities, the review body, and posts comments and reviews', async () => {
    const f = fakeFetch(200, {})
    await fetchCapabilities(42, { fetchImpl: f.impl })
    await fetchCapabilities(42, { refresh: true, fetchImpl: f.impl })
    await fetchReviewBody(42, { fetchImpl: f.impl })
    await postComment(42, { kind: 'issue', body: 'x' }, { fetchImpl: f.impl })
    await postReview(42, { event: 'APPROVE' }, { fetchImpl: f.impl })
    expect(f.calls.map(c => [c.init?.method, c.url])).toEqual([
      ['GET', '/api/prs/42/capabilities'],
      ['GET', '/api/prs/42/capabilities?refresh=1'],
      ['GET', '/api/prs/42/review/body'],
      ['POST', '/api/prs/42/comments'],
      ['POST', '/api/prs/42/review'],
    ])
    expect(f.calls.at(-1)?.init?.body).toBe('{"event":"APPROVE"}')
  })

  it('passes the server refusal on as an ApiError', async () => {
    const f = fakeFetch(409, {
      error: { code: 'SIGNOFF_INCOMPLETE', message: '1 layer is not reviewed yet' },
    })
    await expect(postReview(42, { event: 'APPROVE' }, { fetchImpl: f.impl })).rejects.toMatchObject({
      code: 'SIGNOFF_INCOMPLETE',
      status: 409,
    })
  })
})

describe('saveAppearance', () => {
  it("puts the skin and the theme on their own route, and uses the page's fetch when none is given", async () => {
    const f = fakeFetch(200, { skin: 'github', theme: 'auto' })
    expect(await saveAppearance({ skin: 'github' }, { fetchImpl: f.impl })).toEqual({
      skin: 'github',
      theme: 'auto',
    })
    expect(f.calls[0]?.url).toBe('/api/appearance')
    expect(f.calls[0]?.init?.method).toBe('PUT')
    expect(f.calls[0]?.init?.body).toBe('{"skin":"github"}')
    await saveAppearance({ theme: 'dark' }, { fetchImpl: f.impl })
    expect(f.calls[1]?.init?.body).toBe('{"theme":"dark"}')

    const global = fakeFetch(200, { skin: 'terminal', theme: 'light' })
    vi.stubGlobal('fetch', global.impl)
    try {
      expect(await saveAppearance({ skin: 'terminal', theme: 'light' })).toEqual({
        skin: 'terminal',
        theme: 'light',
      })
      expect(global.calls[0]?.url).toBe('/api/appearance')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the AI Chat routes', () => {
  it('calls the thread, settings, and agent routes with the right method', async () => {
    const f = fakeFetch(200, {})
    await fetchThreads(42, { fetchImpl: f.impl })
    await createThread(42, { fetchImpl: f.impl })
    await fetchThreadHistory(42, 'pr-review-a-b-42-claude-t1', { fetchImpl: f.impl })
    await cancelChat(42, { fetchImpl: f.impl })
    await fetchSettings({ fetchImpl: f.impl })
    await saveSettings({ agent: 'codex' }, { fetchImpl: f.impl })
    await fetchAgents({ fetchImpl: f.impl })
    await probeAgent('claude', { fetchImpl: f.impl })
    expect(f.calls.map(c => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
      'GET /api/prs/42/chat/threads',
      'POST /api/prs/42/chat/threads',
      'GET /api/prs/42/chat/threads/pr-review-a-b-42-claude-t1/history',
      'POST /api/prs/42/chat/cancel',
      'GET /api/settings',
      'PUT /api/settings',
      'GET /api/settings/agents',
      'POST /api/settings/agents/claude/probe',
    ])
  })

  it('escapes a thread name and an agent id in the URL', async () => {
    const f = fakeFetch(200, {})
    await fetchThreadHistory(42, 'a/b', { fetchImpl: f.impl })
    await probeAgent('a b', { fetchImpl: f.impl })
    expect(f.calls[0]?.url).toBe('/api/prs/42/chat/threads/a%2Fb/history')
    expect(f.calls[1]?.url).toBe('/api/settings/agents/a%20b/probe')
  })
})

describe('readSseFrames', () => {
  it('reads whole frames and keeps a half-written one for the next chunk', () => {
    const first = readSseFrames('', 'event: chunk\ndata: {"text":"a"}\n\nevent: chun')
    expect(first.events).toEqual([{ event: 'chunk', data: { text: 'a' } }])
    const second = readSseFrames(first.buffer, 'k\ndata: {"text":"b"}\n\n')
    expect(second.events).toEqual([{ event: 'chunk', data: { text: 'b' } }])
    expect(second.buffer).toBe('')
  })

  it('reads CRLF frames, a frame with no event name, and skips one with no data', () => {
    expect(readSseFrames('', 'data: {"a":1}\r\n\r\n').events).toEqual([{ event: 'message', data: { a: 1 } }])
    expect(readSseFrames('', ': keep-alive\n\n').events).toEqual([])
  })

  it('reports a data line that is not JSON as a frame with no data', () => {
    expect(readSseFrames('', 'event: chunk\ndata: nope\n\n').events).toEqual([{ event: 'chunk', data: null }])
  })
})

describe('streamChat', () => {
  /** @param {string[]} chunks */
  function streamOf(chunks) {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const c of chunks) {
          controller.enqueue(encoder.encode(c))
        }
        controller.close()
      },
    })
  }

  it('calls back for every frame of the turn', async () => {
    /** @type {Array<{ event: string, data: unknown }>} */
    const seen = []
    /** @type {typeof fetch} */
    const impl = async () =>
      new Response(
        streamOf([
          'event: chunk\ndata: {"text":"a"}\n\n',
          'event: done\ndata: {"stopReason":"end_turn"}\n\n',
        ]),
        {
          status: 200,
        }
      )
    await streamChat(
      42,
      { message: 'x', context: { kind: 'pr' } },
      { onEvent: e => seen.push(e), fetchImpl: impl }
    )
    expect(seen).toEqual([
      { event: 'chunk', data: { text: 'a' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ])
  })

  it('passes the abort signal on', async () => {
    /** @type {RequestInit | undefined} */
    let init
    /** @type {typeof fetch} */
    const impl = async (_url, got) => {
      init = got
      return new Response(streamOf([]), { status: 200 })
    }
    const controller = new AbortController()
    await streamChat(
      42,
      { message: 'x', context: { kind: 'pr' }, thread: 't' },
      { onEvent: () => undefined, signal: controller.signal, fetchImpl: impl }
    )
    expect(init?.signal).toBe(controller.signal)
    expect(String(init?.body)).toContain('"thread":"t"')
  })

  it('throws the server envelope when the turn is refused', async () => {
    /** @type {typeof fetch} */
    const impl = async () =>
      new Response(JSON.stringify({ error: { code: 'CHAT_BUSY', message: 'busy' } }), { status: 409 })
    const err = await streamChat(
      42,
      { message: 'x', context: { kind: 'pr' } },
      { onEvent: () => undefined, fetchImpl: impl }
    ).catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('CHAT_BUSY')
  })

  it('throws an internal error when the refusal is not an envelope', async () => {
    /** @type {typeof fetch} */
    const impl = async () => new Response('nope', { status: 500 })
    const err = await streamChat(
      42,
      { message: 'x', context: { kind: 'pr' } },
      { onEvent: () => undefined, fetchImpl: impl }
    ).catch(e => e)
    expect(err.code).toBe('INTERNAL')
  })

  it('ends quietly when the answer has no body', async () => {
    /** @type {typeof fetch} */
    const impl = async () => new Response(null, { status: 204 })
    await expect(
      streamChat(42, { message: 'x', context: { kind: 'pr' } }, { onEvent: () => undefined, fetchImpl: impl })
    ).resolves.toBeUndefined()
  })
})

it('pins reviewed-state writes to the selected canvas commit', async () => {
  const f = fakeFetch(200, {})
  await putReviewed(42, 'layer:1', true, { headSha: 'abc123', fetchImpl: f.impl })
  expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ reviewed: true, headSha: 'abc123' })
})

it('streams chat using the browser fetch when no override is supplied', async () => {
  const impl = vi.fn().mockResolvedValue(new Response('event: done\ndata: {"ok":true}\n\n'))
  vi.stubGlobal('fetch', impl)
  try {
    const onEvent = vi.fn()
    await streamChat(42, { message: 'hello', context: { kind: 'pr' } }, { onEvent })
    expect(impl).toHaveBeenCalledTimes(1)
    expect(onEvent).toHaveBeenCalledWith({ event: 'done', data: { ok: true } })
  } finally {
    vi.unstubAllGlobals()
  }
})
