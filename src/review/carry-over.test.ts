// @vitest-environment node
import type { Pr } from '../contract/review-artifact.js'
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import type { Derived } from '../store/derived-store.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
  makeTestContext,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { lookupCanvas, samePatches, standsForHead } from './carry-over.js'

/** The commit the canvas describes; the pull request moved on to HEAD_SHA afterwards. */
const OLD = 'e'.repeat(40)
const FORCE_PUSHED = 'f'.repeat(40)
const STRICT: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, canvas: { keepForIdenticalDiff: false } }
const PR: Pr = { ...syntheticArtifact().pr, headSha: HEAD_SHA }
const CANVAS = { headSha: OLD, mergeBaseSha: BASE_SHA }

/** The derived diffs as the store builds them from a unified diff. */
function derivedOf(diff: string): Derived {
  const collected = parseUnifiedDiff(diff)
  return { files: collected.map(toFileEntry), patches: toPatchMap(collected) }
}

/** OLD changed SYNTHETIC_DIFF; the head's diff is `headDiff`. Both commits are in the clone. */
function history(headDiff: string): FakeGitOptions {
  return {
    refs: { head: HEAD_SHA, old: OLD, base: BASE_SHA },
    ancestors: { [`${OLD}..${HEAD_SHA}`]: true },
    counts: { [`${OLD}..${HEAD_SHA}`]: 3 },
    diffs: { [`${BASE_SHA}..${OLD}`]: SYNTHETIC_DIFF, [`${BASE_SHA}..${HEAD_SHA}`]: headDiff },
    blobs: SYNTHETIC_BLOBS,
  }
}

describe('samePatches', () => {
  it('is identity: the same changed lines in moved hunks are another diff', () => {
    const canvas = derivedOf(SYNTHETIC_DIFF)
    expect(samePatches(canvas, derivedOf(SYNTHETIC_DIFF))).toBe(true)
    expect(samePatches(canvas, derivedOf(SYNTHETIC_DIFF_MOVED_BY_BASE))).toBe(false)
    expect(samePatches(canvas, derivedOf(SYNTHETIC_DIFF.replace('+  const y = 2', '+  const y = 3')))).toBe(
      false
    )
  })

  it('reads the patches, so a file the diff no longer touches is another diff', () => {
    const canvas = derivedOf(SYNTHETIC_DIFF)
    const fewer: Derived = { files: canvas.files, patches: { ...canvas.patches } }
    const dropped = Object.keys(fewer.patches)[0]
    expect(dropped).toBeDefined()
    delete fewer.patches[dropped as string]
    expect(samePatches(canvas, fewer)).toBe(false)
    expect(samePatches(fewer, canvas)).toBe(false)
  })
})

describe('standsForHead and lookupCanvas', () => {
  let t: TestContext
  let git: FakeGit
  afterEach(() => t?.cleanup())

  async function context(options: FakeGitOptions, config = DEFAULT_PROJECT_CONFIG): Promise<TestContext> {
    git = createFakeGit(options)
    t = await makeTestContext({ git, projectConfig: { config, warnings: [], source: null } })
    return t
  }

  it('the head stands for itself whatever the setting says', async () => {
    await context(history(SYNTHETIC_DIFF_MOVED_BY_BASE), STRICT)
    expect(await standsForHead(t.ctx, PR, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })).toBe(true)
    expect(git.calls).toEqual([])
  })

  it('another commit stands for the head when the diffs are identical, whatever lies between them', async () => {
    await context(history(SYNTHETIC_DIFF))
    expect(await standsForHead(t.ctx, PR, CANVAS)).toBe(true)
    // The diffs were built from the clone; ancestry and commit counts were never asked for.
    expect(git.calls.map(c => c[0])).not.toContain('merge-base')
    expect(git.calls.map(c => c[0])).not.toContain('rev-list')
  })

  it('keeps the strict reading for a diff that differs, the setting off, or a commit not in the clone', async () => {
    await context(history(SYNTHETIC_DIFF_MOVED_BY_BASE))
    expect(await standsForHead(t.ctx, PR, CANVAS)).toBe(false)
    await t.cleanup()
    await context(history(SYNTHETIC_DIFF), STRICT)
    expect(await standsForHead(t.ctx, PR, CANVAS)).toBe(false)
    expect(git.calls).toEqual([])
    await t.cleanup()
    // The canvas's commit is not in the clone, so its diff cannot be built.
    await context({ ...history(SYNTHETIC_DIFF), refs: { head: HEAD_SHA, base: BASE_SHA } })
    expect(await standsForHead(t.ctx, PR, { headSha: FORCE_PUSHED, mergeBaseSha: BASE_SHA })).toBe(false)
  })

  it('builds the head diff against its current merge base, so a base that advanced is seen', async () => {
    await context(history(SYNTHETIC_DIFF))
    // The clone still holds the head diff built against BASE_SHA, identical to the canvas's.
    expect(await standsForHead(t.ctx, PR, CANVAS)).toBe(true)
    // The base advanced under the same head: against the new merge base the hunks moved.
    const advanced = '9'.repeat(40)
    Object.assign(git.options.refs ?? {}, { base: advanced })
    Object.assign(git.options.diffs ?? {}, { [`${advanced}..${HEAD_SHA}`]: SYNTHETIC_DIFF_MOVED_BY_BASE })
    expect(await standsForHead(t.ctx, { ...PR, mergeBaseSha: advanced }, CANVAS)).toBe(false)
  })

  it('reads a canvas that stands for the head as ready, and names both commits', async () => {
    await context(history(SYNTHETIC_DIFF))
    await t.ctx.canvases.write(OLD, syntheticArtifact(), manifestOf(OLD), 42)
    expect(await lookupCanvas(t.ctx, 42, PR)).toEqual({
      status: 'ready',
      headSha: OLD,
      carriedOver: { canvasHeadSha: OLD, currentHeadSha: HEAD_SHA, commitsBehind: 3 },
    })
    await t.cleanup()
    await context(history(SYNTHETIC_DIFF_MOVED_BY_BASE))
    await t.ctx.canvases.write(OLD, syntheticArtifact(), manifestOf(OLD), 42)
    expect(await lookupCanvas(t.ctx, 42, PR)).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
  })

  it('carries a canvas over to a head that does not contain its commit, such as after a rebase', async () => {
    await context({
      ...history(SYNTHETIC_DIFF),
      refs: { head: HEAD_SHA, rebased: FORCE_PUSHED, base: BASE_SHA },
    })
    git.options.diffs = { ...git.options.diffs, [`${BASE_SHA}..${FORCE_PUSHED}`]: SYNTHETIC_DIFF }
    await t.ctx.canvases.write(FORCE_PUSHED, syntheticArtifact(), manifestOf(FORCE_PUSHED), 42)
    expect(await lookupCanvas(t.ctx, 42, PR)).toEqual({
      status: 'ready',
      headSha: FORCE_PUSHED,
      carriedOver: { canvasHeadSha: FORCE_PUSHED, currentHeadSha: HEAD_SHA },
    })
  })
})

function manifestOf(headSha: string) {
  return {
    formatVersion: 1 as const,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: syntheticArtifact().pr.repo,
    prNumber: 42,
    headSha,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code' as const, attempts: 1 },
  }
}
