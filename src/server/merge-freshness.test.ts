// @vitest-environment node
// A pull request whose head moved on without changing its diff (the base branch merged in): the
// canvas stays current, the reviewer's marks move along, and the chat keeps working. The strict
// reading returns as soon as the diff differs, or when the project counts every commit.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { buildCanvasZip } from '../canvas/zip.js'
import type { ErrorEnvelope, PrBundle, ReviewBodyResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig } from '../project-config.js'
import { createFakeRunner, type FakeRunner } from '../testing/fake-runner.js'
import {
  createFakeGit,
  type FakeGit,
  type FakeGitOptions,
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
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, origin: 'http://localhost:3010', 'sec-fetch-site': 'same-origin' }
const JSON_POST = { ...SAME_ORIGIN, 'content-type': 'application/json' }
/** The commit the canvas was generated for; HEAD_SHA is three commits later. */
const OLD_SHA = 'e'.repeat(40)
/** A canvas zip for HEAD_SHA itself, attached to the PR after the author merged main. */
const HEAD_ZIP_URL =
  'https://github.com/user-attachments/files/12346/pr-42-20260911T110000Z-aaaaaaaa-acme-widgets-canvas.zip'

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

/** A sibling branch merged in: the head's diff gained a file the canvas never saw. */
const WITH_SIBLING_FILE =
  SYNTHETIC_DIFF +
  [
    'diff --git a/src/sibling.ts b/src/sibling.ts',
    'new file mode 100644',
    'index 0000000..3333333',
    '--- /dev/null',
    '+++ b/src/sibling.ts',
    '@@ -0,0 +1 @@',
    '+export const sibling = true',
    '',
  ].join('\n')

/** The base branch touched `src/app.ts` above the change: the same hunk, one line further down. */
const WITH_SHIFTED_HUNK = SYNTHETIC_DIFF.replace('@@ -1,4 +1,5 @@', '@@ -2,4 +2,5 @@')

/**
 * PR #42 at HEAD_SHA, three commits after OLD_SHA. `headDiff` is the head's diff against the base;
 * the canvas's commit always diffs to SYNTHETIC_DIFF.
 */
function gitWithHistory(headDiff: string, extra: FakeGitOptions = {}) {
  return createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, old: OLD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`${BASE_SHA}..${OLD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: headDiff, [`${BASE_SHA}..${OLD_SHA}`]: SYNTHETIC_DIFF },
    blobs: SYNTHETIC_BLOBS,
    ancestors: { [`${OLD_SHA}..${HEAD_SHA}`]: true },
    counts: { [`${OLD_SHA}..${HEAD_SHA}`]: 3 },
    topLevel: '/repo',
    ...extra,
  })
}

interface Scenario {
  headDiff?: string
  keepWhenDiffUnchanged?: boolean
  git?: FakeGitOptions
  /** The PR body names a canvas zip, and this is what downloading it answers. */
  attachment?: { body: string; fetch: typeof fetch }
}

let t: TestContext
let runner: FakeRunner
afterEach(() => t?.cleanup())

/** A context holding the canvas of OLD_SHA, with the pull request now at HEAD_SHA. */
async function withOldCanvas(scenario: Scenario = {}): Promise<TestContext> {
  runner = createFakeRunner()
  const config: ProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
    canvas: { keepWhenDiffUnchanged: scenario.keepWhenDiffUnchanged ?? true },
  }
  const attachment = scenario.attachment
  t = await makeTestContext({
    git: gitWithHistory(scenario.headDiff ?? SYNTHETIC_DIFF, scenario.git),
    gh:
      attachment === undefined
        ? ghFor42()
        : ghFor42({
            routes: {
              'repos/acme/widgets/pulls/42': { kind: 'json', body: { ...GH_PULL, body: attachment.body } },
            },
          }),
    runner,
    projectConfig: { config, warnings: [], source: '/repo/pr-review.config.yml' },
    ...(attachment === undefined ? {} : { fetch: attachment.fetch }),
  })
  await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA), 42)
  return t
}

async function bundle(): Promise<PrBundle> {
  return json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
}

async function markReviewedOnOld(): Promise<void> {
  await t.ctx.state.update(42, state => ({
    ...state,
    reviewed: { 'layer:layer-1': true },
    reviewedHeadSha: OLD_SHA,
  }))
}

describe('a canvas whose head moved without changing the diff', () => {
  it('stays ready, says so, and shows the diffs of the head', async () => {
    await withOldCanvas()
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.stale).toBeUndefined()
    expect(b.canvas?.headSha).toBe(OLD_SHA)
    expect(b.artifact?.pr.headSha).toBe(OLD_SHA)
    expect(b.pr.headSha).toBe(HEAD_SHA)
    expect(b.commitsSinceCanvas).toBe(3)
    expect(b.files.map(f => f.path)).toContain('src/app.ts')
    expect(b.skillCommand).toBe('/pr-review-canvas 42 --force')
  })

  it('imports a canvas attached for the head itself over the older one that still applies', async () => {
    // The README workflow: the author merged main, regenerated the canvas, and attached the zip.
    const bytes = buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))
    let fetches = 0
    await withOldCanvas({
      attachment: {
        body: `canvas: ${HEAD_ZIP_URL}`,
        fetch: async () => {
          fetches++
          return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
        },
      },
    })
    const b = await bundle()
    expect(fetches).toBe(1)
    expect(b.status).toBe('ready')
    expect(b.canvas?.headSha).toBe(HEAD_SHA)
    expect(b.canvas?.source).toBe('import')
    expect(b.commitsSinceCanvas).toBeUndefined()
    expect(b.sharedCanvas).toMatchObject({ url: HEAD_ZIP_URL, matchesHead: true, downloadable: true })
  })

  it('is outdated when a merge brought in code the canvas never saw', async () => {
    await withOldCanvas({ headDiff: WITH_SIBLING_FILE })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.commitsSinceCanvas).toBeUndefined()
    expect(b.stale).toEqual({
      canvasHeadSha: OLD_SHA,
      currentHeadSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 3,
    })
    // The outdated view shows the canvas's own commit, whose diff has no such file.
    expect(b.files.map(f => f.path)).not.toContain('src/sibling.ts')
  })

  it('is outdated when the base moved the hunks the canvas anchors to', async () => {
    await withOldCanvas({ headDiff: WITH_SHIFTED_HUNK })
    expect((await bundle()).status).toBe('stale')
  })

  it('is outdated when the project config counts every commit', async () => {
    await withOldCanvas({ keepWhenDiffUnchanged: false })
    expect((await bundle()).status).toBe('stale')
  })

  it('is outdated when the clone cannot diff the canvas commit', async () => {
    // OLD_SHA is not in the clone, so there is nothing to compare the head with.
    await withOldCanvas({
      git: { refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA } },
    })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.derivable).toBe(false)
  })

  it('rebuilds the head diff when the base branch advanced under a fixed head', async () => {
    await withOldCanvas()
    expect((await bundle()).status).toBe('ready')
    // main moved on and now contains everything but the change to src/app.ts.
    const newBase = 'f'.repeat(40)
    const git = t.ctx.git as FakeGit
    git.options.refs['refs/heads/main'] = newBase
    git.options.mergeBases[`refs/pr/42/base..${HEAD_SHA}`] = newBase
    git.options.diffs[`${newBase}..${HEAD_SHA}`] = SYNTHETIC_DIFF.split('diff --git a/src/new.ts')[0] ?? ''
    const b = await json<PrBundle>(
      await createApp(t.ctx).request('/api/prs/42?refresh=1', { headers: LOCAL })
    )
    expect(b.pr.mergeBaseSha).toBe(newBase)
    // The head's diff was rebuilt against the new base, so the canvas no longer explains it.
    expect((await t.ctx.derived.read(HEAD_SHA))?.files.map(f => f.path)).toEqual(['src/app.ts'])
    expect(b.status).toBe('stale')
    expect(b.stale?.canvasHeadSha).toBe(OLD_SHA)
  })

  it('carries the reviewer marks over to the new head, once', async () => {
    await withOldCanvas()
    await bundle()
    await markReviewedOnOld()
    const b = await bundle()
    expect(b.state.reviewed).toEqual({ 'layer:layer-1': true })
    expect(b.state.reviewedHeadSha).toBe(HEAD_SHA)
    const rev = (await t.ctx.state.read(42)).rev
    await bundle()
    expect((await t.ctx.state.read(42)).rev).toBe(rev)
  })

  it('leaves the marks alone when the canvas is outdated after all', async () => {
    await withOldCanvas({ headDiff: WITH_SIBLING_FILE })
    await bundle()
    await markReviewedOnOld()
    const b = await bundle()
    expect(b.state.reviewed).toEqual({})
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(OLD_SHA)
  })

  it('answers the sign-off routes the same way, with or without a page load first', async () => {
    await withOldCanvas()
    // The marks were made on the page that showed OLD_SHA as the head, which built its diff.
    await t.ctx.derived.ensure(OLD_SHA, BASE_SHA)
    await markReviewedOnOld()
    const app = createApp(t.ctx)
    const body = await json<ReviewBodyResponse>(
      await app.request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.headSha).toBe(HEAD_SHA)
    expect(body.body).toContain(`Reviewed 1 of 1 layer on \`${HEAD_SHA.slice(0, 7)}\``)
    expect(body.unreviewed).toEqual([])
    expect((await bundle()).state.reviewed).toEqual({ 'layer:layer-1': true })
  })

  it('refuses the sign-off when the canvas is outdated', async () => {
    await withOldCanvas({ headDiff: WITH_SIBLING_FILE })
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

describe('StateStore.moveReviewedHead', () => {
  it('re-keys marks to the new head, and writes nothing when there is nothing to move', async () => {
    await withOldCanvas()
    const untouched = await t.ctx.state.moveReviewedHead(42, HEAD_SHA)
    expect(untouched.reviewedHeadSha).toBeUndefined()
    expect(untouched.rev).toBe((await t.ctx.state.read(42)).rev)
    await t.ctx.state.setReviewed(42, 'layer:layer-1', true, OLD_SHA)
    const moved = await t.ctx.state.moveReviewedHead(42, HEAD_SHA)
    expect(moved.reviewed).toEqual({ 'layer:layer-1': true })
    expect(moved.reviewedHeadSha).toBe(HEAD_SHA)
    expect((await t.ctx.state.moveReviewedHead(42, HEAD_SHA)).rev).toBe(moved.rev)
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
  it('talks about the canvas with the diff of the head when the diff is unchanged', async () => {
    await withOldCanvas()
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    await res.text()
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(HEAD_SHA))
    expect(runner.runs[0]?.prompt).not.toContain(t.ctx.derived.derivedDir(OLD_SHA))
  })

  it('still talks about an outdated canvas, with the diff of its own commit', async () => {
    await withOldCanvas({ headDiff: WITH_SIBLING_FILE })
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    await res.text()
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(OLD_SHA))
    const derived = await t.ctx.derived.read(OLD_SHA)
    expect(derived?.files.map(f => f.path)).not.toContain('src/sibling.ts')
  })

  it('says so when the outdated canvas has no diff on this machine', async () => {
    await withOldCanvas({
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
