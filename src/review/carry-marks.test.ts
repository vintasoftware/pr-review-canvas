// @vitest-environment node
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { emptyState, type PrState } from '../contract/state.js'
import { createFakeGit, type FakeGitOptions, makeTestContext, type TestContext } from '../testing/fakes.js'
import {
  BASE_SHA,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { carriedMarks, marksForCanvas } from './carry-marks.js'
import { reviewedId } from '../contract/keys.js'
import { fileDelta } from './incremental.js'
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../git/diff-collector.js'
import type { Derived } from '../store/derived-store.js'

const OLD = 'e'.repeat(40)
const TOUCHED_APP = SYNTHETIC_DIFF.replace('+  const y = 2', '+  const y = 3')

function derivedOf(diff: string): Derived {
  const collected = parseUnifiedDiff(diff)
  return { files: collected.map(toFileEntry), patches: toPatchMap(collected) }
}

function manifestOf(headSha: string): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.5.0' },
    repo: syntheticArtifact().pr.repo,
    prNumber: 42,
    headSha,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
}

/** The canvas of OLD, and the canvas of the head that was generated from it. */
function canvasOf(headSha: string, basisCanvasSha?: string): ReviewArtifact {
  const artifact = syntheticArtifact()
  const next: ReviewArtifact = { ...artifact, pr: { ...artifact.pr, headSha } }
  if (basisCanvasSha !== undefined) {
    next.basisCanvasSha = basisCanvasSha
  }
  return next
}

function history(headDiff: string): FakeGitOptions {
  return {
    refs: { head: HEAD_SHA, old: OLD, base: BASE_SHA },
    ancestors: { [`${OLD}..${HEAD_SHA}`]: true },
    diffs: { [`${BASE_SHA}..${OLD}`]: SYNTHETIC_DIFF, [`${BASE_SHA}..${HEAD_SHA}`]: headDiff },
    blobs: SYNTHETIC_BLOBS,
  }
}

const APP = reviewedId('run-path', 'src/app.ts')
const APP_TEST = reviewedId('run-path', 'src/app.test.ts')
const RUN_PATH = reviewedId('run-path')
const OTHER = reviewedId('other')

describe('carriedMarks', () => {
  const basis = syntheticArtifact()

  it('follows a file mark only where the patch is byte-identical', () => {
    const unchanged = new Set(fileDelta(derivedOf(SYNTHETIC_DIFF), derivedOf(TOUCHED_APP)).unchanged)
    const carried = carriedMarks(basis, canvasOf(HEAD_SHA), unchanged, {
      [APP]: true,
      [APP_TEST]: true,
    })
    expect(carried).toEqual({ [APP_TEST]: true })
  })

  it('follows a layer mark only when the layer holds the same files and the head touched none', () => {
    const all = new Set(basis.files.map(f => f.path))
    expect(carriedMarks(basis, canvasOf(HEAD_SHA), all, { [RUN_PATH]: true })).toEqual({
      [RUN_PATH]: true,
    })
    // One file of the layer moved: the mark claimed the whole layer was read, so it stays behind.
    const partial = new Set([...all].filter(p => p !== 'src/app.ts'))
    expect(carriedMarks(basis, canvasOf(HEAD_SHA), partial, { [RUN_PATH]: true })).toEqual({})
  })

  it('leaves a layer mark behind when the layer gained or lost a file, untouched though they are', () => {
    const next = canvasOf(HEAD_SHA)
    const layer = next.layers[0]
    if (layer === undefined) {
      throw new Error('no layer')
    }
    next.layers = [
      { ...layer, files: [...layer.files, { ...layer.files[0]!, path: 'src/new.ts' }] },
      ...next.layers.slice(1),
    ]
    const all = new Set([...basis.files.map(f => f.path), 'src/new.ts'])
    expect(carriedMarks(basis, next, all, { [RUN_PATH]: true })).toEqual({})
  })

  it('leaves behind the marks of a layer key the new canvas does not have', () => {
    const next = canvasOf(HEAD_SHA)
    next.layers = next.layers.map(l => (l.key === 'run-path' ? { ...l, key: 'renamed', id: 'renamed' } : l))
    const all = new Set(basis.files.map(f => f.path))
    expect(carriedMarks(basis, next, all, { [RUN_PATH]: true, [APP]: true })).toEqual({})
  })
})

describe('marksForCanvas', () => {
  let t: TestContext
  afterEach(() => t?.cleanup())

  async function withCanvases(headDiff: string, basisCanvasSha: string | null = OLD): Promise<void> {
    t = await makeTestContext({ git: createFakeGit(history(headDiff)) })
    await t.ctx.canvases.write(OLD, canvasOf(OLD), manifestOf(OLD), 42)
    const head = basisCanvasSha === null ? canvasOf(HEAD_SHA) : canvasOf(HEAD_SHA, basisCanvasSha)
    await t.ctx.canvases.write(HEAD_SHA, head, manifestOf(HEAD_SHA), 42)
  }

  const stateOn = (canvasSha: string, reviewed: Record<string, true>): PrState => ({
    ...emptyState('2026-09-10T12:00:00.000Z'),
    reviewed,
    reviewedCanvasSha: canvasSha,
  })

  it('leaves the marks alone when they were made on this very canvas', async () => {
    await withCanvases(TOUCHED_APP)
    const state = stateOn(HEAD_SHA, { [APP]: true })
    const marks = await marksForCanvas(t.ctx, canvasOf(HEAD_SHA, OLD), HEAD_SHA, state)
    expect(marks).toEqual({ state })
  })

  it('carries the marks of the basis canvas that the head leaves untouched, and names it', async () => {
    await withCanvases(TOUCHED_APP)
    const marks = await marksForCanvas(
      t.ctx,
      canvasOf(HEAD_SHA, OLD),
      HEAD_SHA,
      stateOn(OLD, { [APP]: true, [APP_TEST]: true, [RUN_PATH]: true, [OTHER]: true })
    )
    expect(marks.carriedFrom).toBe(OLD)
    expect(marks.state.reviewed).toEqual({ [APP_TEST]: true })
    expect(marks.state.reviewedCanvasSha).toBe(HEAD_SHA)
  })

  it('drops the marks when the canvas names no basis, or another one', async () => {
    await withCanvases(TOUCHED_APP, null)
    const state = stateOn(OLD, { [APP_TEST]: true })
    const none = await marksForCanvas(t.ctx, canvasOf(HEAD_SHA), HEAD_SHA, state)
    expect(none).toEqual({ state: { ...state, reviewed: {} } })
    const elsewhere = await marksForCanvas(t.ctx, canvasOf(HEAD_SHA, 'c'.repeat(40)), HEAD_SHA, state)
    expect(elsewhere.state.reviewed).toEqual({})
    expect(elsewhere.carriedFrom).toBeUndefined()
  })

  it('drops the marks when this machine has no basis canvas to check against', async () => {
    t = await makeTestContext({ git: createFakeGit(history(TOUCHED_APP)) })
    await t.ctx.canvases.write(HEAD_SHA, canvasOf(HEAD_SHA, OLD), manifestOf(HEAD_SHA), 42)
    const marks = await marksForCanvas(
      t.ctx,
      canvasOf(HEAD_SHA, OLD),
      HEAD_SHA,
      stateOn(OLD, { [APP_TEST]: true })
    )
    expect(marks.state.reviewed).toEqual({})
    expect(marks.carriedFrom).toBeUndefined()
  })

  it('reports no carry when the head moved every file the reviewer had marked', async () => {
    await withCanvases(TOUCHED_APP)
    const marks = await marksForCanvas(
      t.ctx,
      canvasOf(HEAD_SHA, OLD),
      HEAD_SHA,
      stateOn(OLD, { [APP]: true })
    )
    expect(marks.state.reviewed).toEqual({})
    expect(marks.carriedFrom).toBeUndefined()
  })
})
