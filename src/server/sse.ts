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

/**
 * The event stream of one chat turn as a response body.
 *
 * `onCancel` runs the moment the reader goes away. Asking the iterator to return is not enough on
 * its own: an async generator queues `return()` behind a `next()` that is still waiting, so a
 * silent agent would keep running until it spoke again.
 */
export function sseStream(
  events: AsyncIterable<ChatEvent>,
  onClose?: () => void,
  onCancel?: () => void,
  onError?: (err: unknown) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const iterator = events[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: IteratorResult<ChatEvent>
      try {
        next = await iterator.next()
      } catch (err) {
        onError?.(err)
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
        onClose?.()
        return
      }
      if (next.done === true) {
        controller.close()
        onClose?.()
        return
      }
      controller.enqueue(encoder.encode(sseFrame(next.value)))
    },
    cancel() {
      onCancel?.()
      void iterator.return?.(undefined)
      onClose?.()
    },
  })
}
