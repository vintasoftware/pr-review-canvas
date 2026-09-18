// @ts-check
/** @typedef {import('./contract-types.js').ErrorEnvelope} ErrorEnvelope */
/** @typedef {import('./contract-types.js').ReviewKey} ReviewKey */
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').PatchesResponse} PatchesResponse */

/** The server's error envelope as a thrown value. */
export class ApiError extends Error {
  /**
   * @param {ErrorEnvelope['error']} error
   * @param {number} status
   */
  constructor(error, status) {
    super(error.message)
    this.name = 'ApiError'
    /** @type {ErrorEnvelope['error']['code']} */
    this.code = error.code
    /** @type {string | undefined} */
    this.hint = error.hint
    /** @type {number} */
    this.status = status
  }
}

/**
 * @param {unknown} body
 * @returns {body is ErrorEnvelope}
 */
function isEnvelope(body) {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'code' in body.error
  )
}

/**
 * GET/PUT/POST JSON. Non-2xx answers with the envelope become ApiError; anything else INTERNAL.
 * @template T
 * @param {string} url
 * @param {{ method?: string, body?: unknown, fetchImpl?: typeof fetch | undefined }} [opts]
 * @returns {Promise<T>}
 */
export async function fetchJson(url, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch
  /** @type {RequestInit} */
  const init = { method: opts.method ?? 'GET', headers: { accept: 'application/json' } }
  if (opts.body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' }
    init.body = JSON.stringify(opts.body)
  }
  const res = await doFetch(url, init)
  /** @type {unknown} */
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (!res.ok) {
    if (isEnvelope(body)) {
      throw new ApiError(body.error, res.status)
    }
    throw new ApiError({ code: 'INTERNAL', message: `${res.status} ${res.statusText}` }, res.status)
  }
  return /** @type {T} */ (body)
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ refresh?: boolean, fetchImpl?: typeof fetch | undefined }} [opts]
 * @returns {Promise<PrBundle>}
 */
export function fetchBundle(prNumber, opts = {}) {
  const q = opts.refresh ? '?refresh=1' : ''
  return fetchJson(`/api/prs/${prNumber}${q}`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ headSha?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<PatchesResponse>}
 */
export function fetchPatches(prNumber, opts = {}) {
  const q = opts.headSha ? `?headSha=${encodeURIComponent(opts.headSha)}` : ''
  return fetchJson(`/api/prs/${prNumber}/patches${q}`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').StateResponse>}
 */
export function fetchState(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/state`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {string} id `layer:<id>` or `layer:<id>/file:<key>`
 * @param {boolean} reviewed
 * @param {{ headSha?: string, canvasSha?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').StateResponse>}
 */
export function putReviewed(prNumber, id, reviewed, opts = {}) {
  const body = {
    reviewed,
    ...(opts.headSha === undefined ? {} : { headSha: opts.headSha }),
    ...(opts.canvasSha === undefined ? {} : { canvasSha: opts.canvasSha }),
  }
  return fetchJson(`/api/prs/${prNumber}/reviewed/${id}`, {
    method: 'PUT',
    body,
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {string} fingerprint
 * @param {boolean} dismissed
 * @param {{ reason?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').StateResponse>}
 */
export function putDismissed(prNumber, fingerprint, dismissed, opts = {}) {
  const body = opts.reason === undefined ? { dismissed } : { dismissed, reason: opts.reason }
  return fetchJson(`/api/prs/${prNumber}/points/${encodeURIComponent(fingerprint)}/dismissed`, {
    method: 'PUT',
    body,
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {number} rootCommentId
 * @param {boolean} hidden
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').StateResponse>}
 */
export function putThreadHidden(prNumber, rootCommentId, hidden, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/threads/${rootCommentId}/hidden`, {
    method: 'PUT',
    body: { hidden },
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ refresh?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').Capabilities>}
 */
export function fetchCapabilities(prNumber, opts = {}) {
  const q = opts.refresh ? '?refresh=1' : ''
  return fetchJson(`/api/prs/${prNumber}/capabilities${q}`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {import('./contract-types.js').PostCommentInput} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').PostCommentResponse>}
 */
export function postComment(prNumber, input, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/comments`, {
    method: 'POST',
    body: input,
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').ReviewBodyResponse>}
 */
export function fetchReviewBody(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/review/body`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ event: 'APPROVE' | 'REQUEST_CHANGES', body?: string, headSha?: string }} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').PostReviewResponse>}
 */
export function postReview(prNumber, input, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/review`, { method: 'POST', body: input, fetchImpl: opts.fetchImpl })
}

/** A canvas takes minutes to generate, so the page stops asking every five seconds after a while. */
export const POLL_INTERVAL_MS = 5000
export const POLL_SLOW_AFTER_MS = 5 * 60 * 1000
export const POLL_SLOW_INTERVAL_MS = 15_000

/**
 * @typedef {{
 *   intervalMs?: number,
 *   slowAfterMs?: number,
 *   slowIntervalMs?: number,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch | undefined,
 *   until?: (bundle: PrBundle) => boolean,
 *   onBundle?: (bundle: PrBundle) => void,
 *   onError?: (err: unknown) => void,
 * }} PollOptions
 */

/**
 * Re-fetches the bundle every 5 s until `until` says so (default: `ready`) or `stop()` is called.
 * After five minutes of waiting the gap grows to 15 s, because a generation that has not finished
 * by then takes minutes more. A failed poll is reported and polling goes on; the page never
 * blocks on it.
 * @param {ReviewKey} prNumber
 * @param {PollOptions} [opts]
 * @returns {{ stop: () => void }}
 */
export function pollBundle(prNumber, opts = {}) {
  const interval = opts.intervalMs ?? POLL_INTERVAL_MS
  const slowAfter = opts.slowAfterMs ?? POLL_SLOW_AFTER_MS
  const slowInterval = opts.slowIntervalMs ?? POLL_SLOW_INTERVAL_MS
  const now = opts.now ?? (() => Date.now())
  const startedAt = now()
  const nextGap = () => (now() - startedAt >= slowAfter ? Math.max(interval, slowInterval) : interval)
  const until = opts.until ?? (b => b.status === 'ready')
  let stopped = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  const tick = async () => {
    timer = null
    /** @type {PrBundle} */
    let bundle
    try {
      bundle = await fetchBundle(prNumber, { fetchImpl: opts.fetchImpl })
    } catch (err) {
      if (!stopped) {
        opts.onError?.(err)
        timer = setTimeout(tick, nextGap())
      }
      return
    }
    if (stopped) {
      return
    }
    if (until(bundle)) {
      stopped = true
    } else {
      timer = setTimeout(tick, nextGap())
    }
    opts.onBundle?.(bundle)
  }
  timer = setTimeout(tick, interval)
  return {
    stop: () => {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

/**
 * A multipart POST through XHR, so the drop zone can show upload progress. The response is the
 * server's JSON, and a non-2xx answer becomes the same ApiError as fetchJson's.
 * @template T
 * @param {string} url
 * @param {FormData} form
 * @param {{ onProgress?: (fraction: number) => void, xhrImpl?: () => XMLHttpRequest }} [opts]
 * @returns {Promise<T>}
 */
export function uploadForm(url, form, opts = {}) {
  const xhr = opts.xhrImpl ? opts.xhrImpl() : new XMLHttpRequest()
  return new Promise((resolve, reject) => {
    xhr.open('POST', url)
    xhr.setRequestHeader('accept', 'application/json')
    const onProgress = opts.onProgress
    if (onProgress !== undefined) {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total)
        }
      }
    }
    xhr.onerror = () => reject(new ApiError({ code: 'INTERNAL', message: 'the upload failed' }, 0))
    xhr.onload = () => {
      /** @type {unknown} */
      let body = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        body = null
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(/** @type {T} */ (body))
        return
      }
      reject(
        isEnvelope(body)
          ? new ApiError(body.error, xhr.status)
          : new ApiError({ code: 'INTERNAL', message: `${xhr.status} ${xhr.statusText}` }, xhr.status)
      )
    }
    xhr.send(form)
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {File} file
 * @param {{ force?: boolean, onProgress?: (fraction: number) => void, xhrImpl?: () => XMLHttpRequest }} [opts]
 * @returns {Promise<import('./contract-types.js').ImportResult>}
 */
export function importCanvas(prNumber, file, opts = {}) {
  const form = new FormData()
  form.append('file', file)
  if (opts.force) {
    form.append('force', '1')
  }
  return uploadForm(`/api/prs/${prNumber}/import`, form, opts)
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').SharedCanvasFetchResponse>}
 */
export function fetchSharedCanvas(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/shared-canvas/fetch`, { method: 'POST', fetchImpl: opts.fetchImpl })
}

/**
 * The zip as a blob plus the name the server chose, ready to hand to the browser.
 * @param {ReviewKey} prNumber
 * @param {{ headSha?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ blob: Blob, filename: string }>}
 */
export async function fetchCanvasZip(prNumber, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch
  const q = opts.headSha ? `?headSha=${encodeURIComponent(opts.headSha)}` : ''
  const res = await doFetch(`/api/prs/${prNumber}/export${q}`, { headers: { accept: 'application/zip' } })
  if (!res.ok) {
    /** @type {unknown} */
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    throw isEnvelope(body)
      ? new ApiError(body.error, res.status)
      : new ApiError({ code: 'INTERNAL', message: `${res.status} ${res.statusText}` }, res.status)
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get('content-disposition')) }
}

/**
 * @param {string | null} header
 * @returns {string}
 */
export function filenameFromDisposition(header) {
  const m = header === null ? null : /filename="([^"]+)"/.exec(header)
  return m?.[1] ?? 'pr-review-canvas.zip'
}

/* ---- The look of the page ---- */

/**
 * Saves the skin, the theme, or both. Its own route, so it works in a repository with chat off.
 * @param {import('./contract-types.js').AppearanceInput} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').AppearanceResponse>}
 */
export function saveAppearance(input, opts = {}) {
  return fetchJson('/api/appearance', { method: 'PUT', body: input, fetchImpl: opts.fetchImpl })
}

/* ---- AI Chat and its settings ---- */

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').ChatThreadsResponse>}
 */
export function fetchThreads(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/chat/threads`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').ChatThreadsResponse>}
 */
export function createThread(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/chat/threads`, {
    method: 'POST',
    body: {},
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').ChatHistoryResponse>}
 */
export function fetchThreadHistory(prNumber, name, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/chat/threads/${encodeURIComponent(name)}/history`, {
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ cancelled: boolean }>}
 */
export function cancelChat(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/chat/cancel`, {
    method: 'POST',
    body: {},
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').SettingsResponse>}
 */
export function fetchSettings(opts = {}) {
  return fetchJson('/api/settings', { fetchImpl: opts.fetchImpl })
}

/**
 * @param {import('./contract-types.js').SettingsInput} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').SettingsResponse>}
 */
export function saveSettings(input, opts = {}) {
  return fetchJson('/api/settings', { method: 'PUT', body: input, fetchImpl: opts.fetchImpl })
}

/**
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').AgentsResponse>}
 */
export function fetchAgents(opts = {}) {
  return fetchJson('/api/settings/agents', { fetchImpl: opts.fetchImpl })
}

/**
 * @param {string} id
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./contract-types.js').AgentProbeResult>}
 */
export function probeAgent(id, opts = {}) {
  return fetchJson(`/api/settings/agents/${encodeURIComponent(id)}/probe`, {
    method: 'POST',
    body: {},
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * Reads an `event:`/`data:` stream into named events. A frame the server did not finish writing
 * stays in the buffer until its blank line arrives.
 * @param {string} buffer what is left over from the last chunk
 * @param {string} chunk
 * @returns {{ events: Array<{ event: string, data: unknown }>, buffer: string }}
 */
export function readSseFrames(buffer, chunk) {
  const text = `${buffer}${chunk}`.replace(/\r\n/g, '\n')
  const parts = text.split('\n\n')
  const rest = parts.pop() ?? ''
  /** @type {Array<{ event: string, data: unknown }>} */
  const events = []
  for (const frame of parts) {
    let name = 'message'
    /** @type {string[]} */
    const data = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        name = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trim())
      }
    }
    if (data.length === 0) {
      continue
    }
    try {
      events.push({ event: name, data: JSON.parse(data.join('\n')) })
    } catch {
      events.push({ event: name, data: null })
    }
  }
  return { events, buffer: rest }
}

/**
 * Sends one chat message and calls `onEvent` for every frame until the turn ends. Rejects with
 * an ApiError when the server refuses the message (a busy chat, a context it cannot resolve).
 * @param {ReviewKey} prNumber
 * @param {{ message: string, context: import('./chat-context.js').ChatContext, thread?: string }} input
 * @param {{
 *   onEvent: (event: { event: string, data: unknown }) => void,
 *   signal?: AbortSignal,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<void>}
 */
export async function streamChat(prNumber, input, opts) {
  const doFetch = opts.fetchImpl ?? fetch
  /** @type {RequestInit} */
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
  }
  if (opts.signal !== undefined) {
    init.signal = opts.signal
  }
  const res = await doFetch(`/api/prs/${prNumber}/chat`, init)
  if (!res.ok) {
    /** @type {unknown} */
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    throw isEnvelope(body)
      ? new ApiError(body.error, res.status)
      : new ApiError({ code: 'INTERNAL', message: `${res.status} ${res.statusText}` }, res.status)
  }
  const reader = res.body?.getReader()
  if (reader === undefined) {
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    const read = readSseFrames(buffer, decoder.decode(value, { stream: true }))
    buffer = read.buffer
    for (const event of read.events) {
      opts.onEvent(event)
    }
  }
}
