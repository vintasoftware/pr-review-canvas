// @vitest-environment node
// The author settles attention points before review: the answer is written into the canvas, the
// canvas comment is shared again with the new tally, and the reason can go out as a comment.
import { readFile, rm } from 'node:fs/promises'
import { ReviewArtifactSchema } from '../contract/review-artifact.js'
import { importCanvas } from '../canvas/import.js'
import { buildCanvasZip } from '../canvas/zip.js'
import { GH_PULL } from '../testing/synthetic.js'
import { PACKAGE_ROOT } from './context.js'
import * as atomicJson from '../store/atomic-json.js'
import { check } from 'proper-lockfile'
import * as lockfile from 'proper-lockfile'
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
  ghHandler,
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

vi.mock('proper-lockfile', async importOriginal => {
  const actual = await importOriginal<typeof import('proper-lockfile')>()
  return { ...actual, lock: vi.fn(actual.lock) }
})

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
      'repos/acme/widgets/issues/42/comments': ghPost(body => ({ ...CANVAS_COMMENT, ...(body as object) })),
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
    expect(body.issueComments).toContainEqual(
      expect.objectContaining({ id: 6001, body: expect.stringContaining('**Resolved by the author:** 1') })
    )
    expect((await t.ctx.prs.readComments(42))?.issueComments).toEqual(body.issueComments)
    const stored = await t.ctx.canvases.readArtifact(HEAD_SHA)
    expect(stored).toMatchObject({ settled: body.settled, revisedAt: '2026-09-10T12:00:00.000Z' })
    expect((await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]?.revisedAt).toBe('2026-09-10T12:00:00.000Z')
    const shared = sharedComment(forge)
    expect(shared.settled).toEqual(body.settled)
    expect(shared.text).toContain('**Resolved by the author:** 1, each with its reason in the canvas.')
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
    expect(body.state.posted).toEqual([expect.objectContaining({ commentId: 5001 })])
    // The receipt does not name the point, which stays unposted once it is reopened.
    expect(body.state.posted[0]).not.toHaveProperty('pointFingerprint')
    const inline = forge.calls.find(
      c => c.kind === 'post' && c.path === 'repos/acme/widgets/pulls/42/comments'
    )
    expect(inline?.body).toMatchObject({
      path: 'src/app.ts',
      line: 13,
      side: 'RIGHT',
      body: '**Resolved by the author:** other() has no test\n\nCovered by e2e.\n\n_from the pr-review canvas self-review_',
    })
  })

  it('follows the sharing switches: no canvas comment, and a reason without the canvas credit', async () => {
    const forge = gh()
    t = await withCanvas(forge)
    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...t.ctx.projectConfig.config, sharing: { canvasComment: false, mentionCanvas: false } },
    }
    const body = await answer(
      await settle(t, '42', 'fp-2', {
        settled: true,
        reason: 'Covered by e2e.',
        comment: true,
        headSha: HEAD_SHA,
      })
    )
    expect(body.sharing).toEqual({ status: 'off' })
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toEqual(body.settled)
    expect(forge.calls.some(c => c.kind === 'post' && c.path.startsWith('repos/acme/widgets/issues/'))).toBe(
      false
    )
    const inline = forge.calls.find(
      c => c.kind === 'post' && c.path === 'repos/acme/widgets/pulls/42/comments'
    )
    expect(inline?.body).toMatchObject({
      body: '**Resolved by the author:** other() has no test\n\nCovered by e2e.',
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

  it('settles a point marked for the reviewer, such as a false positive', async () => {
    t = await withCanvas()
    const res = await settle(t, '42', 'fp-1', { settled: true, reason: 'The spec says sum.' })
    expect(res.status).toBe(200)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled?.['fp-1']).toMatchObject({
      reason: 'The spec says sum.',
    })
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

  it('says whether settling shares the canvas comment again', async () => {
    const canvasComment = async (key: string): Promise<boolean> => {
      const res = await createApp(t.ctx).request(`/api/prs/${key}`, { headers: { host: 'localhost:3010' } })
      return ((await res.json()) as { canvasComment: boolean }).canvasComment
    }
    t = await withCanvas()
    expect(await canvasComment('42')).toBe(true)
    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...t.ctx.projectConfig.config, sharing: { canvasComment: false, mentionCanvas: true } },
    }
    expect(await canvasComment('42')).toBe(false)
    await t.cleanup()
    // Local work has no pull request to share on.
    t = await makeTestContext({ git: gitForLocal(), gh: gh() })
    expect(await canvasComment('uncommitted')).toBe(false)
  })
})

it('keeps legacy generated-point identity and resolutions through two incremental publications', async () => {
  // Generated by the normalizer at 036e8e9, before tests stored audience, anchor, or title.
  const legacy = ReviewArtifactSchema.parse(
    JSON.parse(
      await readFile(path.join(PACKAGE_ROOT, '__fixtures__/legacy-missing-tests/review.json'), 'utf8')
    )
  )
  const clone = gitFor42()
  const diff = SYNTHETIC_DIFF.split('diff --git ').slice(0, 2).join('diff --git ')
  clone.options.diffs = { [`${BASE_SHA}..${HEAD_SHA}`]: diff }
  let now = new Date('2026-09-10T12:00:00Z')
  const t = await makeTestContext({ git: clone, gh: gh(), now: () => now })
  t.ctx.projectConfig = {
    ...t.ctx.projectConfig,
    config: {
      ...t.ctx.projectConfig.config,
      sharing: { ...t.ctx.projectConfig.config.sharing, canvasComment: false },
    },
  }
  try {
    await importCanvas(t.ctx, {
      bytes: buildCanvasZip({ ...MANIFEST, generatedAt: legacy.generatedAt }, legacy),
      prNumber: 42,
    })
    const point = legacy.points[0]!
    expect(point.title).toHaveLength(90)
    const resolved = await answer(
      await settle(t, '42', point.fingerprint, {
        settled: true,
        reason: 'Covered by the integration suite.',
        comment: false,
      })
    )
    let previous = HEAD_SHA
    for (const sha of ['c'.repeat(40), 'd'.repeat(40)]) {
      now = new Date(now.getTime() + 1000)
      moveFakeHead(clone, {
        headRef: 'pull/42/head',
        baseRef: 'refs/pr/42/base',
        headSha: sha,
        mergeBaseSha: BASE_SHA,
        diff,
      })
      clone.options.ancestors = { ...clone.options.ancestors, [`${previous}..${sha}`]: true }
      t.ctx.gh = gh({
        routes: { 'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha } }) },
      })
      const prepared = await prepare(
        t.ctx,
        { kind: 'pr', number: 42 },
        { force: false, log: () => undefined }
      )
      const basis = JSON.parse(await readFile(path.join(prepared.canvasDir, 'basis-model.json'), 'utf8'))
      expect(basis.layers[0].tests[0]).toMatchObject({
        title: point.title,
        audience: 'author',
        anchor: { path: point.path, line: 1, side: 'new' },
      })
      await writeTextAtomic(path.join(prepared.canvasDir, 'model.json'), JSON.stringify(basis))
      await publish(t.ctx, prepared.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
      const next = await t.ctx.canvases.readArtifact(sha)
      expect(next?.basisCanvasSha).toBe(previous)
      expect(next?.points).toEqual(legacy.points)
      expect(next?.settled).toEqual(resolved.settled)
      previous = sha
    }
  } finally {
    await t.cleanup()
  }
})

it('serializes a resolution cache update behind an ordinary comment already being cached', async () => {
  const ordinaryRead = Promise.withResolvers<void>()
  const releaseOrdinary = Promise.withResolvers<void>()
  const updateQueued = Promise.withResolvers<void>()
  let remoteBody = ''
  const forge = gh({
    postRoutes: {
      'repos/acme/widgets/issues/42/comments': ghPost(body => {
        const text = (body as { body: string }).body
        if (text === 'Ordinary comment') return { ...CANVAS_COMMENT, id: 6002, body: text }
        remoteBody = text
        return { ...CANVAS_COMMENT, body: text }
      }),
    },
  })
  const t = await withCanvas(forge)
  const write = atomicJson.writeJsonAtomic
  const app = createApp(t.ctx)
  let spy: ReturnType<typeof vi.spyOn> | undefined
  let postSpy: ReturnType<typeof vi.spyOn> | undefined
  try {
    const endpoint = '/api/prs/42/points/fp-2/settled'
    const request = (settled: boolean) =>
      app.request(endpoint, {
        method: 'PUT',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ settled, reason: 'Verified', comment: false }),
      })
    await answer(await request(false))
    spy = vi.spyOn(atomicJson, 'writeJsonAtomic').mockImplementation(async (file, value) => {
      if (file.endsWith('/comments.json') && JSON.stringify(value).includes('Ordinary comment')) {
        ordinaryRead.resolve()
        await releaseOrdinary.promise
      }
      return write(file, value)
    })
    const ordinary = app.request('/api/prs/42/comments', {
      method: 'POST',
      headers: SAME_ORIGIN,
      body: JSON.stringify({ kind: 'issue', body: 'Ordinary comment' }),
    })
    await ordinaryRead.promise
    const post = t.ctx.prs.postComments
    postSpy = vi.spyOn(t.ctx.prs, 'postComments').mockImplementation((...args) => {
      updateQueued.resolve()
      return post(...args)
    })
    const resolution = request(true)
    await updateQueued.promise
    expect(
      await check(t.ctx.prs.prDir(42), { lockfilePath: path.join(t.ctx.prs.prDir(42), 'comments.json.lock') })
    ).toBe(true)
    releaseOrdinary.resolve()
    expect((await ordinary).status).toBe(201)
    await answer(await resolution)
    const cached = await t.ctx.prs.readComments(42)
    expect(cached?.issueComments.find(c => c.id === 6001)?.body).toBe(remoteBody)
    expect(remoteBody).toContain('**Resolved by the author:** 1')
    expect(cached?.issueComments.find(c => c.id === 6002)?.body).toBe('Ordinary comment')
    expect((await app.request('/api/prs/42', { headers: SAME_ORIGIN })).status).toBe(200)
    expect((await t.ctx.prs.readComments(42))?.issueComments).toEqual(cached?.issueComments)
  } finally {
    releaseOrdinary.resolve()
    spy?.mockRestore()
    postSpy?.mockRestore()
    await t.cleanup()
  }
})

it.each(['/api/prs/42?refresh=1', '/api/prs/42/comments'])(
  'serializes resolution behind the full snapshot fetch at %s',
  async endpoint => {
    const snapshotRead = Promise.withResolvers<void>()
    const releaseSnapshot = Promise.withResolvers<void>()
    const updateQueued = Promise.withResolvers<void>()
    let remote: typeof CANVAS_COMMENT | undefined
    const save = ghPost(body => {
      remote = { ...CANVAS_COMMENT, body: (body as { body: string }).body }
      return remote
    })
    const forge = gh({
      routes: {
        'repos/acme/widgets/issues/42/comments': ghHandler(() => (remote === undefined ? [] : [remote])),
      },
      postRoutes: {
        'repos/acme/widgets/issues/42/comments': save,
        'repos/acme/widgets/issues/comments/6001': save,
      },
    })
    const t = await withCanvas(forge)
    const app = createApp(t.ctx)
    const request = (settled: boolean) =>
      app.request('/api/prs/42/points/fp-2/settled', {
        method: 'PUT',
        headers: SAME_ORIGIN,
        body: JSON.stringify({ settled, reason: 'Verified', comment: false }),
      })
    let fetchSpy: ReturnType<typeof vi.spyOn> | undefined
    let updateSpy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await answer(await request(false))
      const oldBody = remote!.body
      const fetch = t.ctx.config.host.fetchComments
      fetchSpy = vi.spyOn(t.ctx.config.host, 'fetchComments').mockImplementationOnce(async (...args) => {
        const snapshot = await fetch(...args)
        snapshotRead.resolve()
        await releaseSnapshot.promise
        return snapshot
      })
      const post = t.ctx.prs.postComments
      updateSpy = vi.spyOn(t.ctx.prs, 'postComments').mockImplementation((...args) => {
        updateQueued.resolve()
        return post(...args)
      })
      const refresh = app.request(endpoint, { headers: SAME_ORIGIN })
      await snapshotRead.promise
      const resolution = request(true)
      await updateQueued.promise
      expect(remote!.body).toBe(oldBody)
      expect(
        await check(t.ctx.prs.prDir(42), {
          lockfilePath: path.join(t.ctx.prs.prDir(42), 'comments.json.lock'),
        })
      ).toBe(true)
      // The refresh completes first; the successful resolution must commit after its snapshot.
      releaseSnapshot.resolve()
      const refreshed = await refresh
      expect(refreshed.status).toBe(200)
      const refreshedBody = await refreshed.json()
      const comments = endpoint.endsWith('/comments') ? refreshedBody : refreshedBody.comments
      expect(comments.issueComments).toContainEqual(expect.objectContaining({ id: 6001, body: oldBody }))
      const resolved = await answer(await resolution)
      expect(remote!.body).toContain('**Resolved by the author:** 1')
      expect(resolved.sharing.status).toBe('shared')
      expect(resolved.issueComments).toContainEqual(expect.objectContaining({ id: 6001, body: remote!.body }))
      const reloaded = await app.request('/api/prs/42', { headers: SAME_ORIGIN })
      expect(reloaded.status).toBe(200)
      expect((await reloaded.json()).comments.issueComments).toEqual(resolved.issueComments)
      expect((await t.ctx.prs.readComments(42))?.issueComments).toEqual(resolved.issueComments)
    } finally {
      releaseSnapshot.resolve()
      fetchSpy?.mockRestore()
      updateSpy?.mockRestore()
      await t.cleanup()
    }
  }
)

it.each([
  { name: 'comment', path: '/comments', method: 'POST', body: { kind: 'issue', body: 'One comment' } },
  { name: 'review', path: '/review', method: 'POST', body: { event: 'COMMENT', body: 'One review' } },
  {
    name: 'canvas',
    path: '/points/fp-2/settled',
    method: 'PUT',
    body: { settled: true, reason: 'Verified', comment: false },
  },
])('does not post a $name remotely when lock acquisition expires', async input => {
  const snapshotRead = Promise.withResolvers<void>()
  const releaseSnapshot = Promise.withResolvers<void>()
  const forge = gh({
    postRoutes: {
      'repos/acme/widgets/pulls/42/reviews': ghPost(() => ({
        id: 7001,
        state: 'COMMENTED',
        html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
        submitted_at: '2026-09-10T12:00:00Z',
      })),
    },
  })
  const t = await withCanvas(forge)
  const app = createApp(t.ctx)
  const request = () =>
    app.request(`/api/prs/42${input.path}`, {
      method: input.method,
      headers: SAME_ORIGIN,
      body: JSON.stringify(input.body),
    })
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined
  let lockSpy: ReturnType<typeof vi.spyOn> | undefined
  let refresh: Promise<Response> | undefined
  try {
    expect((await app.request('/api/prs/42', { headers: SAME_ORIGIN })).status).toBe(200)
    const fetch = t.ctx.config.host.fetchComments
    fetchSpy = vi.spyOn(t.ctx.config.host, 'fetchComments').mockImplementationOnce(async (...args) => {
      const snapshot = await fetch(...args)
      snapshotRead.resolve()
      await releaseSnapshot.promise
      return snapshot
    })
    refresh = Promise.resolve(app.request('/api/prs/42?refresh=1', { headers: SAME_ORIGIN }))
    await snapshotRead.promise
    const { lock } = await vi.importActual<typeof import('proper-lockfile')>('proper-lockfile')
    // Exhaust the wait policy immediately; the real refresh still owns the real filesystem lock.
    lockSpy = vi
      .spyOn(lockfile, 'lock')
      .mockImplementation((file, options) => lock(file, { ...options, retries: 0 }))
    const denied = await request()
    if (input.name === 'canvas') {
      const response = await answer(denied)
      expect(response.sharing).toMatchObject({
        status: 'failed',
        warning: expect.stringContaining('Lock file is already being held'),
      })
    } else {
      expect(denied.status).toBe(500)
      expect((await denied.json()).error.message).toContain('Lock file is already being held')
    }
    expect(forge.calls.filter(c => c.kind === 'post')).toEqual([])
    expect((await t.ctx.state.read(42)).posted).toEqual([])
    lockSpy.mockRestore()
    releaseSnapshot.resolve()
    expect((await refresh).status).toBe(200)
    const retried = await request()
    if (input.name === 'canvas') expect((await answer(retried)).sharing.status).toBe('shared')
    else expect(retried.status).toBe(201)
    expect(forge.calls.filter(c => c.kind === 'post')).toHaveLength(1)
  } finally {
    releaseSnapshot.resolve()
    lockSpy?.mockRestore()
    fetchSpy?.mockRestore()
    await refresh
    await t.cleanup()
  }
})
