// @vitest-environment node
import { BodyTooLargeError, readCappedBody, readCappedStream } from './capped-body.js'

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk)
      }
      controller.close()
    },
  })
}

describe('readCappedStream', () => {
  it('joins the chunks of a body that fits', async () => {
    const bytes = await readCappedStream(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10)
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  })

  it('reads an absent body as nothing', async () => {
    expect(Array.from(await readCappedStream(null, 10))).toEqual([])
  })

  it('stops a body that never ends instead of buffering it', async () => {
    let chunks = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++
        controller.enqueue(new Uint8Array(8))
      },
    })
    await expect(readCappedStream(stream, 10)).rejects.toBeInstanceOf(BodyTooLargeError)
    const stoppedAt = chunks
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(chunks).toBe(stoppedAt)
    expect(stoppedAt).toBeLessThan(4)
  })
})

describe('readCappedBody', () => {
  it('refuses a declared length above the cap before reading a byte', async () => {
    let read = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true
          controller.close()
        },
      },
      // Nothing is pulled until someone reads, so `read` tells whether the body was touched.
      { highWaterMark: 0 }
    )
    const message = { headers: new Headers({ 'content-length': '999' }), body }
    await expect(readCappedBody(message, 10)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(read).toBe(false)
  })

  it('reads a body whose declared length fits', async () => {
    const message = {
      headers: new Headers({ 'content-length': '2' }),
      body: streamOf(new Uint8Array([7, 8])),
    }
    expect(Array.from(await readCappedBody(message, 10))).toEqual([7, 8])
  })

  it('stops a body that lies about its length', async () => {
    const message = { headers: new Headers({ 'content-length': '1' }), body: streamOf(new Uint8Array(50)) }
    await expect(readCappedBody(message, 10)).rejects.toBeInstanceOf(BodyTooLargeError)
  })
})
