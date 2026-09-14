// @vitest-environment node
import { buildHunkIndex, labelPatch, splitHunks } from './patch-lines.js'

const PATCH = ['@@ -1,4 +1,5 @@', ' a', '+b', ' c', '@@ -10 +11,2 @@ ctx', ' x', '+y'].join('\n')

describe('splitHunks', () => {
  it('splits a patch into hunks with their body lines', () => {
    expect(splitHunks(PATCH)).toEqual([
      { header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [' a', '+b', ' c'] },
      { header: '@@ -10 +11,2 @@ ctx', oldStart: 10, oldLines: 1, newStart: 11, newLines: 2, lines: [' x', '+y'] },
    ])
  })

  it('drops lines before the first header and handles an empty patch', () => {
    expect(splitHunks('index abc..def\n@@ -1 +1 @@\n-a\n+b')).toEqual([
      { header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ])
    expect(splitHunks('')).toEqual([])
  })
})

describe('buildHunkIndex', () => {
  it('numbers hunks from 1 per file', () => {
    expect(buildHunkIndex('k', PATCH)).toEqual([
      { id: 'k#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
      { id: 'k#2', header: '@@ -10 +11,2 @@ ctx', oldStart: 10, oldLines: 1, newStart: 11, newLines: 2 },
    ])
  })
})

describe('labelPatch', () => {
  it('puts a hunk-id line before every header so a patch file names its hunks', () => {
    expect(labelPatch('k', PATCH)).toBe(
      ['### hunk k#1', '@@ -1,4 +1,5 @@', ' a', '+b', ' c', '### hunk k#2', '@@ -10 +11,2 @@ ctx', ' x', '+y'].join(
        '\n'
      )
    )
    expect(labelPatch('k', '')).toBe('')
  })
})
