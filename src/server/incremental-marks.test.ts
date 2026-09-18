// @vitest-environment node
// A canvas regenerated for a new head from the canvas of an earlier one: the reviewer's progress
// follows it for the files the new commits leave untouched, the page says where it came from, and
// the first mark made on the new canvas keeps the carried ones instead of replacing them.
import type { PrBundle, StateResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { markId } from '../review/carry-marks.js'
import { createFakeGit, ghJson, makeTestContext, TEST_REPO, type TestContext } from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const LOCAL = { host: 'localhost:3010' }
const JSON_POST = {
  ...LOCAL,
  origin: 'http://localhost:3010',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
}
/** The commit the basis canvas was generated for; the head moved on and touched src/app.ts. */
const OLD_SHA = 'e'.repeat(40)
const TOUCHED_APP = SYNTHETIC_DIFF.replace('+  const y = 2', '+  const y = 3')

const APP = markId('run-path', 'src/app.ts')
const APP_TEST = markId('run-path', 'src/app.test.ts')

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function manifest(headSha: string): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.5.0' },
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

function artifactFor(headSha: string, basisCanvasSha?: string): ReviewArtifact {
  const base = syntheticArtifact()
  const artifact: ReviewArtifact = { ...base, pr: { ...base.pr, headSha } }
  if (basisCanvasSha !== undefined) {
    artifact.basisCanvasSha = basisCanvasSha
  }
  return artifact
}

let t: TestContext
afterEach(() => t?.cleanup())

/** PR #42 at HEAD_SHA, with the canvas of OLD_SHA and a canvas generated from it for the head. */
async function withIncrementalCanvas(basisCanvasSha: string | null = OLD_SHA): Promise<void> {
  const git = createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, old: OLD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`${BASE_SHA}..${OLD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: TOUCHED_APP, [`${BASE_SHA}..${OLD_SHA}`]: SYNTHETIC_DIFF },
    blobs: SYNTHETIC_BLOBS,
    ancestors: { [`${OLD_SHA}..${HEAD_SHA}`]: true },
    counts: { [`${OLD_SHA}..${HEAD_SHA}`]: 2 },
    topLevel: '/repo',
  })
  t = await makeTestContext({
    git,
    gh: ghFor42({ routes: { 'repos/acme/widgets/pulls/42': ghJson(GH_PULL) } }),
  })
  await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA), 42)
  const head = basisCanvasSha === null ? artifactFor(HEAD_SHA) : artifactFor(HEAD_SHA, basisCanvasSha)
  await t.ctx.canvases.write(HEAD_SHA, head, manifest(HEAD_SHA), 42)
}

const bundle = async (): Promise<PrBundle> =>
  json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))

/** Marks the reviewer made on the basis canvas: the app file, its test, and the whole layer. */
async function markedOnBasis(): Promise<void> {
  await t.ctx.state.setReviewed(42, APP, true, { canvasSha: OLD_SHA })
  await t.ctx.state.setReviewed(42, APP_TEST, true, { canvasSha: OLD_SHA })
}

describe('a canvas generated from the canvas of an earlier commit', () => {
  it('shows the marks of the files the head left untouched, and names the canvas they came from', async () => {
    await withIncrementalCanvas()
    await markedOnBasis()
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.canvas?.headSha).toBe(HEAD_SHA)
    // src/app.ts changed, so its mark stays behind; src/app.test.ts is byte-identical.
    expect(b.state.reviewed).toEqual({ [APP_TEST]: true })
    expect(b.marksCarriedFrom).toBe(OLD_SHA)
  })

  it('keeps the carried marks when the reviewer marks something on the new canvas', async () => {
    await withIncrementalCanvas()
    await markedOnBasis()
    await bundle()
    const res = await createApp(t.ctx).request(`/api/prs/42/reviewed/${APP}`, {
      method: 'PUT',
      headers: JSON_POST,
      body: JSON.stringify({ reviewed: true, headSha: HEAD_SHA, canvasSha: HEAD_SHA }),
    })
    expect(res.status).toBe(200)
    const after = await json<StateResponse>(res)
    expect(after.state.reviewed).toEqual({ [APP_TEST]: true, [APP]: true })
    expect(after.state.reviewedCanvasSha).toBe(HEAD_SHA)
    // Written through, so the next page load reads the same marks without recomputing the carry.
    expect((await t.ctx.state.read(42)).reviewed).toEqual({ [APP_TEST]: true, [APP]: true })
  })

  it('carries nothing when the canvas names no basis, and says nothing on the page', async () => {
    await withIncrementalCanvas(null)
    await markedOnBasis()
    const b = await bundle()
    expect(b.state.reviewed).toEqual({})
    expect(b.marksCarriedFrom).toBeUndefined()
  })

  it('leaves marks made on the new canvas alone, and stops naming a basis once they are its own', async () => {
    await withIncrementalCanvas()
    await t.ctx.state.setReviewed(42, APP, true, { canvasSha: HEAD_SHA })
    const b = await bundle()
    expect(b.state.reviewed).toEqual({ [APP]: true })
    expect(b.marksCarriedFrom).toBeUndefined()
  })
})
