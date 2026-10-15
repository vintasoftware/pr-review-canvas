import { carriedPointLines, pointLinesInHead, stableLines, MAX_LINE_EDITS } from './point-carry.js'
import { buildHunkIndex } from '../git/patch-lines.js'
import type { FileEntry, Point } from '../contract/review-artifact.js'

const patch = '@@ -1,2 +1,2 @@\n same\n stable'
const file: FileEntry = {
  path: 'a.ts',
  key: 'a_ts',
  status: 'modified',
  additions: 0,
  deletions: 0,
  hunks: buildHunkIndex('a_ts', patch),
}
const point: Point = {
  id: 'p',
  fingerprint: 'fp',
  title: 'same',
  path: 'a.ts',
  line: 1,
  body: 'judge',
  kind: 'risk',
  level: 'check',
  audience: 'reviewer',
  origin: 'model',
}
const delta = { changed: ['a.ts'], unchanged: [], added: [], removed: [] }
const BEFORE = { headSha: 'before', mergeBaseSha: 'base' }
const AFTER = { headSha: 'after', mergeBaseSha: 'base' }
const basis = { diff: BEFORE, derived: { files: [file], patches: { a_ts: patch } } }
const head = { ...basis, diff: AFTER }

it('re-judges when an imported basis is missing files, patches, or materialized text', async () => {
  const readLines = vi.fn(async () => ['same', 'stable'])
  for (const derived of [
    { files: [], patches: {} },
    { files: [file], patches: {} },
  ]) {
    expect(await carriedPointLines({ readLines }, [point], delta, { ...basis, derived }, head)).toEqual(
      new Map()
    )
  }
  expect(await carriedPointLines({ readLines: async () => null }, [point], delta, basis, head)).toEqual(
    new Map()
  )
  expect(
    await carriedPointLines(
      { readLines: async diff => (diff === BEFORE ? ['same', 'stable'] : null) },
      [point],
      delta,
      basis,
      head
    )
  ).toEqual(new Map())
})

it('compares one side once for several points and defaults an older point to the new side', async () => {
  const readLines = vi.fn(async () => ['same', 'stable'])
  const second = { ...point, id: 'p2', line: 2 }
  const result = await carriedPointLines({ readLines }, [point, second], delta, basis, head)
  expect(result.get(point)).toEqual({ side: 'new', line: 1, endLine: 1 })
  expect(result.get(second)).toEqual({ side: 'new', line: 2, endLine: 2 })
  expect(readLines).toHaveBeenCalledTimes(2)
})

it('reads a deleted-side point using the old path of a renamed file', async () => {
  const readLines = vi.fn(async () => ['same', 'stable'])
  const renamed = { ...head, derived: { ...head.derived, files: [{ ...file, oldPath: 'old.ts' }] } }
  const old = { ...point, side: 'old' as const }
  const result = await carriedPointLines({ readLines }, [old], delta, basis, renamed)
  expect(result.get(old)).toEqual({ side: 'old', line: 1, endLine: 1 })
  expect(readLines.mock.calls).toEqual([
    [BEFORE, 'base', 'a.ts', 1, Number.MAX_SAFE_INTEGER],
    [AFTER, 'base', 'old.ts', 1, Number.MAX_SAFE_INTEGER],
  ])
})

it('re-judges a missing line, a split range, and a range outside a single head chunk', () => {
  expect(pointLinesInHead(point, 'new', new Map(), patch)).toBeNull()
  expect(
    pointLinesInHead(
      { line: 1, endLine: 2 },
      'new',
      new Map([
        [1, 1],
        [2, 3],
      ]),
      patch
    )
  ).toBeNull()
  expect(pointLinesInHead(point, 'new', new Map([[1, 8]]), patch)).toBeNull()
  expect(
    pointLinesInHead(
      { line: 1, endLine: 2 },
      'new',
      new Map([
        [1, 2],
        [2, 3],
      ]),
      patch
    )
  ).toBeNull()
  expect(
    stableLines({ lines: [], patch: '' }, { lines: Array(MAX_LINE_EDITS + 1).fill('new'), patch }, 'new')
  ).toBeNull()
})
