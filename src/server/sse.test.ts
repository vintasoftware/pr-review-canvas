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
      sseStream(toIterable([{ event: 'cancelled' }]), () => {
        closed += 1
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
    const stream = sseStream(iterable, () => {
      closed = true
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
    const reader = sseStream(silent, undefined, () => {
      cancelled = true
    }).getReader()
    await reader.read()
    const pending = reader.read()
    void reader.cancel()
    expect(cancelled).toBe(true)
    gate.open?.()
    await pending.catch(() => undefined)
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
