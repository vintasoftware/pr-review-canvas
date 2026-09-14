// @ts-check
// @vitest-environment node
import { buildHunkIndex } from '../../src/git/patch-lines.js'
import { hunkForLine, parseHunkHeader } from './hunks.js'

const PATCH = ['@@ -1,4 +1,5 @@', ' a', '+b', ' c', '@@ -10 +11,2 @@ ctx', ' x', '+y'].join('\n')

describe('parseHunkHeader', () => {
  it('reads counts and defaults a missing count to 1', () => {
    expect(parseHunkHeader('@@ -1,4 +1,5 @@')).toEqual({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 })
    expect(parseHunkHeader('@@ -10 +11,2 @@ ctx')).toEqual({ oldStart: 10, oldLines: 1, newStart: 11, newLines: 2 })
    expect(parseHunkHeader('@@ -0,0 +1,3 @@')).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 })
  })

  it('returns null for anything else', () => {
    expect(parseHunkHeader(' a')).toBeNull()
    expect(parseHunkHeader('@@ broken')).toBeNull()
  })
})

describe('hunkForLine', () => {
  const hunks = buildHunkIndex('k', PATCH)

  it('finds the hunk that covers a line on each side', () => {
    expect(hunkForLine(hunks, 'new', 5)?.id).toBe('k#1')
    expect(hunkForLine(hunks, 'new', 12)?.id).toBe('k#2')
    expect(hunkForLine(hunks, 'old', 10)?.id).toBe('k#2')
    expect(hunkForLine(hunks, 'old', 4)?.id).toBe('k#1')
  })

  it('returns null outside every hunk', () => {
    expect(hunkForLine(hunks, 'new', 6)).toBeNull()
    expect(hunkForLine(hunks, 'old', 11)).toBeNull()
  })

  it('anchors a zero-length side on its start line', () => {
    const added = buildHunkIndex('k', '@@ -0,0 +1,2 @@\n+a\n+b')
    expect(hunkForLine(added, 'old', 0)?.id).toBe('k#1')
  })
})
