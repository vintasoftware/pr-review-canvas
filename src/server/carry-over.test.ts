// @vitest-environment node
// A pull request whose head moved on since its canvas was generated but has the identical diff:
// the canvas is carried over, the reviewer's marks move along, and the chat keeps working. The
// same routes with the strict reading, when the project says so or the head's diff differs.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { ErrorEnvelope, PrBundle, ReviewBodyResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import { createFakeRunner, type FakeRunner } from '../testing/fake-runner.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
  ghJson,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, origin: 'http://localhost:3010', 'sec-fetch-site': 'same-origin' }
const JSON_POST = { ...SAME_ORIGIN, 'content-type': 'application/json' }
/** The commit the canvas was generated for; HEAD_SHA merged the base onto it afterwards. */
const OLD_SHA = 'e'.repeat(40)

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
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

function artifactFor(headSha: string): ReviewArtifact {
  const base = syntheticArtifact()
  return { ...base, pr: { ...base.pr, headSha }, generatedAt: '2026-09-10T11:00:00.000Z' }
}

/**
 * PR #42 at HEAD_SHA, three commits after OLD_SHA, with the identical diff. `extra` overrides the
 * history, e.g. to give the head another diff.
 */
function gitWithMerge(extra: FakeGitOptions = {}) {
  return createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, old: OLD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`${BASE_SHA}..${OLD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF, [`${BASE_SHA}..${OLD_SHA}`]: SYNTHETIC_DIFF },
    blobs: SYNTHETIC_BLOBS,
    ancestors: { [`${OLD_SHA}..${HEAD_SHA}`]: true },
    counts: { [`${OLD_SHA}..${HEAD_SHA}`]: 3 },
    topLevel: '/repo',
    ...extra,
  })
}

interface Scenario {
  keepForIdenticalDiff?: boolean
  git?: FakeGitOptions
}

let t: TestContext
let git: FakeGit
let runner: FakeRunner
afterEach(() => t?.cleanup())

/** A context holding the canvas of OLD_SHA, with the pull request now at HEAD_SHA. */
async function withOldCanvas(scenario: Scenario = {}): Promise<TestContext> {
  runner = createFakeRunner()
  const config: ProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
    canvas: { keepForIdenticalDiff: scenario.keepForIdenticalDiff ?? true },
  }
  git = gitWithMerge(scenario.git)
  t = await makeTestContext({
    git,
    gh: ghFor42(),
    runner,
    projectConfig: { config, warnings: [], source: '/repo/pr-review.config.yml' },
  })
  await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA), 42)
  return t
}

async function bundle(refresh = false): Promise<PrBundle> {
  return json<PrBundle>(
    await createApp(t.ctx).request(`/api/prs/42${refresh ? '?refresh=1' : ''}`, { headers: LOCAL })
  )
}

/** The pull request moved on to `sha`, again with the identical diff. */
function headMovedTo(sha: string): void {
  Object.assign(git.options.refs ?? {}, { 'pull/42/head': sha })
  Object.assign(git.options.mergeBases ?? {}, { [`refs/pr/42/base..${sha}`]: BASE_SHA })
  Object.assign(git.options.diffs ?? {}, { [`${BASE_SHA}..${sha}`]: SYNTHETIC_DIFF })
  t.ctx.gh = ghFor42({
    routes: { 'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha } }) },
  })
}

describe('a canvas whose head moved on with the identical diff', () => {
  it('stays ready and says so', async () => {
    await withOldCanvas()
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.stale).toBeUndefined()
    expect(b.canvas?.headSha).toBe(OLD_SHA)
    expect(b.artifact?.pr.headSha).toBe(OLD_SHA)
    expect(b.pr.headSha).toBe(HEAD_SHA)
    expect(b.carriedOver).toEqual({ canvasHeadSha: OLD_SHA, currentHeadSha: HEAD_SHA })
    expect(b.skillCommand).toBe('/pr-review-canvas 42 --force')
  })

  it('is outdated when the diff differs, even by hunks the base merge moved down', async () => {
    await withOldCanvas({
      git: {
        diffs: {
          [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF_MOVED_BY_BASE,
          [`${BASE_SHA}..${OLD_SHA}`]: SYNTHETIC_DIFF,
        },
      },
    })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.carriedOver).toBeUndefined()
    expect(b.stale).toEqual({
      canvasHeadSha: OLD_SHA,
      currentHeadSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 3,
    })
  })

  it('is outdated when the project config marks every commit as a new head', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    expect((await bundle()).status).toBe('stale')
  })

  it('keeps the reviewer marks, which belong to the canvas, however often the head moves', async () => {
    await withOldCanvas()
    // A mark made on the carried-over page is recorded against the canvas's commit, not the head.
    const res = await createApp(t.ctx).request('/api/prs/42/reviewed/layer:layer-1', {
      method: 'PUT',
      headers: JSON_POST,
      body: JSON.stringify({ reviewed: true, headSha: HEAD_SHA }),
    })
    expect(res.status).toBe(200)
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(OLD_SHA)
    expect((await bundle()).state.reviewed).toEqual({ 'layer:layer-1': true })
    // The head moves again with the identical diff: the canvas and its marks still apply.
    headMovedTo('c'.repeat(40))
    const b = await bundle(true)
    expect(b.status).toBe('ready')
    expect(b.carriedOver).toEqual({ canvasHeadSha: OLD_SHA, currentHeadSha: 'c'.repeat(40) })
    expect(b.state.reviewed).toEqual({ 'layer:layer-1': true })
    const body = await json<ReviewBodyResponse>(
      await createApp(t.ctx).request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.unreviewed).toEqual([])
  })

  it('leaves the marks alone when the canvas is outdated after all', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    await t.ctx.state.update(42, state => ({
      ...state,
      reviewed: { 'layer:layer-1': true },
      reviewedHeadSha: OLD_SHA,
    }))
    const b = await bundle()
    expect(b.state.reviewed).toEqual({})
  })

  it('lets the sign-off routes use the canvas and the carried-over marks without a page load first', async () => {
    await withOldCanvas()
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD_SHA)
    const app = createApp(t.ctx)
    const body = await json<ReviewBodyResponse>(
      await app.request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.headSha).toBe(HEAD_SHA)
    expect(body.body).toContain(`Reviewed 1 of 1 layer on \`${HEAD_SHA.slice(0, 7)}\``)
    expect(body.unreviewed).toEqual([])
  })

  it('refuses the sign-off when the canvas is outdated', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    await bundle()
    const res = await createApp(t.ctx).request('/api/prs/42/review/body', { headers: LOCAL })
    expect(res.status).toBe(409)
    expect((await json<ErrorEnvelope>(res)).error.code).toBe('SIGNOFF_INCOMPLETE')
  })

  it('exports the canvas that stands for the head', async () => {
    await withOldCanvas()
    await bundle()
    const res = await createApp(t.ctx).request('/api/prs/42/export', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain(OLD_SHA.slice(0, 8))
  })
})

async function sendChat(): Promise<Response> {
  return createApp(t.ctx).request('/api/prs/42/chat', {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ message: 'what changed?', context: { kind: 'pr' } }),
  })
}

describe('the chat after the head moved', () => {
  it('talks about the canvas with the diff of the head when only merges came in', async () => {
    await withOldCanvas()
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    await res.text()
    expect(runner.runs).toHaveLength(1)
    // The agent reads the head's diffs, from the head's derived directory.
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(HEAD_SHA))
    expect(runner.runs[0]?.prompt).not.toContain(t.ctx.derived.derivedDir(OLD_SHA))
  })

  it('still talks about an outdated canvas, with the diff of its own commit', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    await res.text()
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(OLD_SHA))
    // The diffs of the older commit were built from the clone on the way.
    expect(await t.ctx.derived.read(OLD_SHA)).not.toBeNull()
  })

  it('says so when the outdated canvas has no diff on this machine', async () => {
    // The older commit is not in the clone, so its diff cannot be rebuilt.
    await withOldCanvas({
      keepForIdenticalDiff: false,
      git: { refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA } },
    })
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(404)
    expect((await json<ErrorEnvelope>(res)).error).toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('not available locally'),
    })
  })

  it('says so when the index names a canvas whose review.json is gone', async () => {
    await withOldCanvas()
    await rm(path.join(t.ctx.canvases.canvasDir(OLD_SHA), 'review.json'))
    const res = await sendChat()
    expect(res.status).toBe(404)
    expect((await json<ErrorEnvelope>(res)).error.code).toBe('CANVAS_NOT_FOUND')
  })
})
