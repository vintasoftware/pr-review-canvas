// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '../contract/chat.js'
import { sseFrame, sseStream } from './sse.js'

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      return text
    }
    text += decoder.decode(value)
  }
}

describe('sseFrame', () => {
  it('names the event and puts the rest of it on one data line', () => {
    expect(sseFrame({ event: 'chunk', text: 'a\nb' })).toBe('event: chunk\ndata: {"text":"a\\nb"}\n\n')
    expect(sseFrame({ event: 'cancelled' })).toBe('event: cancelled\ndata: {}\n\n')
  })
})

describe('sseStream', () => {
  it('writes one frame per event and then closes', async () => {
    const events: ChatEvent[] = [
      { event: 'turn', thread: 't1', agent: 'claude', seeded: true },
      { event: 'chunk', text: 'Yes.' },
      { event: 'done', stopReason: 'end_turn' },
    ]
    const text = await drain(sseStream(toIterable(events)))
    expect(text).toBe(
      'event: turn\ndata: {"thread":"t1","agent":"claude","seeded":true}\n\n' +
        'event: chunk\ndata: {"text":"Yes."}\n\n' +
        'event: done\ndata: {"stopReason":"end_turn"}\n\n'
    )
  })

  it('turns a failure mid-stream into an error frame rather than a broken body', async () => {
    const failing: AsyncIterable<ChatEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { event: 'chunk', text: 'a' } as ChatEvent
        throw new Error('the agent died')
      },
    }
    const text = await drain(sseStream(failing))
    expect(text).toContain('event: chunk')
    expect(text).toContain('event: error\ndata: {"code":"INTERNAL","message":"the agent died"}')
  })

  it('reports a thrown value that is not an Error by its text', async () => {
    const failing: AsyncIterable<ChatEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject('the runner exited') }),
    }
    const text = await drain(sseStream(failing))
    expect(text).toContain('event: error\ndata: {"code":"INTERNAL","message":"the runner exited"}')
  })

  it('tells the caller when the stream ends, once', async () => {
    let closed = 0
    await drain(
      sseStream(toIterable([{ event: 'cancelled' }]), {
        onClose: () => {
          closed += 1
        },
      })
    )
    expect(closed).toBe(1)
  })

  it('stops the turn when the reader goes away', async () => {
    let returned = false
    let closed = false
    const iterable: AsyncIterable<ChatEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: { event: 'chunk', text: 'a' } }),
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }),
    }
    const stream = sseStream(iterable, {
      onClose: () => {
        closed = true
      },
    })
    const reader = stream.getReader()
    await reader.read()
    await reader.cancel()
    expect(returned).toBe(true)
    expect(closed).toBe(true)
  })

  it('says so at once when the reader goes away while the agent is silent', async () => {
    let cancelled = false
    /** @see silent — held so the generator can be let go after the reader has gone. */
    const gate: { open: (() => void) | null } = { open: null }
    // An async generator queues `return()` behind the `next()` it is suspended in, so a silent
    // agent would keep running if the stream only asked the iterator to return.
    const silent: AsyncIterable<ChatEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { event: 'turn', thread: 't1', agent: 'claude', seeded: true } as ChatEvent
        await new Promise<void>(resolve => {
          gate.open = resolve
        })
        yield { event: 'chunk', text: 'late' } as ChatEvent
      },
    }
    const reader = sseStream(silent, {
      onCancel: () => {
        cancelled = true
      },
    }).getReader()
    await reader.read()
    const pending = reader.read()
    void reader.cancel()
    expect(cancelled).toBe(true)
    gate.open?.()
    await pending.catch(() => undefined)
  })
})

describe('sseStream with the request signal', () => {
  /** A turn that waits at its first event until it is told to return. */
  function waiting(log: string[]): AsyncIterable<ChatEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({
          done: false,
          value: { event: 'turn', thread: 't1', agent: 'claude', seeded: true },
        }),
        return: async () => {
          log.push('return')
          return { done: true, value: undefined }
        },
      }),
    }
  }

  it('stops the turn when the reader left before anything was read', () => {
    const log: string[] = []
    const left = new AbortController()
    left.abort()
    sseStream(waiting(log), {
      onCancel: () => log.push('cancel'),
      onClose: () => log.push('close'),
      signal: left.signal,
    })
    expect(log).toEqual(['cancel', 'return', 'close'])
  })

  it('stops the turn when the request is aborted while nobody reads the body', () => {
    const log: string[] = []
    const left = new AbortController()
    sseStream(waiting(log), { onCancel: () => log.push('cancel'), signal: left.signal })
    expect(log).toEqual([])
    left.abort()
    left.abort()
    expect(log).toEqual(['cancel', 'return'])
  })

  it('does not stop anything once the stream has ended', async () => {
    const left = new AbortController()
    let cancelled = 0
    await drain(
      sseStream(toIterable([{ event: 'cancelled' }]), {
        onCancel: () => {
          cancelled += 1
        },
        signal: left.signal,
      })
    )
    left.abort()
    expect(cancelled).toBe(0)
  })

  it('stops the turn once when the body is cancelled after the request was aborted', async () => {
    const log: string[] = []
    const left = new AbortController()
    const reader = sseStream(waiting(log), {
      onCancel: () => log.push('cancel'),
      signal: left.signal,
    }).getReader()
    left.abort()
    await reader.cancel()
    expect(log).toEqual(['cancel', 'return'])
  })

  it('writes nothing that arrives after the reader left, an event or a failure', async () => {
    for (const late of ['event', 'failure'] as const) {
      let settle: { resolve: (r: IteratorResult<ChatEvent>) => void; reject: (e: unknown) => void } | null =
        null
      let asked = (): void => undefined
      const nextAsked = new Promise<void>(resolve => {
        asked = resolve
      })
      const turn: AsyncIterable<ChatEvent> = {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<ChatEvent>>((resolve, reject) => {
              settle = { resolve, reject }
              asked()
            }),
        }),
      }
      const errors: unknown[] = []
      const left = new AbortController()
      const reader = sseStream(turn, { onError: err => errors.push(err), signal: left.signal }).getReader()
      const read = reader.read()
      await nextAsked
      left.abort()
      if (late === 'event') {
        settle!.resolve({ done: false, value: { event: 'chunk', text: 'late' } })
      } else {
        settle!.reject(new Error('late'))
      }
      // Let the late step land, then let go: a frame written for it would be what the read gets.
      await new Promise(resolve => setTimeout(resolve, 0))
      await reader.cancel()
      expect(await read).toEqual({ done: true, value: undefined })
      expect(errors).toHaveLength(late === 'failure' ? 1 : 0)
    }
  })
})

function toIterable(events: ChatEvent[]): AsyncIterable<ChatEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
  }
}
