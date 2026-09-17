// @ts-check
// @vitest-environment node
import { buildChunkIndex } from '../../src/git/patch-lines.js'
import { chunkForLine, chunkLineRanges, parseChunkHeader } from './chunks.js'

const PATCH = ['@@ -1,4 +1,5 @@', ' a', '+b', ' c', '@@ -10 +11,2 @@ ctx', ' x', '+y'].join('\n')

describe('parseChunkHeader', () => {
  it('reads counts and defaults a missing count to 1', () => {
    expect(parseChunkHeader('@@ -1,4 +1,5 @@')).toEqual({
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
    })
    expect(parseChunkHeader('@@ -10 +11,2 @@ ctx')).toEqual({
      oldStart: 10,
      oldLines: 1,
      newStart: 11,
      newLines: 2,
    })
    expect(parseChunkHeader('@@ -0,0 +1,3 @@')).toEqual({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 3,
    })
  })

  it('returns null for anything else', () => {
    expect(parseChunkHeader(' a')).toBeNull()
    expect(parseChunkHeader('@@ broken')).toBeNull()
  })
})

describe('chunkForLine', () => {
  const chunks = buildChunkIndex('k', PATCH)

  it('finds the chunk that covers a line on each side', () => {
    expect(chunkForLine(chunks, 'new', 5)?.id).toBe('k#1')
    expect(chunkForLine(chunks, 'new', 12)?.id).toBe('k#2')
    expect(chunkForLine(chunks, 'old', 10)?.id).toBe('k#2')
    expect(chunkForLine(chunks, 'old', 4)?.id).toBe('k#1')
  })

  it('returns null outside every chunk', () => {
    expect(chunkForLine(chunks, 'new', 6)).toBeNull()
    expect(chunkForLine(chunks, 'old', 11)).toBeNull()
  })

  it('anchors a zero-length side on its start line', () => {
    const added = buildChunkIndex('k', '@@ -0,0 +1,2 @@\n+a\n+b')
    expect(chunkForLine(added, 'old', 0)?.id).toBe('k#1')
  })
})

describe('chunkLineRanges', () => {
  it('lists separate spans and zero-length anchors on the requested side', () => {
    const chunks = [
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 },
      { oldStart: 10, oldLines: 2, newStart: 14, newLines: 0 },
    ]
    expect(chunkLineRanges(chunks, 'new')).toBe('new-side lines 1-3, 14')
    expect(chunkLineRanges(chunks, 'old')).toBe('old-side lines 0, 10-11')
    expect(chunkLineRanges([], 'old')).toBe('old-side lines none')
  })
})
