// @ts-check
// The tour's requests: the bundle, the reader's state, finishing, the grilling, and AI Chat.
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */
/** @typedef {import('../contract-types.js').TourFinishResponse} TourFinishResponse */
import { fetchJson, streamEvents } from '../api.js'

/**
 * The bundle. A poll asks the server to answer from the head it last read, as the review page's
 * poll does, so waiting for a tour costs no forge call.
 * @param {string} key
 * @param {{ preview?: boolean, poll?: boolean, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<TourBundle>}
 */
export function fetchTour(key, opts = {}) {
  const params = [...(opts.preview === true ? ['preview=1'] : []), ...(opts.poll === true ? ['poll=1'] : [])]
  const query = params.length === 0 ? '' : `?${params.join('&')}`
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
 * @param {string} basis what the plan is made of, from `planBasis`
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<TourFinishResponse>}
 */
export function finishTour(key, headSha, basis, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/finish`, {
    method: 'POST',
    body: { headSha, basis },
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
  /** @type {Array<{ resolve: () => void, reject: (err: unknown) => void }>} */
  let idle = []
  /** Why the last save failed, so a caller settling on it hears, or null once one landed. */
  /** @type {unknown} */
  let failed = null
  /** The state that failed to land, sent once more when the next settle asks. */
  /** @type {TourReaderState | null} */
  let unsaved = null

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
      failed = null
      unsaved = null
    } catch (err) {
      failed = err
      unsaved = state
      opts.onError?.(err)
    } finally {
      inFlight = false
    }
    if (pending !== null) {
      void flush()
    } else {
      for (const waiter of idle) {
        if (failed === null) {
          waiter.resolve()
        } else {
          waiter.reject(failed)
        }
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
    /**
     * Sends what is pending now, or once more what failed to land, and resolves once it has.
     * Rejects when that save fails, so what follows (finishing, which reads the saved state) does
     * not go ahead on a state the server never took.
     */
    settle() {
      if (pending === null && !inFlight && unsaved !== null) {
        pending = unsaved
      }
      if (timer === null && !inFlight && pending === null) {
        return Promise.resolve()
      }
      return /** @type {Promise<void>} */ (
        new Promise((resolve, reject) => {
          idle.push({ resolve: () => resolve(undefined), reject })
          if (timer !== null) {
            clearTimeout(timer)
          }
          void flush()
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
export function streamGrill(key, input, opts) {
  return streamEvents(`/api/tours/${encodeURIComponent(key)}/grill`, input, opts)
}

/**
 * @param {string} key
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('../contract-types.js').TourChatThreadsResponse>}
 */
export function fetchTourThreads(key, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/chat/threads`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {string} key
 * @param {string} name
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('../contract-types.js').ChatHistoryResponse>}
 */
export function fetchTourThreadHistory(key, name, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/chat/threads/${encodeURIComponent(name)}/history`, {
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {string} key
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ cancelled: boolean }>}
 */
export function cancelTourChat(key, opts = {}) {
  return fetchJson(`/api/tours/${encodeURIComponent(key)}/chat/cancel`, {
    method: 'POST',
    body: {},
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * Sends one question to the tour's AI Chat and calls `onEvent` for every frame until the turn
 * ends. Rejects with an ApiError when the server refuses the question.
 * @param {string} key
 * @param {{ message: string, context: import('../contract-types.js').TourPlace, thread?: string }} input
 * @param {{ onEvent: (event: { event: string, data: unknown }) => void, signal?: AbortSignal, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<void>}
 */
export function streamTourChat(key, input, opts) {
  return streamEvents(`/api/tours/${encodeURIComponent(key)}/chat`, input, opts)
}
