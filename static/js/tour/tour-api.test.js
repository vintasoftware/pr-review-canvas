// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freshReaderState } from '../../../src/contract/tour-api.js'
import {
  cancelGrill,
  cancelTourChat,
  createSaver,
  fetchTour,
  fetchTourThreadHistory,
  finishTour,
  markTourThreadUnseen,
  saveReader,
  streamTourChat,
} from './tour-api.js'

/** @param {unknown} body */
function fakeFetch(body) {
  /** @type {Array<{ url: string, init: RequestInit | undefined }>} */
  const calls = []
  const impl = /** @type {typeof fetch} */ (
    async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
  )
  return { impl, calls }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the tour requests', () => {
  it('build their urls and bodies', async () => {
    const f = fakeFetch({ ok: true })
    await fetchTour('42', { fetchImpl: f.impl })
    await fetchTour('branch', { preview: true, fetchImpl: f.impl })
    const reader = freshReaderState()
    await saveReader('42', 'a'.repeat(40), reader, { fetchImpl: f.impl })
    await finishTour('42', 'a'.repeat(40), '{"picks":[]}', { fetchImpl: f.impl })
    expect(f.calls.map(c => [c.url, c.init?.method ?? 'GET'])).toEqual([
      ['/api/tours/42', 'GET'],
      ['/api/tours/branch?preview=1', 'GET'],
      ['/api/tours/42/reader', 'PUT'],
      ['/api/tours/42/finish', 'POST'],
    ])
    expect(JSON.parse(String(f.calls[2]?.init?.body))).toEqual({ headSha: 'a'.repeat(40), reader })
    expect(JSON.parse(String(f.calls[3]?.init?.body))).toEqual({
      headSha: 'a'.repeat(40),
      basis: '{"picks":[]}',
    })
  })

  it('reach the grilling and AI Chat routes the way the page calls them', async () => {
    const f = fakeFetch({ ok: true })
    vi.stubGlobal('fetch', f.impl)
    await cancelGrill('42')
    await fetchTourThreadHistory('42', 'why b?')
    await markTourThreadUnseen('42', 'why b?', 2)
    await cancelTourChat('branch')
    expect(f.calls.map(c => [c.url, c.init?.method ?? 'GET', c.init?.body ?? null])).toEqual([
      ['/api/tours/42/grill/cancel', 'POST', '{}'],
      ['/api/tours/42/chat/threads/why%20b%3F/history', 'GET', null],
      ['/api/tours/42/chat/threads/why%20b%3F/unseen', 'PUT', '{"unseen":2}'],
      ['/api/tours/branch/chat/cancel', 'POST', '{}'],
    ])
    // A question streams its answer back frame by frame.
    /** @type {Array<{ url: string, body: unknown }>} */
    const asked = []
    vi.stubGlobal(
      'fetch',
      /** @type {typeof fetch} */ (
        async (url, init) => {
          asked.push({ url: String(url), body: JSON.parse(String(init?.body)) })
          return new Response('event: chunk\ndata: {"text":"Because."}\n\nevent: done\ndata: {}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
      )
    )
    /** @type {Array<{ event: string, data: unknown }>} */
    const events = []
    const input = { message: 'why?', context: /** @type {const} */ ({ kind: 'tour' }), thread: 't1' }
    await streamTourChat('42', input, { onEvent: e => events.push(e) })
    expect(asked).toEqual([{ url: '/api/tours/42/chat', body: input }])
    expect(events).toEqual([
      { event: 'chunk', data: { text: 'Because.' } },
      { event: 'done', data: {} },
    ])
  })
})

describe('createSaver', () => {
  it('sends the latest state once per delay, never two at once, and reports a failure', async () => {
    vi.useFakeTimers()
    /** @type {Array<import('../contract-types.js').TourReaderState>} */
    const sent = []
    /** @type {Array<() => void>} */
    const release = []
    const save = vi.fn(
      /** @param {import('../contract-types.js').TourReaderState} reader */
      reader =>
        new Promise(resolve => {
          sent.push(reader)
          release.push(() => resolve(undefined))
        })
    )
    const onError = vi.fn()
    const saver = createSaver(save, { delayMs: 100, onError })
    saver.push({ ...freshReaderState(), step: 1 })
    saver.push({ ...freshReaderState(), step: 2 })
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(sent.map(r => r.step)).toEqual([2])
    // A push while the save is in flight waits for it, then goes out with the latest state.
    saver.push({ ...freshReaderState(), step: 3 })
    saver.push({ ...freshReaderState(), step: 4 })
    await vi.advanceTimersByTimeAsync(100)
    expect(sent.map(r => r.step)).toEqual([2])
    release[0]?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(r => r.step)).toEqual([2, 4])
    release[1]?.()
    await vi.advanceTimersByTimeAsync(0)
    // settle sends what is pending now and resolves once it landed.
    saver.push({ ...freshReaderState(), step: 5 })
    const settled = saver.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map(r => r.step)).toEqual([2, 4, 5])
    release[2]?.()
    await settled
    await expect(saver.settle()).resolves.toBeUndefined()
    // Settling while a save is in flight, with nothing queued, waits for it.
    saver.push({ ...freshReaderState(), step: 6 })
    await vi.advanceTimersByTimeAsync(100)
    const waited = saver.settle()
    release[3]?.()
    await waited
    expect(sent.map(r => r.step)).toEqual([2, 4, 5, 6])
    expect(onError).not.toHaveBeenCalled()
  })

  it('tells the caller when a save fails and keeps going', async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    let fail = true
    const save = vi.fn(async () => {
      if (fail) {
        throw new Error('offline')
      }
    })
    const saver = createSaver(save, { onError })
    saver.push(freshReaderState())
    await vi.advanceTimersByTimeAsync(250)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'offline' }))
    // Settling sends the failed state once more and says so when it fails again, so finishing
    // does not go ahead on a state the server lacks; once it lands, settling is quiet.
    await expect(saver.settle()).rejects.toThrow('offline')
    expect(save).toHaveBeenCalledTimes(2)
    fail = false
    await expect(saver.settle()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(3)
    saver.push(freshReaderState())
    await vi.advanceTimersByTimeAsync(250)
    expect(save).toHaveBeenCalledTimes(4)
    await expect(saver.settle()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(4)
  })
})
