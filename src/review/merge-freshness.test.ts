// @vitest-environment node
import type { Pr } from '../contract/review-artifact.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
  makeTestContext,
  type TestContext,
} from '../testing/fakes.js'
import { BASE_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { lookupCanvas, reviewStateFor, standsForHead } from './merge-freshness.js'

const HEAD = 'a'.repeat(40)
const OLD = 'e'.repeat(40)
const FORCE_PUSHED = 'f'.repeat(40)
const STRICT: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG, canvas: { ignoreMergeCommits: false } }

function pr(mergeable: boolean | null | undefined): Pr {
  const base = { ...syntheticArtifact().pr, headSha: HEAD }
  delete base.mergeable
  return mergeable === undefined ? base : { ...base, mergeable }
}

/** OLD is three commits behind HEAD; `ownCounts` says how many of them the base does not account for. */
function history(ownCounts: number): FakeGitOptions {
  return {
    ancestors: { [`${OLD}..${HEAD}`]: true },
    counts: { [`${OLD}..${HEAD}`]: 3 },
    ownCounts: { [`${OLD}..${HEAD}`]: ownCounts },
  }
}

describe('standsForHead', () => {
  it('the head stands for itself whatever the setting says', async () => {
    expect(await standsForHead(createFakeGit(history(1)), STRICT, pr(null), HEAD)).toBe(true)
  })

  it('an older commit stands for the head only through merges of the base, with the setting on and a clean report', async () => {
    const merged = createFakeGit(history(0))
    expect(await standsForHead(merged, DEFAULT_PROJECT_CONFIG, pr(true), OLD)).toBe(true)
    expect(merged.calls).toEqual([
      ['merge-base', '--is-ancestor', OLD, HEAD],
      ['rev-list', '--count', '--no-merges', `${OLD}..${HEAD}`, '--not', BASE_SHA],
    ])
    expect(await standsForHead(merged, DEFAULT_PROJECT_CONFIG, pr(null), OLD)).toBe(false)
    expect(await standsForHead(merged, DEFAULT_PROJECT_CONFIG, pr(false), OLD)).toBe(false)
    expect(await standsForHead(merged, DEFAULT_PROJECT_CONFIG, pr(undefined), OLD)).toBe(false)
    expect(await standsForHead(merged, STRICT, pr(true), OLD)).toBe(false)
    expect(await standsForHead(merged, DEFAULT_PROJECT_CONFIG, pr(true), FORCE_PUSHED)).toBe(false)
    // One commit of the branch's own, or merged in from another branch: other code.
    expect(await standsForHead(createFakeGit(history(1)), DEFAULT_PROJECT_CONFIG, pr(true), OLD)).toBe(false)
  })
})

describe('lookupCanvas and reviewStateFor', () => {
  let t: TestContext
  let git: FakeGit
  afterEach(() => t?.cleanup())

  async function context(ownCounts: number, config = DEFAULT_PROJECT_CONFIG): Promise<TestContext> {
    git = createFakeGit(history(ownCounts))
    t = await makeTestContext({ git, projectConfig: { config, warnings: [], source: null } })
    return t
  }

  it('reads a canvas of a commit the head only merged the base onto as ready, and says how far it moved', async () => {
    await context(0)
    t.ctx.canvases.findForPr = async () => ({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toEqual({
      status: 'ready',
      headSha: OLD,
      mergesSince: { canvasHeadSha: OLD, currentHeadSha: HEAD, commitsBehind: 3 },
    })
    // The store's answer stands when the rule does not apply.
    expect(await lookupCanvas(t.ctx, 42, pr(null))).toEqual({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
    await t.cleanup()
    await context(1)
    t.ctx.canvases.findForPr = async () => ({
      status: 'stale',
      headSha: OLD,
      relation: 'ancestor',
      commitsBehind: 3,
    })
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toMatchObject({ status: 'stale' })
  })

  it('never follows merges onto a commit the head does not contain, and asks git nothing about it', async () => {
    await context(0)
    t.ctx.canvases.findForPr = async () => ({ status: 'stale', headSha: FORCE_PUSHED, relation: 'unrelated' })
    expect(await lookupCanvas(t.ctx, 42, pr(true))).toEqual({
      status: 'stale',
      headSha: FORCE_PUSHED,
      relation: 'unrelated',
    })
    expect(git.calls).toEqual([])
  })

  it('moves the marks to a head that stands for the marked commit, and blanks them otherwise', async () => {
    await context(0)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD)
    const moved = await reviewStateFor(t.ctx, 42, pr(true))
    expect(moved.reviewed).toEqual({ 'layer:layer-1': true })
    expect(moved.reviewedHeadSha).toBe(HEAD)
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(HEAD)
    await t.cleanup()
    await context(1)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD)
    const blanked = await reviewStateFor(t.ctx, 42, pr(true))
    expect(blanked.reviewed).toEqual({})
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(OLD)
  })
})
