// @vitest-environment node
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { emptyComments } from '../contract/comments.js'
import { emptyState } from '../contract/state.js'
import { createFakeGit, makeTempDir, TEST_REPO } from '../testing/fakes.js'
import {
  BASE_SHA,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { isNotFound, readJson, readText, writeJsonAtomic, writeTextAtomic } from './atomic-json.js'
import { createCanvasStore } from './canvas-store.js'
import { ensureDataDir, repoDir, resolveDataDir } from './data-dir.js'
import { createDerivedStore } from './derived-store.js'
import { createPrStore } from './pr-store.js'
import { createStateStore } from './state-store.js'

const now = () => new Date('2026-09-10T12:00:00.000Z')

let dir: string
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('atomic-json', () => {
  it('writes JSON with a trailing newline through a temp file and reads it back', async () => {
    const file = path.join(dir, 'nested', 'x.json')
    await writeJsonAtomic(file, { a: 1 })
    expect(await readFile(file, 'utf8')).toBe('{\n  "a": 1\n}\n')
    expect(await readJson(file, z.object({ a: z.number() }))).toEqual({ a: 1 })
    expect(await readJson(path.join(dir, 'missing.json'), z.any())).toBeNull()
    await writeTextAtomic(path.join(dir, 't.txt'), 'hi')
    expect(await readText(path.join(dir, 't.txt'))).toBe('hi')
    expect(await readText(path.join(dir, 'nope.txt'))).toBeNull()
  })

  it('throws on invalid content and on non-ENOENT errors', async () => {
    const file = path.join(dir, 'bad.json')
    await writeFile(file, '{"a":"x"}')
    await expect(readJson(file, z.object({ a: z.number() }))).rejects.toThrow()
    await mkdir(path.join(dir, 'adir'))
    await expect(readJson(path.join(dir, 'adir'), z.any())).rejects.toThrow()
    await expect(readText(path.join(dir, 'adir'))).rejects.toThrow()
    expect(isNotFound(new Error('x'))).toBe(false)
    expect(isNotFound(null)).toBe(false)
  })
})

describe('data-dir', () => {
  it('sits next to the git common dir, or where the override says', () => {
    expect(resolveDataDir({ commonDir: '/work/repo/.git' })).toBe('/work/repo/.pr-review')
    expect(resolveDataDir({ commonDir: '/work/repo/.git/worktrees/x/../..' })).toBe('/work/repo/.pr-review')
    expect(resolveDataDir({ override: '/elsewhere/data', commonDir: '/work/repo/.git' })).toBe(
      '/elsewhere/data'
    )
    expect(resolveDataDir({ override: '', commonDir: '/work/repo/.git' })).toBe('/work/repo/.pr-review')
    expect(repoDir('/d', TEST_REPO)).toBe('/d/repos/acme__widgets')
    expect(repoDir('/d', { owner: 'group/sub', name: 'app' })).toBe('/d/repos/group__sub__app')
  })

  it('creates the dir with a self-ignoring .gitignore once', async () => {
    const data = path.join(dir, '.pr-review')
    await ensureDataDir(data)
    expect(await readFile(path.join(data, '.gitignore'), 'utf8')).toBe('*\n')
    await writeFile(path.join(data, '.gitignore'), '* # custom\n')
    await ensureDataDir(data)
    expect(await readFile(path.join(data, '.gitignore'), 'utf8')).toBe('* # custom\n')
  })
})

function manifest(): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
}

describe('canvas-store', () => {
  it('starts empty and reports missing', async () => {
    const store = createCanvasStore(dir, createFakeGit())
    expect(await store.readIndex()).toEqual({ canvases: {} })
    expect(await store.findForPr(42, HEAD_SHA)).toEqual({ status: 'missing' })
    expect(await store.readArtifact(HEAD_SHA)).toBeNull()
    expect(await store.readManifest(HEAD_SHA)).toBeNull()
  })

  it('writes review.json + manifest.json and indexes the canvas by sha', async () => {
    const store = createCanvasStore(dir, createFakeGit())
    const artifact = { ...syntheticArtifact(), importedAt: '2026-09-10T11:30:00.000Z' }
    await store.write(HEAD_SHA, artifact, manifest())
    expect(await store.readArtifact(HEAD_SHA)).toEqual(artifact)
    expect(await store.readManifest(HEAD_SHA)).toEqual(manifest())
    expect(await store.readIndex()).toEqual({
      canvases: {
        [HEAD_SHA]: {
          prNumber: 42,
          generatedAt: '2026-09-10T11:00:00.000Z',
          source: 'local',
          importedAt: '2026-09-10T11:30:00.000Z',
        },
      },
    })
    expect(await store.findForPr(42, HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
    // Another head with the same PR number falls back to this canvas; see findForPr's own suite.
    expect(await store.findForPr(42, BASE_SHA)).toEqual({
      status: 'stale',
      headSha: HEAD_SHA,
      relation: 'unrelated',
    })
    expect(store.canvasDir(HEAD_SHA)).toBe(path.join(dir, 'canvases', HEAD_SHA))
    expect(await store.exists(HEAD_SHA)).toBe(true)
    expect(await store.exists(BASE_SHA)).toBe(false)
  })

  it('takes the PR number argument over the manifest and omits it when neither has one', async () => {
    const store = createCanvasStore(dir, createFakeGit())
    await store.write(HEAD_SHA, syntheticArtifact(), manifest(), 7)
    const { prNumber: _ignored, ...noPr } = manifest()
    await store.write(BASE_SHA, syntheticArtifact(), noPr)
    const index = await store.readIndex()
    expect(index.canvases[HEAD_SHA]?.prNumber).toBe(7)
    expect(index.canvases[BASE_SHA]).toEqual({ generatedAt: '2026-09-10T11:00:00.000Z', source: 'local' })
  })

  it('refuses a sha that is not 40 hex chars', () => {
    expect(() => createCanvasStore(dir, createFakeGit()).canvasDir('../etc')).toThrow(/not a commit sha/)
  })
})

describe('derived-store', () => {
  const git = () =>
    createFakeGit({
      refs: { head: HEAD_SHA, base: BASE_SHA },
      diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
      blobs: SYNTHETIC_BLOBS,
    })

  it('builds derived/ from git once and serves it from disk after', async () => {
    const g = git()
    const store = createDerivedStore(createCanvasStore(dir, createFakeGit()), g, now)
    expect(await store.derivable(HEAD_SHA, BASE_SHA)).toBe(true)
    expect(await store.derivable(HEAD_SHA, 'c'.repeat(40))).toBe(false)
    expect(await store.read(HEAD_SHA)).toBeNull()
    const first = await store.ensure(HEAD_SHA, BASE_SHA)
    expect(first.files.map(f => f.key)).toEqual([
      'src_app_ts',
      'src_new_ts',
      'src_gone_ts',
      'src_new_name_ts',
      'assets_logo_png',
      'bin_run_sh',
      'src_app_test_ts',
    ])
    expect(Object.keys(first.patches)).toEqual(first.files.map(f => f.key))
    const derived = store.derivedDir(HEAD_SHA)
    expect(
      (await readFile(path.join(derived, 'patches', 'src_app_ts.diff'), 'utf8')).split('\n').slice(0, 2)
    ).toEqual(['### hunk src_app_ts#1', '@@ -1,4 +1,5 @@'])
    expect((await stat(path.join(derived, 'head', 'src', 'app.ts'))).isFile()).toBe(true)
    expect((await stat(path.join(derived, 'base', 'src', 'gone.ts'))).isFile()).toBe(true)
    const diffCalls = g.calls.filter(c => c[0] === 'diff').length
    const second = await store.ensure(HEAD_SHA, BASE_SHA)
    expect(second).toEqual(first)
    expect(g.calls.filter(c => c[0] === 'diff').length).toBe(diffCalls)
    expect(await store.read(HEAD_SHA)).toEqual(first)
    await rm(path.join(derived, 'files.json'))
    expect(await store.read(HEAD_SHA)).toBeNull()
    expect(await store.ensure(HEAD_SHA, BASE_SHA)).toEqual(first)
  })

  it('rebuilds when the merge base changed', async () => {
    const g = git()
    g.options.diffs = {
      ...g.options.diffs,
      [`${'c'.repeat(40)}..${HEAD_SHA}`]: SYNTHETIC_DIFF.split('diff --git a/src/new.ts')[0] ?? '',
    }
    const store = createDerivedStore(createCanvasStore(dir, createFakeGit()), g, now)
    await store.ensure(HEAD_SHA, BASE_SHA)
    const rebuilt = await store.ensure(HEAD_SHA, 'c'.repeat(40))
    expect(rebuilt.files.map(f => f.key)).toEqual(['src_app_ts'])
  })

  it('reads lines from materialized files and refuses traversal', async () => {
    const store = createDerivedStore(createCanvasStore(dir, createFakeGit()), git(), now)
    await store.ensure(HEAD_SHA, BASE_SHA)
    expect(await store.readLines(HEAD_SHA, 'head', 'src/app.ts', 3, 4)).toEqual([
      'export function run() {',
      '  return a() + b()',
    ])
    expect(await store.readLines(HEAD_SHA, 'base', 'src/app.ts', 1, 99)).toEqual([
      "import { a } from './a'",
      'export function run() {',
      '  return a()',
      '}',
    ])
    expect(await store.readLines(HEAD_SHA, 'base', 'src/gone.ts', 1, 5)).toEqual([
      'export const old = 1',
      '// bye',
    ])
    expect(await store.readLines(HEAD_SHA, 'head', 'src/missing.ts', 1, 2)).toBeNull()
    expect(await store.readLines(HEAD_SHA, 'head', '../../package.json', 1, 2)).toBeNull()
  })
})

describe('pr-store and state-store', () => {
  it('caches pr.json and comments.json per PR and lists recent PRs newest first', async () => {
    const prs = createPrStore(dir)
    expect(await prs.readPr(42)).toBeNull()
    expect(await prs.readComments(42)).toBeNull()
    expect(await prs.listRecent(5)).toEqual([])
    const pr = syntheticArtifact().pr
    await prs.writePr(pr)
    await prs.writePr({ ...pr, number: 7, title: 'older' })
    await prs.writeComments(42, emptyComments(HEAD_SHA, '2026-09-10T12:00:00.000Z'))
    expect(await prs.readPr(42)).toEqual(pr)
    expect(await prs.readComments(42)).toEqual(emptyComments(HEAD_SHA, '2026-09-10T12:00:00.000Z'))
    await mkdir(path.join(dir, 'prs', 'not-a-number'))
    await mkdir(path.join(dir, 'prs', '99'))
    await writeFile(path.join(dir, 'prs', '99', 'pr.json'), '{"broken":')
    const recent = await prs.listRecent(5)
    expect(recent.map(r => r.number).sort((a, b) => a - b)).toEqual([7, 42])
    expect(recent.every(r => typeof r.updatedAt === 'string' && r.title.length > 0)).toBe(true)
    expect((await prs.listRecent(1)).length).toBe(1)
  })

  it('refuses invalid PR numbers and pre-PR change sets', async () => {
    const prs = createPrStore(dir)
    expect(() => prs.prDir(0)).toThrow(/not a pull request number/)
    await expect(prs.writePr({ ...syntheticArtifact().pr, number: null })).rejects.toThrow(/pre-PR/)
  })

  it('reads state.json or falls back to defaults for missing, invalid JSON, and old shapes', async () => {
    const prs = createPrStore(dir)
    const state = createStateStore(prs, now)
    expect(await state.read(42)).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
    const file = path.join(prs.prDir(42), 'state.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{ not json')
    expect(await state.read(42)).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
    await writeFile(
      file,
      JSON.stringify({ version: 1, reviewed: { 'layer:run-path': true }, updatedAt: 'x' })
    )
    expect(await state.read(42)).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
    const good = { ...emptyState('2026-09-01T00:00:00.000Z'), reviewed: { 'layer:run-path': true as const } }
    await writeJsonAtomic(file, good)
    expect(await state.read(42)).toEqual(good)
    await rm(file)
    await mkdir(file)
    await expect(state.read(42)).rejects.toThrow()
  })
})
