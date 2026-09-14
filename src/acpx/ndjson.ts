/**
 * Splits a byte stream into JSON lines. acpx writes one JSON-RPC message per line, so a line
 * that never ends, or one too long to be a message, is a protocol failure rather than something
 * to buffer without limit.
 */

/** A single ACP message is small; anything past this is not one. */
export const NDJSON_LINE_MAX = 1024 * 1024

export class NdjsonError extends Error {
  readonly code = 'AGENT_PROTOCOL_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'NdjsonError'
  }
}

export interface NdjsonSplitter {
  /** The messages completed by this chunk, in order. */
  push(chunk: string): unknown[]
  /** The last message when the stream ended without a newline. */
  flush(): unknown[]
}

/**
 * `JSON.parse` is one of the two places this package casts: what comes back is unknown, and the
 * caller validates it.
 */
function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw new NdjsonError(`the agent wrote a line that is not JSON (${line.length} characters)`)
  }
}

export function createNdjsonSplitter(lineMax: number = NDJSON_LINE_MAX): NdjsonSplitter {
  let buffer = ''
  const take = (raw: string): unknown[] => {
    const line = raw.trim()
    return line === '' ? [] : [parseLine(line)]
  }
  return {
    push(chunk) {
      buffer += chunk
      const out: unknown[] = []
      let at = buffer.indexOf('\n')
      while (at !== -1) {
        const raw = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (raw.length > lineMax) {
          throw new NdjsonError(`the agent wrote a line of ${raw.length} characters, over the ${lineMax} limit`)
        }
        out.push(...take(raw))
        at = buffer.indexOf('\n')
      }
      if (buffer.length > lineMax) {
        throw new NdjsonError(`the agent wrote over ${lineMax} characters without ending the line`)
      }
      return out
    },
    flush() {
      const rest = buffer
      buffer = ''
      return take(rest)
    },
  }
}
