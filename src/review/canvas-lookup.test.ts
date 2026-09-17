// @vitest-environment node
// The branches the routes do not reach on their own: a head or a marked commit whose diff the
// clone cannot produce. The rest of this module is exercised end to end in server/merge-freshness.
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { createFakeGit, makeTestContext, TEST_REPO, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, SYNTHETIC_DIFF, syntheticArtifact } from '../testing/synthetic.js'
import { resolveCanvas, reviewStateFor, sameChangeSet } from './canvas-lookup.js'

const HEAD = 'a'.repeat(40)
const OLD = 'e'.repeat(40)

const MANIFEST: CanvasManifest = {
  formatVersion: 1,
  tool: { name: 'pr-review', version: '0.1.0' },
  repo: TEST_REPO,
  prNumber: 42,
  headSha: OLD,
  mergeBaseSha: BASE_SHA,
  baseRef: 'main',
  headRef: 'feat/b',
  generatedAt: '2026-09-10T11:00:00.000Z',
  generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
}

let t: TestContext
afterEach(() => t?.cleanup())

/** OLD is in the clone and diffs to the synthetic change; HEAD is known to the index only. */
async function context(): Promise<TestContext> {
  t = await makeTestContext({
    git: createFakeGit({
      refs: { old: OLD },
      mergeBases: { [`${BASE_SHA}..${OLD}`]: BASE_SHA },
      diffs: { [`${BASE_SHA}..${OLD}`]: SYNTHETIC_DIFF },
      ancestors: { [`${OLD}..${HEAD}`]: true },
      counts: { [`${OLD}..${HEAD}`]: 1 },
    }),
  })
  await t.ctx.canvases.write(OLD, syntheticArtifact(), MANIFEST, 42)
  return t
}

const pr = { ...syntheticArtifact().pr, headSha: HEAD, mergeBaseSha: BASE_SHA }

describe('sameChangeSet', () => {
  it('compares files, hunks, and patches together', () => {
    const files = syntheticArtifact().files
    expect(sameChangeSet({ files, patches: { a: 'x' } }, { files, patches: { a: 'x' } })).toBe(true)
    expect(sameChangeSet({ files, patches: { a: 'x' } }, { files, patches: { a: 'y' } })).toBe(false)
    expect(sameChangeSet({ files, patches: {} }, { files: files.slice(1), patches: {} })).toBe(false)
  })
})

describe('resolveCanvas', () => {
  it('keeps the strict answer when the head cannot be diffed on this machine', async () => {
    await context()
    const found = await resolveCanvas(t.ctx, 42, pr)
    expect(found).toMatchObject({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 1,
      head: null,
    })
    // The canvas commit's own diff was built, so the page can still show that canvas.
    expect(found.status === 'stale' && found.diff?.files.map(f => f.path)).toContain('src/app.ts')
  })
})

describe('reviewStateFor', () => {
  it('keeps the strict answer when the marked commit was never diffed on this machine', async () => {
    await context()
    // The head is diffable here; the marked commit is not.
    await t.ctx.derived.ensure(OLD, BASE_SHA)
    const marked = 'c'.repeat(40)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, marked)
    const head = await t.ctx.derived.read(OLD)
    const state = await reviewStateFor(t.ctx, 42, { ...pr, headSha: OLD }, head)
    expect(state.reviewed).toEqual({})
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(marked)
  })
})
