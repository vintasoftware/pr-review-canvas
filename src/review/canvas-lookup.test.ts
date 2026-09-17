// @vitest-environment node
// The merge-commit rule, applied once for the canvas lookup and the review marks.
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { Pr } from '../contract/review-artifact.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import { BASE_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { lookupCanvas, reviewStateFor, standsForHead } from './canvas-lookup.js'

const HEAD = 'a'.repeat(40)
const OLD = 'e'.repeat(40)
const FORCE_PUSHED = 'd'.repeat(40)
const STRICT: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, canvas: { ignoreMergeCommits: false } }
/** HEAD merged the base onto OLD: three commits, none of them ordinary commits beyond the base. */
const MERGED_BASE: FakeGitOptions = {
  ancestors: { [`${OLD}..${HEAD}`]: true },
  counts: { [`${OLD}..${HEAD}`]: 3 },
  nonMergeCounts: { [`${HEAD} ^${OLD} ^${BASE_SHA}`]: 0 },
}

function pr(mergeable: boolean | null | undefined): Pr {
  const base = { ...syntheticArtifact().pr, headSha: HEAD }
  delete base.mergeable
  return mergeable === undefined ? base : { ...base, mergeable }
}

function manifest(headSha: string): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    prNumber: 42,
    headSha,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
}

let t: TestContext
let git: FakeGit
afterEach(() => t?.cleanup())

async function context(config: ProjectConfig, history: FakeGitOptions = MERGED_BASE): Promise<TestContext> {
  git = createFakeGit(history)
  t = await makeTestContext({
    git,
    projectConfig: { config, warnings: [], source: null },
  })
  return t
}

describe('standsForHead', () => {
  it('the head stands for itself whatever the setting says', async () => {
    await context(STRICT)
    expect(await standsForHead(t.ctx, HEAD, pr(null))).toBe(true)
  })

  it('an older commit stands for the head when only the base was merged onto it', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(true)
    expect(git.calls).toContainEqual(['rev-list', '--no-merges', '--count', HEAD, `^${OLD}`, `^${BASE_SHA}`])
  })

  it('needs the setting on and a clean conflict report', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    expect(await standsForHead(t.ctx, OLD, pr(false))).toBe(false)
    expect(await standsForHead(t.ctx, OLD, pr(null))).toBe(false)
    expect(await standsForHead(t.ctx, OLD, pr(undefined))).toBe(false)
    // Git is not asked when the answer is already no.
    expect(git.calls).toEqual([])
    await t.cleanup()
    await context(STRICT)
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(false)
  })

  it('is false for a commit the head does not contain, and asks git nothing more', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    expect(await standsForHead(t.ctx, FORCE_PUSHED, pr(true))).toBe(false)
    expect(git.calls.filter(c => c[0] === 'rev-list')).toEqual([])
  })

  it('is false once an ordinary commit came in, on the branch or from a branch the base lacks', async () => {
    await context(DEFAULT_PROJECT_CONFIG, {
      ...MERGED_BASE,
      nonMergeCounts: { [`${HEAD} ^${OLD} ^${BASE_SHA}`]: 1 },
    })
    expect(await standsForHead(t.ctx, OLD, pr(true))).toBe(false)
  })
})

describe('lookupCanvas', () => {
  it('takes the canvas of a commit that stands for the head as ready, and says how far it moved', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    await t.ctx.canvases.write(OLD, syntheticArtifact(), manifest(OLD), 42)
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toEqual({
      status: 'ready',
      headSha: OLD,
      mergesSince: { canvasHeadSha: OLD, currentHeadSha: HEAD, commitsBehind: 3 },
    })
    // The same history reads as outdated without a clean conflict report.
    expect(await lookupCanvas(t.ctx, 42, pr(null))).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
  })

  it('keeps the canvas of the head itself ahead of an older one', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    await t.ctx.canvases.write(OLD, syntheticArtifact(), manifest(OLD), 42)
    await t.ctx.canvases.write(HEAD, syntheticArtifact(), manifest(HEAD), 42)
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toEqual({ status: 'ready', headSha: HEAD })
  })

  it('never follows merges onto a commit the head does not contain', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    await t.ctx.canvases.write(FORCE_PUSHED, syntheticArtifact(), manifest(FORCE_PUSHED), 42)
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toEqual({
      status: 'stale',
      headSha: FORCE_PUSHED,
      relation: 'unrelated',
    })
  })
})

describe('reviewStateFor', () => {
  it('re-keys marks made on a commit that stands for the head, once', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD)
    const moved = await reviewStateFor(t.ctx, 42, pr(true))
    expect(moved.reviewed).toEqual({ 'layer:layer-1': true })
    expect(moved.reviewedHeadSha).toBe(HEAD)
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(HEAD)
    // A second read has nothing left to move.
    expect((await reviewStateFor(t.ctx, 42, pr(true))).rev).toBe(moved.rev)
  })

  it('shows no marks, and writes nothing, when the marked commit does not stand for the head', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD)
    const { rev } = await t.ctx.state.read(42)
    const state = await reviewStateFor(t.ctx, 42, pr(false))
    expect(state.reviewed).toEqual({})
    expect(await t.ctx.state.read(42)).toMatchObject({ rev, reviewedHeadSha: OLD })
  })

  it('reads plainly when nothing is marked', async () => {
    await context(DEFAULT_PROJECT_CONFIG)
    const state = await reviewStateFor(t.ctx, 42, pr(true))
    expect(state.reviewedHeadSha).toBeUndefined()
    expect(git.calls).toEqual([])
  })
})
