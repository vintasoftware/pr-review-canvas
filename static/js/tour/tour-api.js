// @ts-check
// The tour's three requests: the bundle, the reader's state, and finishing.
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */
/** @typedef {import('../contract-types.js').TourFinishResponse} TourFinishResponse */
import { ApiError, fetchJson, readSseFrames } from '../api.js'

/**
 * @param {string} key
 * @param {{ preview?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<TourBundle>}
 */
export function fetchTour(key, opts = {}) {
  const query = opts.preview === true ? '?preview=1' : ''
  return fetchJson(`/api/tours/${encodeURIComponent(key)}${query}`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {string} key
 * @param {string} headSha
 * @param {TourReaderState} reader
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<TourReaderState>}
 */
export function saveReader(key, headSha, reader, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/reader`, {
    method: 'PUT',
    body: { headSha, reader },
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {string} key
 * @param {string} headSha
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<TourFinishResponse>}
 */
export function finishTour(key, headSha, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/finish`, {
    method: 'POST',
    body: { headSha },
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * Saves the reader's state at most once every `delayMs`, and never two at once: a save that lands
 * while one is in flight goes out after it, with the latest state. Failures go to `onError`.
 * @param {(reader: TourReaderState) => Promise<unknown>} save
 * @param {{ delayMs?: number, onError?: (err: unknown) => void, setTimeoutImpl?: typeof setTimeout }} [opts]
 */
export function createSaver(save, opts = {}) {
  const delay = opts.delayMs ?? 250
  const later = opts.setTimeoutImpl ?? setTimeout
  /** @type {TourReaderState | null} */
  let pending = null
  let inFlight = false
  let timer = /** @type {ReturnType<typeof setTimeout> | null} */ (null)
  /** @type {Array<() => void>} */
  let idle = []

  async function flush() {
    timer = null
    if (inFlight || pending === null) {
      return
    }
    const state = pending
    pending = null
    inFlight = true
    try {
      await save(state)
    } catch (err) {
      opts.onError?.(err)
    } finally {
      inFlight = false
    }
    if (pending !== null) {
      void flush()
    } else {
      for (const resolve of idle) {
        resolve()
      }
      idle = []
    }
  }

  return {
    /** @param {TourReaderState} reader */
    push(reader) {
      pending = reader
      if (timer === null) {
        timer = later(() => void flush(), delay)
      }
    },
    /** Resolves once nothing is pending or in flight; sends what is pending now. */
    settle() {
      if (timer === null && !inFlight && pending === null) {
        return Promise.resolve()
      }
      return /** @type {Promise<void>} */ (
        new Promise(resolve => {
          idle.push(() => resolve(undefined))
          if (timer !== null) {
            clearTimeout(timer)
            void flush()
          }
        })
      )
    },
  }
}

/**
 * @param {string} key
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('../contract-types.js').ChatHistoryResponse>}
 */
export function fetchGrillHistory(key, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/grill/history`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {string} key
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ cancelled: boolean }>}
 */
export function cancelGrill(key, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/grill/cancel`, {
    method: 'POST',
    body: {},
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * Sends one grilling message and calls `onEvent` for every frame until the turn ends. Rejects
 * with an ApiError when the server refuses the message.
 * @param {string} key
 * @param {{ message: string, context: import('../contract-types.js').TourGrillContext }} input
 * @param {{ onEvent: (event: { event: string, data: unknown }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<void>}
 */
export async function streamGrill(key, input, opts) {
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
  const res = await doFetch(`/api/tours/${encodeURIComponent(key)}/grill`, init)
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

/**
 * @param {unknown} body
 * @returns {body is import('../contract-types.js').ErrorEnvelope}
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
