// Reading a request or response body under a size limit. Both the attachment download and the
// canvas upload go through this, so a body that never ends, or one that lies about its length,
// stops at the limit instead of growing without bound.

/** The bytes of the body. Throws BodyTooLargeError as soon as it grows past `cap`. */
export async function readCappedStream(
  body: ReadableStream<Uint8Array> | null,
  cap: number
): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) {
    return new Uint8Array(0)
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.length
      if (total > cap) {
        throw new BodyTooLargeError(cap)
      }
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export class BodyTooLargeError extends Error {
  readonly cap: number
  constructor(cap: number) {
    super(`the body is larger than ${cap} bytes`)
    this.name = 'BodyTooLargeError'
    this.cap = cap
  }
}

/**
 * The body of one HTTP message under a cap. A `Content-Length` above the cap is refused before a
 * byte is read; a body that lies about its length is stopped mid-stream.
 */
export async function readCappedBody(
  message: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  cap: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(message.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) {
    throw new BodyTooLargeError(cap)
  }
  return readCappedStream(message.body, cap)
}
