// @vitest-environment node
// A pull request whose head moved on since its canvas was generated but has the identical diff:
// the canvas is carried over, the reviewer's marks move along, and the chat keeps working. The
// same routes with the strict reading, when the project says so or the head's diff differs.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { ErrorEnvelope, PrBundle, ReviewBodyResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { buildCanvasZip } from '../canvas/zip.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import { createFakeRunner, type FakeRunner } from '../testing/fake-runner.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
  ghJson,
  makeTestContext,
  moveFakeHead,
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
  /** The pull request body, where a shared canvas zip may be linked. */
  body?: string
  fetch?: typeof fetch
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
  const pull = scenario.body === undefined ? GH_PULL : { ...GH_PULL, body: scenario.body }
  t = await makeTestContext({
    git,
    gh: ghFor42({ routes: { 'repos/acme/widgets/pulls/42': ghJson(pull) } }),
    runner,
    projectConfig: { config, warnings: [], source: '/repo/pr-review.config.yml' },
    ...(scenario.fetch === undefined ? {} : { fetch: scenario.fetch }),
  })
  await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA), 42)
  return t
}

async function bundle(refresh = false): Promise<PrBundle> {
  return json<PrBundle>(
    await createApp(t.ctx).request(`/api/prs/42${refresh ? '?refresh=1' : ''}`, { headers: LOCAL })
  )
}

/** The pull request moved on to `sha`, `behind` commits past OLD_SHA, again with the identical diff. */
function headMovedTo(sha: string, behind = 5): void {
  moveFakeHead(git, {
    headRef: 'pull/42/head',
    baseRef: 'refs/pr/42/base',
    headSha: sha,
    mergeBaseSha: BASE_SHA,
    diff: SYNTHETIC_DIFF,
    ahead: { [OLD_SHA]: behind },
  })
  prNowAt(sha)
}

/**
 * The base branch advanced under the same head: the head's diff is now taken against the new
 * merge base, which is where a base merge shows up as moved hunks.
 */
function baseAdvancedTo(sha: string, diff: string): void {
  moveFakeHead(git, {
    headRef: 'pull/42/head',
    baseRef: 'refs/pr/42/base',
    headSha: HEAD_SHA,
    mergeBaseSha: sha,
    diff,
    ahead: { [OLD_SHA]: 3 },
  })
}

/** GitHub now reports `sha` as the head of the pull request. */
function prNowAt(sha: string): void {
  t.ctx.gh = ghFor42({
    routes: { 'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha } }) },
  })
}

/** A mark on the one layer of the synthetic canvas, with whatever body the test wants to send. */
async function markLayer1(body: Record<string, unknown>): Promise<Response> {
  return createApp(t.ctx).request('/api/prs/42/reviewed/layer:layer-1', {
    method: 'PUT',
    headers: JSON_POST,
    body: JSON.stringify(body),
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
    expect(b.carriedOver).toEqual({ canvasHeadSha: OLD_SHA, currentHeadSha: HEAD_SHA, commitsBehind: 3 })
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

  it('is outdated when merging another branch brought a sibling file into the diff', async () => {
    const withSibling = [
      SYNTHETIC_DIFF,
      'diff --git a/src/sibling.ts b/src/sibling.ts',
      'new file mode 100644',
      'index 0000000..cccdddd',
      '--- /dev/null',
      '+++ b/src/sibling.ts',
      '@@ -0,0 +1 @@',
      '+export const sibling = true',
    ].join('\n')
    await withOldCanvas({
      git: {
        diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: withSibling, [`${BASE_SHA}..${OLD_SHA}`]: SYNTHETIC_DIFF },
      },
    })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.carriedOver).toBeUndefined()
  })

  it('imports a zip regenerated for the head itself over a carried-over canvas', async () => {
    const url =
      'https://github.com/user-attachments/files/12345/pr-42-20260910T120000Z-aaaaaaaa-acme-widgets-canvas.zip'
    const zip = buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))
    await withOldCanvas({
      body: `canvas: ${url}`,
      fetch: async () => new Response(zip.slice().buffer as ArrayBuffer, { status: 200 }),
    })
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.canvas?.headSha).toBe(HEAD_SHA)
    expect(b.canvas?.source).toBe('import')
    expect(b.carriedOver).toBeUndefined()
  })

  it('is outdated when the project config marks every commit as a new head', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    expect((await bundle()).status).toBe('stale')
  })

  it('keeps the reviewer marks, which belong to the canvas, however often the head moves', async () => {
    await withOldCanvas()
    // A mark made on the carried-over page is recorded against the canvas's commit, not the head.
    const res = await markLayer1({ reviewed: true, headSha: HEAD_SHA, canvasSha: OLD_SHA })
    expect(res.status).toBe(200)
    expect((await t.ctx.state.read(42)).reviewedCanvasSha).toBe(OLD_SHA)
    expect((await bundle()).state.reviewed).toEqual({ 'layer:layer-1': true })
    // The head moves again with the identical diff: the canvas and its marks still apply.
    headMovedTo('c'.repeat(40))
    const b = await bundle(true)
    expect(b.status).toBe('ready')
    expect(b.carriedOver).toEqual({
      canvasHeadSha: OLD_SHA,
      currentHeadSha: 'c'.repeat(40),
      commitsBehind: 5,
    })
    expect(b.state.reviewed).toEqual({ 'layer:layer-1': true })
    const body = await json<ReviewBodyResponse>(
      await createApp(t.ctx).request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.unreviewed).toEqual([])
  })

  it('shows the marks made on an outdated canvas with it, and never credits them to a later canvas', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    // The outdated view shows the older canvas and its diff, so a mark made there is the older canvas's.
    const res = await markLayer1({ reviewed: true, headSha: HEAD_SHA, canvasSha: OLD_SHA })
    expect(res.status).toBe(200)
    expect((await t.ctx.state.read(42)).reviewedCanvasSha).toBe(OLD_SHA)
    const outdated = await bundle()
    expect(outdated.status).toBe('stale')
    expect(outdated.state.reviewed).toEqual({ 'layer:layer-1': true })
    // A canvas generated for the head afterwards starts unreviewed.
    await t.ctx.canvases.write(HEAD_SHA, artifactFor(HEAD_SHA), manifest(HEAD_SHA), 42)
    const current = await bundle()
    expect(current.status).toBe('ready')
    expect(current.state.reviewed).toEqual({})
  })

  it('marks a layer without running git: the page names the canvas its marks belong to', async () => {
    await withOldCanvas()
    await bundle()
    const before = git.calls.length
    const res = await markLayer1({ reviewed: true, headSha: HEAD_SHA, canvasSha: OLD_SHA })
    expect(res.status).toBe(200)
    // No ancestry walk, no rev-list, no diff: the canvas the page names is looked up in the index.
    expect(git.calls.slice(before)).toEqual([])
    expect((await t.ctx.state.read(42)).reviewedCanvasSha).toBe(OLD_SHA)
  })

  it('refuses a mark that names a commit which is not a canvas of this pull request', async () => {
    await withOldCanvas()
    await bundle()
    const res = await markLayer1({ reviewed: true, headSha: HEAD_SHA, canvasSha: '7'.repeat(40) })
    expect(res.status).toBe(404)
    expect((await json<ErrorEnvelope>(res)).error.code).toBe('CANVAS_NOT_FOUND')
    expect((await t.ctx.state.read(42)).reviewed).toEqual({})
  })

  it('refuses a mark that names a canvas of another pull request', async () => {
    await withOldCanvas()
    const otherPr = '8'.repeat(40)
    await t.ctx.canvases.write(otherPr, artifactFor(otherPr), { ...manifest(otherPr), prNumber: 43 }, 43)
    const res = await markLayer1({ reviewed: true, headSha: HEAD_SHA, canvasSha: otherPr })
    expect(res.status).toBe(404)
    expect((await t.ctx.state.read(42)).reviewed).toEqual({})
  })

  it('reads the canvas as outdated when the base advanced under the same head', async () => {
    await withOldCanvas()
    expect((await bundle()).carriedOver).toBeDefined()
    // The head did not move; its diff is now taken against the base branch's new tip, where the
    // merged commits pushed every hunk down. The canvas explains the diff that is gone.
    baseAdvancedTo('9'.repeat(40), SYNTHETIC_DIFF_MOVED_BY_BASE)
    const b = await bundle(true)
    expect(b.status).toBe('stale')
    expect(b.carriedOver).toBeUndefined()
    expect(b.pr.headSha).toBe(HEAD_SHA)
    expect(b.stale).toEqual({
      canvasHeadSha: OLD_SHA,
      currentHeadSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 3,
    })
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
    // The seed header names that same commit: the diffs and the words about them agree.
    expect(runner.runs[0]?.prompt).toContain(`head \`${HEAD_SHA.slice(0, 7)}\``)
    expect(runner.runs[0]?.prompt).not.toContain(`head \`${OLD_SHA.slice(0, 7)}\``)
  })

  it('still talks about an outdated canvas, with the diff of its own commit', async () => {
    await withOldCanvas({ keepForIdenticalDiff: false })
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    await res.text()
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(OLD_SHA))
    // The canvas is read with its own commit's diff, so the header names that commit.
    expect(runner.runs[0]?.prompt).toContain(`head \`${OLD_SHA.slice(0, 7)}\``)
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
