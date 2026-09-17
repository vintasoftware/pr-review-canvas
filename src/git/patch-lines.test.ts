// @vitest-environment node
import { buildChunkIndex, checkInlineTarget, labelPatch, splitChunks } from './patch-lines.js'

import { toFileEntry } from './diff-collector.js'
import { SYNTHETIC_FILES } from '../testing/synthetic.js'

const FILES = SYNTHETIC_FILES.map(toFileEntry)

const PATCH = ['@@ -1,4 +1,5 @@', ' a', '+b', ' c', '@@ -10 +11,2 @@ ctx', ' x', '+y'].join('\n')

describe('splitChunks', () => {
  it('splits a patch into chunks with their body lines', () => {
    expect(splitChunks(PATCH)).toEqual([
      {
        header: '@@ -1,4 +1,5 @@',
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        lines: [' a', '+b', ' c'],
      },
      {
        header: '@@ -10 +11,2 @@ ctx',
        oldStart: 10,
        oldLines: 1,
        newStart: 11,
        newLines: 2,
        lines: [' x', '+y'],
      },
    ])
  })

  it('drops lines before the first header and handles an empty patch', () => {
    expect(splitChunks('index abc..def\n@@ -1 +1 @@\n-a\n+b')).toEqual([
      { header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
    ])
    expect(splitChunks('')).toEqual([])
  })
})

describe('buildChunkIndex', () => {
  it('numbers chunks from 1 per file', () => {
    expect(buildChunkIndex('k', PATCH)).toEqual([
      { id: 'k#1', header: '@@ -1,4 +1,5 @@', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 },
      { id: 'k#2', header: '@@ -10 +11,2 @@ ctx', oldStart: 10, oldLines: 1, newStart: 11, newLines: 2 },
    ])
  })
})

describe('labelPatch', () => {
  it('puts a chunk-id line before every header so a patch file names its chunks', () => {
    expect(labelPatch('k', PATCH)).toBe(
      [
        '### chunk k#1',
        '@@ -1,4 +1,5 @@',
        ' a',
        '+b',
        ' c',
        '### chunk k#2',
        '@@ -10 +11,2 @@ ctx',
        ' x',
        '+y',
      ].join('\n')
    )
    expect(labelPatch('k', '')).toBe('')
  })
})

describe('checkInlineTarget', () => {
  it('accepts a line inside a chunk on the new side', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 4, side: 'new' })).toBeNull()
  })

  it('accepts a range inside one chunk and refuses one that leaves it', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 4, side: 'new', startLine: 2 })).toBeNull()
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 12, side: 'new', startLine: 4 })).toBe(
      'src/app.ts:4-12 (new) spans more than one chunk'
    )
  })

  it('refuses a range whose first line comes after its last', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 3, side: 'new', startLine: 4 })).toBe(
      'the first line of the range must come before 3'
    )
  })

  it('refuses a file that is not in the diff and a line outside every chunk', () => {
    expect(checkInlineTarget(FILES, { path: 'src/nope.ts', line: 1, side: 'new' })).toBe(
      'src/nope.ts is not in the diff'
    )
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 400, side: 'new' })).toBe(
      'src/app.ts:400 (new) is not in the diff'
    )
  })
})
