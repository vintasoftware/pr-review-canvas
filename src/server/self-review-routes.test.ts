// @vitest-environment node
// The author settles attention points before review: the answer is written into the canvas, the
// canvas comment is shared again with the new tally, and the reason can go out as a comment.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { SettleResponse } from '../contract/self-review.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { readCanvasComment } from '../canvas/comment.js'
import { readCanvasZip } from '../canvas/zip.js'
import { HostCliError } from '../host/client.js'
import { artifactToModelOutput } from '../review/normalize.js'
import { prepare } from '../review/prepare.js'
import { publish } from '../review/publish.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import {
  type FakeGh,
  ghJson,
  ghPost,
  ghPostError,
  makeTestContext,
  moveFakeHead,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  ghFor42,
  gitFor42,
  gitForLocal,
  HEAD_SHA,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const SAME_ORIGIN = {
  host: 'localhost:3010',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
}

const MANIFEST: CanvasManifest = {
  formatVersion: 1,
  tool: { name: 'pr-review', version: '0.1.0' },
  repo: TEST_REPO,
  prNumber: 42,
  headSha: HEAD_SHA,
  mergeBaseSha: BASE_SHA,
  baseRef: 'main',
  headRef: 'feat/b',
  generatedAt: '2026-09-10T11:00:00.000Z',
  generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
}

const INLINE = {
  id: 5001,
  user: { login: 'octocat' },
  body: 'reason',
  path: 'src/app.ts',
  line: 13,
  original_line: 13,
  side: 'RIGHT',
  commit_id: HEAD_SHA,
  created_at: '2026-09-10T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
}

const CANVAS_COMMENT = {
  id: 6001,
  user: { login: 'octocat' },
  body: 'canvas',
  created_at: '2026-09-10T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
}

function gh(extra: Parameters<typeof ghFor42>[0] = {}): FakeGh {
  return ghFor42({
    ...extra,
    postRoutes: {
      'repos/acme/widgets/pulls/42/comments': ghPost(() => INLINE),
      'repos/acme/widgets/issues/42/comments': ghPost(() => CANVAS_COMMENT),
      ...extra.postRoutes,
    },
  })
}

async function withCanvas(forge: FakeGh = gh()): Promise<TestContext> {
  const t = await makeTestContext({ git: gitFor42(), gh: forge })
  await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), MANIFEST, 42)
  await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
  return t
}

async function settle(t: TestContext, key: string, fingerprint: string, body: unknown): Promise<Response> {
  return await createApp(t.ctx).request(`/api/prs/${key}/points/${fingerprint}/settled`, {
    method: 'PUT',
    headers: SAME_ORIGIN,
    body: JSON.stringify(body),
  })
}

async function answer(res: Response): Promise<SettleResponse> {
  expect(res.status).toBe(200)
  return (await res.json()) as SettleResponse
}

/** The canvas the last share put in the canvas comment. */
function sharedComment(forge: FakeGh): { text: string; settled: unknown } {
  const posts = forge.calls.filter(c => c.kind === 'post' && c.path.startsWith('repos/acme/widgets/issues/'))
  const text = (posts.at(-1)?.body as { body: string } | undefined)?.body ?? ''
  const zip = readCanvasComment(text)
  return { text, settled: zip === null ? null : readCanvasZip(zip.bytes).artifact.settled }
}

describe('settling an attention point', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('writes the reason into the canvas and shares it again with the new tally', async () => {
    const forge = gh()
    t = await withCanvas(forge)
    const body = await answer(await settle(t, '42', 'fp-2', { settled: true, reason: '  Covered by e2e.  ' }))
    const settlement = { reason: 'Covered by e2e.', at: '2026-09-10T12:00:00.000Z' }
    expect(body.settled).toEqual({ 'fp-2': settlement })
    expect(body.sharing).toEqual({ status: 'shared', url: CANVAS_COMMENT.html_url })
    const stored = await t.ctx.canvases.readArtifact(HEAD_SHA)
    expect(stored).toMatchObject({ settled: body.settled, revisedAt: '2026-09-10T12:00:00.000Z' })
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.revisedAt).toBe('2026-09-10T12:00:00.000Z')
    const shared = sharedComment(forge)
    expect(shared.settled).toEqual(body.settled)
    expect(shared.text).toContain('**Settled by the author:** 1, each with its reason in the canvas.')
    // Nothing went out as a line comment.
    expect(
      forge.calls.some(c => c.path === 'repos/acme/widgets/pulls/42/comments' && c.kind === 'post')
    ).toBe(false)
  })

  it('also posts the reason on the point’s line and links it from the settlement', async () => {
    const forge = gh()
    t = await withCanvas(forge)
    const body = await answer(
      await settle(t, '42', 'fp-2', {
        settled: true,
        reason: 'Covered by e2e.',
        comment: true,
        headSha: HEAD_SHA,
      })
    )
    expect(body.settled['fp-2']?.commentUrl).toBe(INLINE.html_url)
    expect(body.state.posted).toEqual([
      expect.objectContaining({ commentId: 5001, pointFingerprint: 'fp-2' }),
    ])
    const inline = forge.calls.find(
      c => c.kind === 'post' && c.path === 'repos/acme/widgets/pulls/42/comments'
    )
    expect(inline?.body).toMatchObject({
      path: 'src/app.ts',
      line: 13,
      side: 'RIGHT',
      body: '**Settled by the author:** other() has no test\n\nCovered by e2e.\n\n_from the pr-review canvas self-review_',
    })
  })

  it('reopens a settled point and shares the canvas without it', async () => {
    const forge = gh()
    t = await withCanvas(forge)
    await answer(await settle(t, '42', 'fp-2', { settled: true, reason: 'Covered.' }))
    const body = await answer(await settle(t, '42', 'fp-2', { settled: false }))
    expect(body.settled).toEqual({})
    expect(sharedComment(forge).settled).toEqual({})
  })

  it('keeps every settlement when two arrive together', async () => {
    t = await withCanvas()
    // Both requests start before either is answered, so their revisions overlap without the queue.
    await Promise.all([
      settle(t, '42', 'fp-2', { settled: true, reason: 'one' }).then(answer),
      settle(t, '42', 'fp-3', { settled: true, reason: 'two' }).then(answer),
    ])
    expect(Object.keys((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled ?? {}).sort()).toEqual([
      'fp-2',
      'fp-3',
    ])
  })

  it('keeps the settlement and hands back the zip when the canvas comment cannot be shared', async () => {
    t = await withCanvas(
      gh({ postRoutes: { 'repos/acme/widgets/issues/42/comments': ghPostError(new Error('rate limited')) } })
    )
    const body = await answer(await settle(t, '42', 'fp-2', { settled: true, reason: 'Covered.' }))
    expect(body.sharing).toMatchObject({ status: 'failed', warning: expect.stringContaining('rate limited') })
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toEqual(body.settled)
  })

  it('writes nothing when the reason cannot be posted', async () => {
    t = await withCanvas(
      gh({
        postRoutes: {
          'repos/acme/widgets/pulls/42/comments': ghPostError(new HostCliError('gh', 'x', 'HTTP 422', 1)),
        },
      })
    )
    const res = await settle(t, '42', 'fp-2', { settled: true, reason: 'Covered.', comment: true })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toBeUndefined()
  })

  it('refuses a point marked for the reviewer: its judgment is not the author’s to give', async () => {
    t = await withCanvas()
    const res = await settle(t, '42', 'fp-1', { settled: true, reason: 'The spec says sum.' })
    expect(res.status).toBe(400)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toBeUndefined()
  })

  it('refuses a login that did not write the pull request', async () => {
    t = await withCanvas(gh({ routes: { user: ghJson({ login: 'reviewer' }) } }))
    const res = await settle(t, '42', 'fp-2', { settled: true, reason: 'Covered.' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_AUTHOR' } })
  })

  it.each([
    [{ settled: true }, 400],
    [{ settled: true, reason: '   ' }, 400],
    [{ settled: true, reason: 'r'.repeat(601) }, 400],
  ])('refuses a settlement without a usable reason %#', async (body, status) => {
    t = await withCanvas()
    expect((await settle(t, '42', 'fp-2', body)).status).toBe(status)
  })

  it('refuses a point the canvas does not have, and a page drawn for another head', async () => {
    t = await withCanvas()
    expect((await settle(t, '42', 'nope', { settled: true, reason: 'r' })).status).toBe(404)
    const stale = await settle(t, '42', 'fp-2', { settled: true, reason: 'r', headSha: 'c'.repeat(40) })
    expect(stale.status).toBe(409)
  })

  it('refuses a canvas generated for another commit', async () => {
    const git = gitFor42()
    t = await makeTestContext({ git, gh: gh() })
    await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), MANIFEST, 42)
    moveFakeHead(git, {
      headRef: 'pull/42/head',
      baseRef: 'refs/pr/42/base',
      headSha: 'c'.repeat(40),
      mergeBaseSha: BASE_SHA,
      diff: SYNTHETIC_DIFF.replace('a() + b()', 'a() * c()'),
    })
    const res = await settle(t, '42', 'fp-2', { settled: true, reason: 'r' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'CANVAS_STALE' } })
  })

  it('says a point is gone when the canvas file went missing under the index', async () => {
    t = await withCanvas()
    await rm(path.join(t.ctx.canvases.canvasDir(HEAD_SHA), 'review.json'))
    expect((await settle(t, '42', 'fp-2', { settled: true, reason: 'r' })).status).toBe(404)
  })

  it('refuses the read-only fixture canvas', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: gh(), fixtureArtifact: syntheticArtifact() })
    expect((await settle(t, '42', 'fp-2', { settled: true, reason: 'r' })).status).toBe(501)
  })
})

/** The fingerprint of the first point marked for the author on the stored canvas. */
async function authorPoint(t: TestContext): Promise<string> {
  const points = (await t.ctx.canvases.readArtifact(HEAD_SHA))?.points ?? []
  return points.find(p => p.audience === 'author')?.fingerprint ?? ''
}

describe('settling on a local review', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('writes the canvas without an author check and shares nothing', async () => {
    const forge = gh({ routes: { user: ghJson({ login: 'someone-else' }) } })
    t = await makeTestContext({ git: gitForLocal(), gh: forge })
    const prepared = await prepare(
      t.ctx,
      { kind: 'local', base: 'origin/main', source: 'uncommitted' },
      {
        force: false,
        log: () => undefined,
      }
    )
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    await publish(t.ctx, prepared.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
    const fingerprint = await authorPoint(t)
    const body = await answer(
      await settle(t, 'uncommitted', fingerprint, { settled: true, reason: 'Known.' })
    )
    expect(body.sharing).toEqual({ status: 'local' })
    expect(Object.keys(body.settled)).toEqual([fingerprint])
    expect(forge.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('refuses to post the reason: local work has no pull request', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: gh() })
    const prepared = await prepare(
      t.ctx,
      { kind: 'local', base: 'origin/main', source: 'uncommitted' },
      {
        force: false,
        log: () => undefined,
      }
    )
    await writeTextAtomic(
      `${prepared.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    await publish(t.ctx, prepared.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
    const fingerprint = await authorPoint(t)
    const res = await settle(t, 'uncommitted', fingerprint, {
      settled: true,
      reason: 'Known.',
      comment: true,
    })
    expect(res.status).toBe(400)
  })
})

describe('the bundle', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it.each([
    ['octocat', true],
    ['OctoCat', true],
    ['reviewer', false],
  ])('offers self-review when %s runs the server: %s', async (login, selfReview) => {
    t = await withCanvas(gh({ routes: { user: ghJson({ login }) } }))
    const res = await createApp(t.ctx).request('/api/prs/42', { headers: { host: 'localhost:3010' } })
    expect(((await res.json()) as { selfReview: boolean }).selfReview).toBe(selfReview)
  })
})
