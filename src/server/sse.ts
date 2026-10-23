// Server-sent events, written by hand: one named event per frame, JSON in the data line.
import type { ChatEvent } from '../contract/chat.js'

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  /** Nothing between the browser and this server should buffer a stream on localhost. */
  'x-accel-buffering': 'no',
} as const

/**
 * One frame. A data line cannot hold a newline, so the JSON is written as one line, which
 * `JSON.stringify` already gives.
 */
export function sseFrame(event: ChatEvent): string {
  const { event: name, ...rest } = event
  return `event: ${name}\ndata: ${JSON.stringify(rest)}\n\n`
}

export interface SseStreamOptions {
  /** Runs once when the stream ends, whichever way. */
  onClose?: () => void
  /** Runs the moment the reader goes away. */
  onCancel?: () => void
  onError?: (err: unknown) => void
  /**
   * The request's signal. It says the reader went away even when the response never started:
   * the server drops a body whose connection is already closed without cancelling it, which
   * would leave the turn waiting at its first event for good.
   */
  signal?: AbortSignal
}

/**
 * The event stream of one chat turn as a response body.
 *
 * `onCancel` runs the moment the reader goes away. Asking the iterator to return is not enough on
 * its own: an async generator queues `return()` behind a `next()` that is still waiting, so a
 * silent agent would keep running until it spoke again.
 */
export function sseStream(
  events: AsyncIterable<ChatEvent>,
  { onClose, onCancel, onError, signal }: SseStreamOptions = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = events[Symbol.asyncIterator]()
  let ended = false
  const end = (): void => {
    if (ended) {
      return
    }
    ended = true
    signal?.removeEventListener('abort', leave)
    onClose?.()
  }
  // A stream that already ended has no turn left to stop.
  function leave(): void {
    if (ended) {
      return
    }
    onCancel?.()
    void iterator.return?.(undefined)
    end()
  }
  if (signal?.aborted === true) {
    leave()
  } else {
    signal?.addEventListener('abort', leave, { once: true })
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (ended) {
        controller.close()
        return
      }
      let next: IteratorResult<ChatEvent>
      try {
        next = await iterator.next()
      } catch (err) {
        onError?.(err)
        if (!ended) {
          controller.enqueue(
            encoder.encode(
              sseFrame({
                event: 'error',
                code: 'INTERNAL',
                message: err instanceof Error ? err.message : String(err),
              })
            )
          )
          controller.close()
          end()
        }
        return
      }
      // The reader left while this event was on its way: nobody reads it.
      if (ended) {
        return
      }
      if (next.done === true) {
        controller.close()
        end()
        return
      }
      controller.enqueue(encoder.encode(sseFrame(next.value)))
    },
    cancel: leave,
  })
}
