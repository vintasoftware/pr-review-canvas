// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildHunkIndex, labelPatch, splitHunks } from '../git/patch-lines.js'
import { excerptHunk, HunkNotFound, tourChunk } from './hunk.js'

const PATCH = [
  '@@ -10,6 +10,7 @@ function run() {',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' const d = 5',
  ' const e = 6',
  ' return a',
  '\\ No newline at end of file',
].join('\n')

describe('excerptHunk', () => {
  const hunk = splitHunks(PATCH)[0]!

  it('gives the whole hunk as the patch has it', () => {
    expect(excerptHunk(hunk)).toBe(PATCH)
  })

  it('keeps the lines of a new-side range, the deletions among them, and a header that counts them', () => {
    // New lines 11-12 are the two added lines; the deleted old line 11 sits at new line 11.
    expect(excerptHunk(hunk, { from: 11, to: 12 })).toBe(
      ['@@ -11,1 +11,2 @@ function run() {', '-const b = 2', '+const b = 3', '+const c = 4'].join('\n')
    )
    expect(excerptHunk(hunk, { from: 13, to: 15 })).toBe(
      [
        '@@ -12,3 +13,3 @@ function run() {',
        ' const d = 5',
        ' const e = 6',
        ' return a',
        '\\ No newline at end of file',
      ].join('\n')
    )
  })

  it('keeps nothing for a range outside the hunk', () => {
    expect(excerptHunk(hunk, { from: 40, to: 50 })).toBeNull()
  })

  it('starts the old side of an added file at 0, not before it', () => {
    const added = splitHunks('@@ -0,0 +1,4 @@\n+one\n+two\n+three\n+four')[0]!
    expect(excerptHunk(added, { from: 2, to: 3 })).toBe('@@ -0,0 +2,2 @@\n+two\n+three')
  })
})

describe('tourChunk', () => {
  async function prepared() {
    const patches = await mkdtemp(path.join(tmpdir(), 'pr-review-hunk-'))
    await writeFile(path.join(patches, 'src_app_ts.diff'), `${labelPatch('src_app_ts', PATCH)}\n`)
    return {
      files: [
        {
          path: 'src/app.ts',
          key: 'src_app_ts',
          status: 'modified' as const,
          additions: 2,
          deletions: 1,
          hunks: buildHunkIndex('src_app_ts', PATCH),
        },
      ],
      paths: { head: '', base: '', patches, model: '' },
    }
  }

  it('reads the hunk from the labeled patch and names its file', async () => {
    const context = await prepared()
    expect(await tourChunk(context, 'src_app_ts#1')).toEqual({ path: 'src/app.ts', diff: PATCH })
    expect((await tourChunk(context, 'src_app_ts#1', { from: 13, to: 13 })).diff).toBe(
      '@@ -12,1 +13,1 @@ function run() {\n const d = 5'
    )
  })

  it('says which hunks exist and which lines a hunk covers', async () => {
    const context = await prepared()
    await expect(tourChunk(context, 'src_app_ts#9')).rejects.toThrow(HunkNotFound)
    await expect(tourChunk(context, 'src_app_ts#1', { from: 40, to: 50 })).rejects.toThrow(
      'hunk src_app_ts#1 has no new-side line in 40–50; it covers 10–16'
    )
  })
})
