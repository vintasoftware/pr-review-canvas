// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createNdjsonSplitter, NdjsonError } from './ndjson.js'

describe('createNdjsonSplitter', () => {
  it('returns the messages a chunk completes and holds the rest back', () => {
    const splitter = createNdjsonSplitter()
    expect(splitter.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }])
    expect(splitter.push('2}\n')).toEqual([{ b: 2 }])
    expect(splitter.flush()).toEqual([])
  })

  it('reads a last message that has no newline after it', () => {
    const splitter = createNdjsonSplitter()
    expect(splitter.push('{"a":1}')).toEqual([])
    expect(splitter.flush()).toEqual([{ a: 1 }])
  })

  it('skips blank lines, which a stream can end with', () => {
    const splitter = createNdjsonSplitter()
    expect(splitter.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }])
    expect(splitter.flush()).toEqual([])
  })

  it('rejects a line that is not JSON', () => {
    const splitter = createNdjsonSplitter()
    expect(() => splitter.push('not json\n')).toThrow(NdjsonError)
    expect(() => createNdjsonSplitter().push('nope')).not.toThrow()
  })

  it('rejects a completed line over the size limit', () => {
    const splitter = createNdjsonSplitter(16)
    expect(() => splitter.push(`{"a":"${'x'.repeat(100)}"}\n`)).toThrow(/over the 16 limit/)
  })

  it('rejects a line that never ends, instead of buffering it', () => {
    const splitter = createNdjsonSplitter(16)
    expect(() => splitter.push('x'.repeat(17))).toThrow(/without ending the line/)
  })

  it('names its error code, so the route can map it', () => {
    const err = new NdjsonError('bad')
    expect(err.code).toBe('AGENT_PROTOCOL_INVALID')
  })
})
