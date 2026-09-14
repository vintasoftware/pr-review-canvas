// @vitest-environment node
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { createFakeGit, makeTempDir } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, SYNTHETIC_BLOBS, SYNTHETIC_FILES } from '../testing/synthetic.js'
import { MATERIALIZE_MAX_BYTES, materialize, safeJoin } from './materialize.js'

describe('materialize', () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await makeTempDir()
  })
  afterEach(() => rm(outDir, { recursive: true, force: true }))

  it('writes head and base copies of every text file and skips binaries', async () => {
    const git = createFakeGit({ blobs: SYNTHETIC_BLOBS })
    const result = await materialize(git, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA, files: SYNTHETIC_FILES, outDir })
    expect(result).toEqual({
      written: [
        'head/src/app.ts',
        'base/src/app.ts',
        'head/src/new.ts',
        'base/src/gone.ts',
        'head/src/new-name.ts',
        'base/src/old-name.ts',
        'head/bin/run.sh',
        'base/bin/run.sh',
        'head/src/app.test.ts',
        'base/src/app.test.ts',
      ],
      skipped: [{ path: 'assets/logo.png', reason: 'binary' }],
    })
    expect(await readFile(path.join(outDir, 'head/src/new.ts'), 'utf8')).toBe(SYNTHETIC_BLOBS[`${HEAD_SHA}:src/new.ts`])
    expect(await readFile(path.join(outDir, 'base/src/old-name.ts'), 'utf8')).toBe(
      SYNTHETIC_BLOBS[`${BASE_SHA}:src/old-name.ts`]
    )
  })

  it('skips files over the size cap and files git cannot find', async () => {
    const big = 'x'.repeat(MATERIALIZE_MAX_BYTES + 1)
    const git = createFakeGit({ blobs: { [`${HEAD_SHA}:src/new.ts`]: big } })
    const files = SYNTHETIC_FILES.filter(f => f.path === 'src/new.ts' || f.path === 'src/gone.ts')
    const result = await materialize(git, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA, files, outDir })
    expect(result).toEqual({
      written: [],
      skipped: [
        { path: 'src/new.ts', reason: 'too-large' },
        { path: 'src/gone.ts', reason: 'missing' },
      ],
    })
  })

  it('reports a file whose content vanished between the size check and the read as missing', async () => {
    const git = createFakeGit({ blobs: { [`${HEAD_SHA}:src/new.ts`]: 'x' } })
    git.show = async () => null
    const files = SYNTHETIC_FILES.filter(f => f.path === 'src/new.ts')
    const result = await materialize(git, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA, files, outDir })
    expect(result).toEqual({ written: [], skipped: [{ path: 'src/new.ts', reason: 'missing' }] })
  })

  it('refuses a path that escapes the output directory', async () => {
    const git = createFakeGit({ blobs: { [`${HEAD_SHA}:../evil.ts`]: 'x' } })
    const result = await materialize(git, {
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      files: [{ path: '../evil.ts', key: '___evil_ts', status: 'added', additions: 1, deletions: 0, patch: '' }],
      outDir,
    })
    expect(result).toEqual({ written: [], skipped: [{ path: '../evil.ts', reason: 'missing' }] })
  })
})

describe('safeJoin', () => {
  it('joins inside the root and rejects traversal', () => {
    expect(safeJoin('/root', 'a/b.ts')).toBe('/root/a/b.ts')
    expect(safeJoin('/root/', 'a/b.ts')).toBe('/root/a/b.ts')
    expect(safeJoin('/root', '../b.ts')).toBeNull()
    expect(safeJoin('/root', '/etc/passwd')).toBeNull()
  })
})
