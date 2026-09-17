// @vitest-environment node
// A pull request whose head only merged other branches in since its canvas was generated: the
// canvas stays current, the reviewer's marks move along, and the chat keeps working. The same
// routes with the strict reading, when the project or the host's conflict report says so.
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
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, origin: 'http://localhost:3010', 'sec-fetch-site': 'same-origin' }
const JSON_POST = { ...SAME_ORIGIN, 'content-type': 'application/json' }
/** The commit the canvas was generated for; HEAD_SHA merged the base onto it afterwards. */
const OLD_SHA = 'e'.repeat(40)
/** A canvas zip generated for HEAD_SHA itself, attached to the pull request. */
const HEAD_ZIP_URL =
  'https://github.com/user-attachments/files/12345/pr-42-20260910T120000Z-aaaaaaaa-acme-widgets-canvas.zip'

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

const OLD_DIFF = [
  'diff --git a/src/old-only.ts b/src/old-only.ts',
  'index 1111111..2222222 100644',
  '--- a/src/old-only.ts',
  '+++ b/src/old-only.ts',
  '@@ -1,2 +1,2 @@',
  '-export const version = 1',
  '+export const version = 2',
  ' export const keep = true',
  '',
].join('\n')

/**
 * PR #42 at HEAD_SHA, three commits after OLD_SHA: one merge commit on the branch's own line, and
 * the two base commits it brought in. `extra` overrides the history, e.g. to add a plain commit.
 */
function gitWithMerge(extra: FakeGitOptions = {}) {
  return createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, old: OLD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`${BASE_SHA}..${OLD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF, [`${BASE_SHA}..${OLD_SHA}`]: OLD_DIFF },
    blobs: SYNTHETIC_BLOBS,
    ancestors: { [`${OLD_SHA}..${HEAD_SHA}`]: true },
    counts: { [`${OLD_SHA}..${HEAD_SHA}`]: 3 },
    nonMergeCounts: { [`${HEAD_SHA} ^${OLD_SHA} ^${BASE_SHA}`]: 0 },
    topLevel: '/repo',
    ...extra,
  })
}

interface Scenario {
  mergeable?: boolean | null
  ignoreMergeCommits?: boolean
  git?: FakeGitOptions
  /** The pull request description, where a canvas zip may be attached. */
  body?: string
  /** What downloading an attachment answers. */
  fetch?: typeof fetch
}

let t: TestContext
let runner: FakeRunner
afterEach(() => t?.cleanup())

/** A context holding the canvas of OLD_SHA, with the pull request now at HEAD_SHA. */
async function withOldCanvas(scenario: Scenario = {}): Promise<TestContext> {
  runner = createFakeRunner()
  const pull = {
    ...GH_PULL,
    mergeable: scenario.mergeable === undefined ? true : scenario.mergeable,
    body: scenario.body ?? GH_PULL.body,
  }
  const config: ProjectConfig = {
    ...DEFAULT_PROJECT_CONFIG,
    canvas: { ignoreMergeCommits: scenario.ignoreMergeCommits ?? true },
  }
  t = await makeTestContext({
    git: gitWithMerge(scenario.git),
    gh: ghFor42({ routes: { 'repos/acme/widgets/pulls/42': ghJson(pull) } }),
    runner,
    projectConfig: { config, warnings: [], source: '/repo/pr-review.config.yml' },
    ...(scenario.fetch === undefined ? {} : { fetch: scenario.fetch }),
  })
  await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA), 42)
  return t
}

async function bundle(): Promise<PrBundle> {
  return json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
}

describe('a canvas whose head only gained merge commits', () => {
  it('stays ready, says so, and shows the diffs of the head', async () => {
    await withOldCanvas()
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.stale).toBeUndefined()
    expect(b.canvas?.headSha).toBe(OLD_SHA)
    expect(b.artifact?.pr.headSha).toBe(OLD_SHA)
    expect(b.pr.headSha).toBe(HEAD_SHA)
    expect(b.pr.mergeable).toBe(true)
    expect(b.mergesSince).toEqual({ canvasHeadSha: OLD_SHA, currentHeadSha: HEAD_SHA, commitsBehind: 3 })
    // The head's own diff, not the older commit's.
    expect(b.files.map(f => f.path)).toContain('src/app.ts')
    expect(b.files.map(f => f.path)).not.toContain('src/old-only.ts')
    expect(b.skillCommand).toBe('/pr-review-canvas 42 --force')
  })

  it('is outdated while the host is still checking for conflicts', async () => {
    await withOldCanvas({ mergeable: null })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.mergesSince).toBeUndefined()
    expect(b.stale).toEqual({
      canvasHeadSha: OLD_SHA,
      currentHeadSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 3,
    })
  })

  it('is outdated when the host reports conflicts', async () => {
    await withOldCanvas({ mergeable: false })
    expect((await bundle()).status).toBe('stale')
  })

  it('is outdated when the project config counts merge commits', async () => {
    await withOldCanvas({ ignoreMergeCommits: false })
    expect((await bundle()).status).toBe('stale')
  })

  it('is outdated once an ordinary commit came in, on the branch or from a branch the base lacks', async () => {
    await withOldCanvas({ git: { nonMergeCounts: { [`${HEAD_SHA} ^${OLD_SHA} ^${BASE_SHA}`]: 1 } } })
    const b = await bundle()
    expect(b.status).toBe('stale')
    expect(b.stale?.commitsBehind).toBe(3)
  })

  it('still takes a canvas attached to the pull request when it was generated for the head itself', async () => {
    const bytes = buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))
    await withOldCanvas({
      body: `canvas: ${HEAD_ZIP_URL}`,
      fetch: async () => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 }),
    })
    const b = await bundle()
    expect(b.status).toBe('ready')
    expect(b.mergesSince).toBeUndefined()
    expect(b.canvas?.headSha).toBe(HEAD_SHA)
    expect(b.sharedCanvas).toMatchObject({ url: HEAD_ZIP_URL, matchesHead: true, downloadable: true })
  })

  it('carries the reviewer marks over to the new head', async () => {
    await withOldCanvas()
    await t.ctx.state.update(42, state => ({
      ...state,
      reviewed: { 'layer:layer-1': true },
      reviewedHeadSha: OLD_SHA,
    }))
    const b = await bundle()
    expect(b.state.reviewed).toEqual({ 'layer:layer-1': true })
    expect(b.state.reviewedHeadSha).toBe(HEAD_SHA)
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(HEAD_SHA)
    // A second load has nothing left to move.
    const rev = (await t.ctx.state.read(42)).rev
    await bundle()
    expect((await t.ctx.state.read(42)).rev).toBe(rev)
  })

  it('leaves the marks alone when the canvas is outdated after all', async () => {
    await withOldCanvas({ mergeable: false })
    await t.ctx.state.update(42, state => ({
      ...state,
      reviewed: { 'layer:layer-1': true },
      reviewedHeadSha: OLD_SHA,
    }))
    const b = await bundle()
    expect(b.state.reviewed).toEqual({})
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(OLD_SHA)
  })

  it('lets the sign-off routes use the canvas for the current head, with the marks moved along', async () => {
    await withOldCanvas()
    await t.ctx.state.update(42, state => ({
      ...state,
      reviewed: { 'layer:layer-1': true },
      reviewedHeadSha: OLD_SHA,
    }))
    // No bundle was loaded first: the sign-off routes apply the rule themselves.
    const app = createApp(t.ctx)
    const body = await json<ReviewBodyResponse>(
      await app.request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.headSha).toBe(HEAD_SHA)
    expect(body.body).toContain(`Reviewed 1 of 1 layer on \`${HEAD_SHA.slice(0, 7)}\``)
    expect(body.unreviewed).toEqual([])
    expect((await t.ctx.state.read(42)).reviewedHeadSha).toBe(HEAD_SHA)
  })

  it('refuses the sign-off when the canvas is outdated', async () => {
    await withOldCanvas({ mergeable: null })
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
    await withOldCanvas({ mergeable: null })
    await bundle()
    const res = await sendChat()
    expect(res.status).toBe(200)
    await res.text()
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]?.prompt).toContain(t.ctx.derived.derivedDir(OLD_SHA))
    // The diffs of the older commit were built from the clone on the way.
    const derived = await t.ctx.derived.read(OLD_SHA)
    expect(derived?.files.map(f => f.path)).toEqual(['src/old-only.ts'])
  })

  it('says so when the outdated canvas has no diff on this machine', async () => {
    // The older commit is not in the clone, so its diff cannot be rebuilt.
    await withOldCanvas({
      mergeable: null,
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
