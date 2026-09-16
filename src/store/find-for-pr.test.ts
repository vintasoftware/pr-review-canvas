// @vitest-environment node
// Which canvas the page shows for a PR whose head moved.
import { rm } from 'node:fs/promises'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { createFakeGit, type FakeGitOptions, makeTempDir, TEST_REPO } from '../testing/fakes.js'
import { syntheticArtifact } from '../testing/synthetic.js'
import { type CanvasStore, createCanvasStore } from './canvas-store.js'

const HEAD = 'a'.repeat(40)
const OLD = 'b'.repeat(40)
const OLDER = 'c'.repeat(40)
const FORCE_PUSHED = 'd'.repeat(40)

let dir: string
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function manifest(headSha: string, prNumber?: number): CanvasManifest {
  const base: CanvasManifest = {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    headSha,
    mergeBaseSha: OLDER,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
  return prNumber === undefined ? base : { ...base, prNumber }
}

async function store(git: FakeGitOptions): Promise<CanvasStore> {
  return createCanvasStore(dir, createFakeGit(git))
}

async function put(s: CanvasStore, headSha: string, generatedAt: string, prNumber?: number): Promise<void> {
  await s.write(headSha, { ...syntheticArtifact(), generatedAt }, manifest(headSha, prNumber), prNumber)
}

describe('CanvasStore.findForPr', () => {
  it('takes the canvas of the head itself', async () => {
    const s = await store({})
    await put(s, HEAD, '2026-09-10T11:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({ status: 'ready', headSha: HEAD })
  })

  it('reports missing when nothing is stored for the PR', async () => {
    const s = await store({})
    await put(s, OLD, '2026-09-10T11:00:00.000Z', 7)
    expect(await s.findForPr(42, HEAD)).toEqual({ status: 'missing' })
  })

  it('takes the newest ancestor of the head and counts the distance', async () => {
    const s = await store({
      ancestors: { [`${OLD}..${HEAD}`]: true, [`${OLDER}..${HEAD}`]: true },
      counts: { [`${OLD}..${HEAD}`]: 2, [`${OLDER}..${HEAD}`]: 5 },
    })
    await put(s, OLDER, '2026-09-09T10:00:00.000Z', 42)
    await put(s, OLD, '2026-09-10T10:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 2,
    })
  })

  it('ranks an ancestor above a force-pushed commit, however new that one is', async () => {
    const s = await store({ ancestors: { [`${OLD}..${HEAD}`]: true }, counts: { [`${OLD}..${HEAD}`]: 1 } })
    await put(s, OLD, '2026-09-09T10:00:00.000Z', 42)
    await put(s, FORCE_PUSHED, '2026-09-10T18:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 1,
    })
  })

  it('prefers the ancestor even when the unrelated canvas was indexed first', async () => {
    const s = await store({ ancestors: { [`${OLD}..${HEAD}`]: true }, counts: { [`${OLD}..${HEAD}`]: 2 } })
    await put(s, FORCE_PUSHED, '2026-09-10T18:00:00.000Z', 42)
    await put(s, OLD, '2026-09-09T10:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 2,
    })
  })

  it('falls back to the newest unrelated canvas with no distance', async () => {
    const s = await store({})
    await put(s, OLD, '2026-09-09T10:00:00.000Z', 42)
    await put(s, FORCE_PUSHED, '2026-09-10T18:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({
      status: 'stale',
      headSha: FORCE_PUSHED,
      relation: 'unrelated',
    })
  })

  it('matches a canvas exported before the PR existed, and skips other PRs', async () => {
    const s = await store({ ancestors: { [`${OLD}..${HEAD}`]: true }, counts: { [`${OLD}..${HEAD}`]: 3 } })
    await put(s, OLD, '2026-09-10T10:00:00.000Z')
    await put(s, FORCE_PUSHED, '2026-09-10T18:00:00.000Z', 99)
    expect(await s.findForPr(42, HEAD)).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
  })

  it('keeps a stable order when two canvases were generated at the same moment', async () => {
    const s = await store({})
    await put(s, OLD, '2026-09-10T10:00:00.000Z', 42)
    await put(s, FORCE_PUSHED, '2026-09-10T10:00:00.000Z', 42)
    expect(await s.findForPr(42, HEAD)).toEqual({ status: 'stale', headSha: OLD, relation: 'unrelated' })
  })

  it('attaches a PR number to a canvas that had none, and leaves an unknown sha alone', async () => {
    const s = await store({})
    await put(s, OLD, '2026-09-10T10:00:00.000Z')
    await s.attachPrNumber(OLD, 42)
    await s.attachPrNumber(OLD, 42)
    await s.attachPrNumber(HEAD, 42)
    const index = await s.readIndex()
    expect(index.canvases[OLD]?.prNumber).toBe(42)
    expect(index.canvases[HEAD]).toBeUndefined()
  })
})
