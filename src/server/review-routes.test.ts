import { rm as removeDirectory } from 'node:fs/promises'
// @vitest-environment node
// The routes that change something: local review state, comments, and the sign-off review.
import type { PostCommentResponse, PostReviewResponse, StateResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import { HostCliError } from '../host/client.js'
import { REVIEW_BODY_FOOTER } from '../review/review-body.js'
import {
  createFakeGh,
  type FakeGh,
  type FakeGhOptions,
  ghJson,
  ghHandler,
  moveFakeHead,
  ghPost,
  ghPostError,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  gitFor42,
  HEAD_SHA,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'
import { postedFromPending } from './routes/review-routes.js'

const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
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

const POSTED_INLINE = {
  id: 5001,
  user: { login: 'octocat' },
  body: 'Look at this',
  path: 'src/app.ts',
  line: 4,
  original_line: 4,
  side: 'RIGHT',
  commit_id: HEAD_SHA,
  created_at: '2026-09-10T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
}

const POSTED_ISSUE = {
  id: 6001,
  user: { login: 'octocat' },
  body: 'Overall fine',
  created_at: '2026-09-10T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
}

const POSTED_REVIEW = {
  id: 7001,
  state: 'APPROVED',
  html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
  submitted_at: '2026-09-10T12:00:00Z',
}

const POST_ROUTES: FakeGhOptions['postRoutes'] = {
  'repos/acme/widgets/pulls/42/comments': ghPost(() => POSTED_INLINE),
  'repos/acme/widgets/pulls/42/comments/1001/replies': ghPost(() => ({ ...POSTED_INLINE, id: 5002 })),
  'repos/acme/widgets/issues/42/comments': ghPost(() => POSTED_ISSUE),
  'repos/acme/widgets/pulls/42/reviews': ghPost(() => POSTED_REVIEW),
}

/** A context for PR #42 whose canvas is published for the current head. */
async function contextWithCanvas(gh: FakeGh): Promise<TestContext> {
  const t = await makeTestContext({ git: gitFor42(), gh })
  await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), MANIFEST, 42)
  await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
  return t
}

function put(path: string, body: unknown): [string, RequestInit] {
  return [path, { method: 'PUT', headers: SAME_ORIGIN, body: JSON.stringify(body) }]
}

function post(path: string, body: unknown): [string, RequestInit] {
  return [path, { method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify(body) }]
}

describe('state routes', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  beforeEach(async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
  })

  it('reads the state, marks a layer reviewed, and reads it back', async () => {
    const app = createApp(t.ctx)
    const before = await json<StateResponse>(await app.request('/api/prs/42/state', { headers: LOCAL }))
    expect(before.prNumber).toBe(42)
    expect(before.state).toEqual(await t.ctx.state.read(42))
    const res = await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    expect(res.status).toBe(200)
    expect((await json<StateResponse>(res)).state.reviewed).toEqual({ 'layer:run-path': true })
    const after = await json<StateResponse>(await app.request('/api/prs/42/state', { headers: LOCAL }))
    expect(after.state.reviewed).toEqual({ 'layer:run-path': true })
  })

  it('marks one file of a layer reviewed through the id with a slash', async () => {
    const app = createApp(t.ctx)
    const res = await app.request(
      ...put('/api/prs/42/reviewed/layer:run-path/file:src_app_ts', { reviewed: true })
    )
    expect((await json<StateResponse>(res)).state.reviewed).toEqual({
      'layer:run-path/file:src_app_ts': true,
    })
  })

  it('refuses a reviewed id that is not a layer or layer file', async () => {
    const app = createApp(t.ctx)
    for (const id of [
      'nope:layer-1',
      'layer:run-path/file:a/b',
      'layer:run-path/nope:x',
      encodeURIComponent('../x'),
    ]) {
      const res = await app.request(...put(`/api/prs/42/reviewed/${id}`, { reviewed: true }))
      expect([id, res.status]).toEqual([id, 400])
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('BAD_REQUEST')
    }
  })

  it('refuses a body that is not the shape the route expects', async () => {
    const app = createApp(t.ctx)
    const bad = await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: 'yes' }))
    expect(bad.status).toBe(400)
    const notJson = await app.request('/api/prs/42/reviewed/layer:run-path', {
      method: 'PUT',
      headers: SAME_ORIGIN,
      body: 'nope',
    })
    expect(notJson.status).toBe(400)
  })

  it('dismisses a point with a reason and restores it', async () => {
    const app = createApp(t.ctx)
    const off = await app.request(
      ...put('/api/prs/42/points/fp-1/dismissed', { dismissed: true, reason: 'fine' })
    )
    expect((await json<StateResponse>(off)).state.dismissed['fp-1']).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      reason: 'fine',
    })
    const on = await app.request(...put('/api/prs/42/points/fp-1/dismissed', { dismissed: false }))
    expect((await json<StateResponse>(on)).state.dismissed).toEqual({})
  })

  it('hides a thread and refuses a thread id that is not a number', async () => {
    const app = createApp(t.ctx)
    const hidden = await app.request(...put('/api/prs/42/threads/1001/hidden', { hidden: true }))
    expect((await json<StateResponse>(hidden)).state.hiddenThreads).toEqual({
      '1001': { at: '2026-09-10T12:00:00.000Z' },
    })
    const bad = await app.request(...put('/api/prs/42/threads/abc/hidden', { hidden: true }))
    expect(bad.status).toBe(400)
  })

  it('keeps both changes when two state writes arrive together', async () => {
    const app = createApp(t.ctx)
    await Promise.all([
      app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true })),
      app.request(...put('/api/prs/42/points/fp-2/dismissed', { dismissed: true })),
    ])
    const after = await json<StateResponse>(await app.request('/api/prs/42/state', { headers: LOCAL }))
    expect(after.state.reviewed).toEqual({ 'layer:run-path': true })
    expect(Object.keys(after.state.dismissed)).toEqual(['fp-2'])
  })

  it('rejects every state write that does not come from this page', async () => {
    const app = createApp(t.ctx)
    const paths: Array<[string, unknown]> = [
      ['/api/prs/42/reviewed/layer:run-path', { reviewed: true }],
      ['/api/prs/42/points/fp-1/dismissed', { dismissed: true }],
      ['/api/prs/42/threads/1001/hidden', { hidden: true }],
    ]
    for (const [path, body] of paths) {
      const res = await app.request(path, {
        method: 'PUT',
        headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify(body),
      })
      expect([path, res.status]).toEqual([path, 403])
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CROSS_ORIGIN')
    }
  })
})

describe('capabilities route', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('answers with the probe result and probes again on refresh', async () => {
    const gh = ghFor42()
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/capabilities', { headers: LOCAL })
    expect(await json(res)).toEqual({ canComment: true, tokenKind: 'classic', login: 'octocat' })
    await app.request('/api/prs/42/capabilities', { headers: LOCAL })
    expect(gh.calls.filter(c => c.kind === 'raw')).toHaveLength(1)
    await app.request('/api/prs/42/capabilities?refresh=1', { headers: LOCAL })
    expect(gh.calls.filter(c => c.kind === 'raw')).toHaveLength(2)
  })
})

describe('POST /api/prs/:n/comments', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('posts an inline comment, records it, and returns the new state', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    // The bundle caches the comments, which is what the posted one is appended to.
    await app.request('/api/prs/42', { headers: LOCAL })
    const res = await app.request(
      ...post('/api/prs/42/comments', {
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        body: 'Look at this',
        pointFingerprint: 'fp-1',
      })
    )
    expect(res.status).toBe(201)
    const body = await json<PostCommentResponse>(res)
    expect(body.kind).toBe('review')
    expect(body.comment.id).toBe(5001)
    expect(body.state.posted).toEqual([
      { commentId: 5001, pointFingerprint: 'fp-1', at: '2026-09-10T12:00:00.000Z' },
    ])
    expect(gh.calls.filter(c => c.kind === 'post')[0]?.body).toEqual({
      body: 'Look at this',
      commit_id: HEAD_SHA,
      path: 'src/app.ts',
      line: 4,
      side: 'RIGHT',
    })
    const cached = await t.ctx.prs.readComments(42)
    expect(cached?.reviewComments.map(c => c.id)).toEqual([1001, 1002, 1003, 5001])
  })

  it('posts a reply and a PR-level comment', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    const reply = await app.request(
      ...post('/api/prs/42/comments', { kind: 'reply', inReplyToId: 1001, body: 'ok' })
    )
    expect((await json<PostCommentResponse>(reply)).comment.id).toBe(5002)
    const issue = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'Overall fine' }))
    const issueBody = await json<PostCommentResponse>(issue)
    expect(issueBody.kind).toBe('issue')
    expect((await t.ctx.prs.readComments(42))?.issueComments.map(c => c.id)).toEqual([2001, 2002, 6001])
  })

  it('refuses a line that is not in the diff before calling GitHub', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(
      ...post('/api/prs/42/comments', {
        kind: 'inline',
        path: 'src/app.ts',
        line: 400,
        side: 'new',
        body: 'x',
      })
    )
    expect(res.status).toBe(422)
    expect(await json(res)).toEqual({
      error: {
        code: 'COMMENT_LINE_NOT_IN_DIFF',
        message: 'src/app.ts:400 (new) is not in the diff',
        hint: 'comment on a line the diff shows',
      },
    })
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('says only that posting is off when the probe gives no reason', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }), 'repos/acme/widgets/pulls/42': ghJson(GH_PULL) },
      rawRoutes: { 'repos/acme/widgets': { status: 200, headers: { 'x-oauth-scopes': 'repo' }, body: {} } },
      postRoutes: POST_ROUTES,
    })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect(res.status).toBe(403)
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
      'this login cannot read the repository'
    )
  })

  it('refuses posting when the probe says this token may not', async () => {
    const gh = createFakeGh({
      routes: { user: ghJson({ login: 'octocat' }), 'repos/acme/widgets/pulls/42': ghJson(GH_PULL) },
      rawRoutes: {
        'repos/acme/widgets': {
          status: 200,
          headers: { 'x-oauth-scopes': 'read:org' },
          body: { private: true, permissions: { pull: true } },
        },
      },
      postRoutes: POST_ROUTES,
    })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect(res.status).toBe(403)
    expect(await json(res)).toEqual({
      error: {
        code: 'COMMENT_FORBIDDEN',
        message: 'this token has no repo scope',
        hint: 'gh auth refresh -h github.com -s repo',
      },
    })
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('answers 502 when GitHub refuses the post', async () => {
    t = await contextWithCanvas(
      ghFor42({
        postRoutes: {
          'repos/acme/widgets/issues/42/comments': ghPostError(
            new HostCliError('gh', 'issues', 'gh: Unprocessable Entity (HTTP 422)', 1)
          ),
        },
      })
    )
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect(res.status).toBe(502)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('GITHUB_API_ERROR')
  })

  it('posts with no cached comments to update, and records the comment only once', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    const { rm } = await import('node:fs/promises')
    await rm(`${t.ctx.prs.prDir(42)}/comments.json`)
    const first = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect(first.status).toBe(201)
    expect(await t.ctx.prs.readComments(42)).toBeNull()
    await app.request('/api/prs/42/comments', { headers: LOCAL })
    await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect((await t.ctx.prs.readComments(42))?.issueComments.filter(c => c.id === 6001)).toHaveLength(1)
    const state = await t.ctx.state.read(42)
    expect(state.posted).toEqual([{ commentId: 6001, at: '2026-09-10T12:00:00.000Z' }])
  })

  it('records a reply only once as well', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    await app.request(...post('/api/prs/42/comments', { kind: 'reply', inReplyToId: 1001, body: 'ok' }))
    await app.request(...post('/api/prs/42/comments', { kind: 'reply', inReplyToId: 1001, body: 'ok' }))
    expect((await t.ctx.prs.readComments(42))?.reviewComments.filter(c => c.id === 5002)).toHaveLength(1)
  })

  it('answers 404 for an inline comment while the diff is not available locally', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42({ postRoutes: POST_ROUTES }) })
    const app = createApp(t.ctx)
    const res = await app.request(
      ...post('/api/prs/42/comments', { kind: 'inline', path: 'src/app.ts', line: 4, side: 'new', body: 'x' })
    )
    expect(res.status).toBe(404)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('NOT_FOUND')
  })

  it('lets a token whose rights cannot be read try, and returns what GitHub says', async () => {
    const gh = ghFor42({
      postRoutes: POST_ROUTES,
      rawRoutes: { 'repos/acme/widgets': { status: 200, headers: {}, body: { private: true } } },
    })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const caps = await json<{ canComment: string }>(
      await app.request('/api/prs/42/capabilities', { headers: LOCAL })
    )
    expect(caps.canComment).toBe('unknown')
    const res = await app.request(...post('/api/prs/42/comments', { kind: 'issue', body: 'x' }))
    expect(res.status).toBe(201)
  })

  it('refuses a post whose page was drawn for another commit', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(
      ...post('/api/prs/42/comments', { kind: 'issue', body: 'x', headSha: 'c'.repeat(40) })
    )
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({
      error: {
        code: 'CANVAS_STALE',
        message: 'the pull request has a new head commit since this page was drawn',
        hint: 'reload the page and try again',
      },
    })
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
    // The head the page names is the one it was drawn for, so the post goes through.
    const ok = await app.request(
      ...post('/api/prs/42/comments', { kind: 'issue', body: 'x', headSha: HEAD_SHA })
    )
    expect(ok.status).toBe(201)
  })

  it('rejects a post that does not come from this page', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/comments', {
      method: 'POST',
      headers: { ...LOCAL, origin: 'https://evil.example' },
      body: JSON.stringify({ kind: 'issue', body: 'x' }),
    })
    expect(res.status).toBe(403)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CROSS_ORIGIN')
  })
})

describe('GET /api/prs/:n/review/body', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('shows what the review will say and which layers still need a look', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/review/body', { headers: LOCAL })
    expect(res.status).toBe(200)
    const body = await json<{ headSha: string; body: string; unreviewed: string[] }>(res)
    expect(body.headSha).toBe(HEAD_SHA)
    expect(body.unreviewed).toEqual(['Run path'])
    expect(body.body).toContain('Reviewed 0 of 1 layer')
    expect(body.body).toContain(REVIEW_BODY_FOOTER)
  })

  it('fetches the comments when none are cached yet', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/review/body', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(await t.ctx.prs.readComments(42)).not.toBeNull()
  })

  it('reads the fixture canvas when the server was started with one', async () => {
    t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42({ postRoutes: POST_ROUTES }),
      fixtureArtifact: syntheticArtifact(),
    })
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/review/body', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect((await json<{ unreviewed: string[] }>(res)).unreviewed).toEqual(['Run path'])
  })

  it('answers 404 when the index lists a canvas whose file is gone', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const { rm } = await import('node:fs/promises')
    await rm(`${t.ctx.canvases.canvasDir(HEAD_SHA)}/review.json`)
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42/review/body', { headers: LOCAL })
    expect(res.status).toBe(404)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CANVAS_NOT_FOUND')
  })
})

describe('POST /api/prs/:n/review', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('refuses to approve while a layer is unreviewed', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({
      error: { code: 'SIGNOFF_INCOMPLETE', message: '1 layer is not reviewed yet', hint: 'Run path' },
    })
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('counts more than one open layer in the refusal', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    const artifact = syntheticArtifact()
    const first = artifact.layers[0]
    if (first === undefined) {
      throw new Error('no layer')
    }
    const twoLayers = {
      ...artifact,
      layers: [...artifact.layers, { ...first, id: 'layer-3', key: 'third', title: 'Third' }],
    }
    t = await makeTestContext({ git: gitFor42(), gh, fixtureArtifact: twoLayers })
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(409)
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
      '2 layers are not reviewed yet'
    )
  })

  it('approves with the generated body once every layer is reviewed', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(201)
    const answer = await json<PostReviewResponse>(res)
    expect(answer.review).toEqual({
      id: 7001,
      state: 'APPROVED',
      url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
      submittedAt: '2026-09-10T12:00:00Z',
    })
    // Nothing was waiting, so the review carried no comments with it.
    expect(answer.submitted).toBe(0)
    const sent = gh.calls.find(c => c.kind === 'post')
    expect(sent?.path).toBe('repos/acme/widgets/pulls/42/reviews')
    expect(sent?.body).toEqual({
      event: 'APPROVE',
      commit_id: HEAD_SHA,
      body: `Reviewed 1 of 1 layer on \`${HEAD_SHA.slice(0, 7)}\`.\n\n**Layers reviewed**\n- Run path\n\n${REVIEW_BODY_FOOTER}\n`,
    })
  })

  it('fetches the comments for the body it generates when none are cached', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    const { rm } = await import('node:fs/promises')
    await rm(`${t.ctx.prs.prDir(42)}/comments.json`)
    const res = await app.request(...post('/api/prs/42/review', { event: 'REQUEST_CHANGES' }))
    expect(res.status).toBe(201)
    expect(await t.ctx.prs.readComments(42)).not.toBeNull()
  })

  it('requests changes at any time, with the body the dialog sends', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(
      ...post('/api/prs/42/review', { event: 'REQUEST_CHANGES', body: 'edited by hand' })
    )
    expect(res.status).toBe(201)
    expect(gh.calls.find(c => c.kind === 'post')?.body).toEqual({
      event: 'REQUEST_CHANGES',
      commit_id: HEAD_SHA,
      body: 'edited by hand',
    })
  })

  it('refuses a sign-off while the canvas on screen is for another commit', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    const t2 = await makeTestContext({ git: gitFor42(), gh })
    t = t2
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(409)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('SIGNOFF_INCOMPLETE')
  })

  it('refuses a sign-off whose dialog named another commit', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(
      ...post('/api/prs/42/review', { event: 'REQUEST_CHANGES', headSha: 'c'.repeat(40) })
    )
    expect(res.status).toBe(409)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CANVAS_STALE')
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('refuses to approve on marks that were made on another commit', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    // The same marks, recorded against a commit this pull request has left behind.
    await t.ctx.state.update(42, state => ({ ...state, reviewedCanvasSha: 'c'.repeat(40) }))
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(409)
    expect(await json(res)).toEqual({
      error: { code: 'SIGNOFF_INCOMPLETE', message: '1 layer is not reviewed yet', hint: 'Run path' },
    })
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('refuses to approve on marks whose commit is unknown', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    // A state file written before the tool recorded the commit of a mark.
    await t.ctx.state.update(42, state => ({ ...state, reviewed: { 'layer:run-path': true } }))
    const res = await app.request(...post('/api/prs/42/review', { event: 'APPROVE' }))
    expect(res.status).toBe(409)
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('refuses a reviewed mark that names another commit', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(
      ...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true, headSha: 'c'.repeat(40) })
    )
    expect(res.status).toBe(409)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('CANVAS_STALE')
    expect((await t.ctx.state.read(42)).reviewed).toEqual({})
  })

  it('hides marks of another commit from the page and from the review body', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    await t.ctx.state.update(42, state => ({ ...state, reviewedCanvasSha: 'c'.repeat(40) }))
    const bundle = await json<{ state: { reviewed: Record<string, true> } }>(
      await app.request('/api/prs/42', { headers: LOCAL })
    )
    expect(bundle.state.reviewed).toEqual({})
    const body = await json<{ body: string }>(
      await app.request('/api/prs/42/review/body', { headers: LOCAL })
    )
    expect(body.body).toContain('Reviewed 0 of 1 layer')
  })

  it('records the commit the layers were read on', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    await app.request(...put('/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    expect((await t.ctx.state.read(42)).reviewedCanvasSha).toBe(HEAD_SHA)
  })

  it('refuses an event it does not know', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/review', { event: 'MERGE' }))
    expect(res.status).toBe(400)
  })

  it('posts a review with no verdict without asking that every layer was read', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    // No layer is marked reviewed: only approving asks for that.
    const res = await app.request(...post('/api/prs/42/review', { event: 'COMMENT' }))
    expect(res.status).toBe(201)
    expect(gh.calls.find(c => c.kind === 'post')?.body).toMatchObject({ event: 'COMMENT' })
  })
})

/** This fake creates the review's comments from the actual submitted payload. */
function reviewGh() {
  let created: Array<typeof POSTED_INLINE & { start_line?: number }> = []
  const gh = ghFor42({
    postRoutes: {
      ...POST_ROUTES,
      'repos/acme/widgets/pulls/42/reviews': ghPost(body => {
        const input = body as {
          comments?: Array<{ path: string; line: number; side: string; body: string; start_line?: number }>
        }
        created = (input.comments ?? []).map((c, index) => ({
          ...POSTED_INLINE,
          ...c,
          id: 5001 + index,
          original_line: c.line,
        }))
        return POSTED_REVIEW
      }),
    },
    routes: {
      'repos/acme/widgets/pulls/42/reviews/7001/comments': ghHandler(() => created),
    },
  })
  return gh
}

describe('the pending review', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  function patch(path: string, body: unknown): [string, RequestInit] {
    return [path, { method: 'PATCH', headers: SAME_ORIGIN, body: JSON.stringify(body) }]
  }

  function del(path: string): [string, RequestInit] {
    return [path, { method: 'DELETE', headers: SAME_ORIGIN }]
  }

  const DRAFT = { path: 'src/app.ts', line: 4, side: 'new', body: 'needs a guard' }

  it('preserves newly added and edited drafts while a review is being posted', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const gh = ghFor42({
      postRoutes: {
        ...POST_ROUTES,
        'repos/acme/widgets/pulls/42/reviews': ghPost(async () => {
          entered.resolve()
          await release.promise
          return POSTED_REVIEW
        }),
      },
    })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const first = await json<StateResponse>(await app.request(...post('/api/prs/42/pending', DRAFT)))
    const id = first.state.pending[0]!.id
    const submission = app.request(...post('/api/prs/42/review', { event: 'COMMENT', body: 'a look' }))
    await entered.promise
    await app.request(...post('/api/prs/42/pending', { ...DRAFT, line: 5, body: 'new draft' }))
    await app.request(...patch(`/api/prs/42/pending/${id}`, { body: 'edited during submission' }))
    release.resolve()
    expect((await submission).status).toBe(201)
    expect((await t.ctx.state.read(42)).pending.map(p => p.body)).toEqual([
      'edited during submission',
      'new draft',
    ])
  })

  it.each([true, false])(
    'checks draft identity after two head transitions (identical diff: %s)',
    async identical => {
      const gh = reviewGh()
      const git = gitFor42()
      t = await makeTestContext({ gh, git })
      const artifact = syntheticArtifact()
      await t.ctx.canvases.write(HEAD_SHA, artifact, MANIFEST, 42)
      await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
      const app = createApp(t.ctx)
      await app.request(...post('/api/prs/42/pending', { ...DRAFT, headSha: HEAD_SHA }))
      for (const headSha of ['c'.repeat(40), 'd'.repeat(40)]) {
        const diff = identical ? SYNTHETIC_DIFF : SYNTHETIC_DIFF.replace('a() + b()', `a() * ${headSha[0]}()`)
        moveFakeHead(git, {
          headRef: 'pull/42/head',
          baseRef: 'refs/pr/42/base',
          headSha,
          mergeBaseSha: BASE_SHA,
          diff,
        })
        await t.ctx.canvases.write(
          headSha,
          { ...artifact, pr: { ...artifact.pr, headSha } },
          { ...MANIFEST, headSha },
          42
        )
        await t.ctx.derived.ensure(headSha, BASE_SHA)
        await app.request('/api/prs/42?refresh=1', { headers: LOCAL })
        expect((await t.ctx.state.read(42)).pending[0]?.headSha).toBe(HEAD_SHA)
      }
      const response = await app.request(
        ...post('/api/prs/42/review', { event: 'COMMENT', headSha: 'd'.repeat(40), body: 'a look' })
      )
      expect(response.status).toBe(identical ? 201 : 409)
      expect(gh.calls.filter(c => c.kind === 'post')).toHaveLength(identical ? 1 : 0)
      expect((await t.ctx.state.read(42)).pending).toHaveLength(identical ? 0 : 1)
    }
  )

  it.each(['disabled', 'missing'] as const)('refuses old drafts when diff reuse is %s', async condition => {
    const gh = reviewGh()
    const git = gitFor42()
    t = await makeTestContext({ gh, git })
    const artifact = syntheticArtifact()
    await t.ctx.canvases.write(HEAD_SHA, artifact, MANIFEST, 42)
    await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
    const app = createApp(t.ctx)
    await app.request(...post('/api/prs/42/pending', DRAFT))
    const headSha = 'c'.repeat(40)
    moveFakeHead(git, {
      headRef: 'pull/42/head',
      baseRef: 'refs/pr/42/base',
      headSha,
      mergeBaseSha: BASE_SHA,
      diff: SYNTHETIC_DIFF,
    })
    await t.ctx.canvases.write(
      headSha,
      { ...artifact, pr: { ...artifact.pr, headSha } },
      { ...MANIFEST, headSha },
      42
    )
    await t.ctx.derived.ensure(headSha, BASE_SHA)
    await app.request('/api/prs/42?refresh=1', { headers: LOCAL })
    if (condition === 'disabled') t.ctx.projectConfig.config.canvas.keepForIdenticalDiff = false
    else await removeDirectory(t.ctx.derived.derivedDir(HEAD_SHA), { recursive: true })
    const response = await app.request(
      ...post('/api/prs/42/review', { event: 'COMMENT', headSha, body: 'a look' })
    )
    expect(response.status).toBe(409)
    expect((await t.ctx.state.read(42)).pending).toHaveLength(1)
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
  })

  it('does not retry a successful post when its receipt read fails', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    await app.request(...post('/api/prs/42/pending', DRAFT))
    const response = await app.request(...post('/api/prs/42/review', { event: 'COMMENT', body: 'a look' }))
    expect(response.status).toBe(201)
    const answer = await json<PostReviewResponse>(response)
    expect(answer.review.id).toBe(7001)
    expect(answer.comments).toEqual([])
    expect(answer.warnings[0]).toContain('Review posted, but its comments could not be loaded')
    expect(answer.state.pending).toEqual([])
  })

  it('keeps a comment locally and posts nothing while it waits', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/pending', DRAFT))
    expect(res.status).toBe(201)
    const { state } = await json<StateResponse>(res)
    expect(state.pending).toHaveLength(1)
    expect(state.pending[0]).toMatchObject({
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      body: 'needs a guard',
    })
    expect(state.pending[0]?.headSha).toBe(HEAD_SHA)
    // Nothing at all went to the forge: that is the whole point of a pending review.
    expect(gh.calls.filter(c => c.kind === 'post')).toEqual([])
    expect((await t.ctx.state.read(42)).pending).toHaveLength(1)
  })

  it('keeps the range of a comment on several lines', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/pending', { ...DRAFT, startLine: 2 }))
    expect((await json<StateResponse>(res)).state.pending[0]?.startLine).toBe(2)
  })

  it('refuses a draft on a line the diff does not show', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/pending', { ...DRAFT, line: 9999 }))
    expect(res.status).toBe(422)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe('COMMENT_LINE_NOT_IN_DIFF')
    expect((await t.ctx.state.read(42)).pending).toEqual([])
  })

  it('refuses a draft written against a head the pull request has moved past', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(...post('/api/prs/42/pending', { ...DRAFT, headSha: 'c'.repeat(40) }))
    expect(res.status).toBe(409)
  })

  it('edits and deletes one draft, and discards the whole review', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const first = await json<StateResponse>(await app.request(...post('/api/prs/42/pending', DRAFT)))
    await app.request(...post('/api/prs/42/pending', { ...DRAFT, line: 5, body: 'and a test' }))
    const id = first.state.pending[0]?.id ?? ''

    const edited = await json<StateResponse>(
      await app.request(...patch(`/api/prs/42/pending/${id}`, { body: 'needs two guards' }))
    )
    expect(edited.state.pending.find(p => p.id === id)?.body).toBe('needs two guards')

    const dropped = await json<StateResponse>(await app.request(...del(`/api/prs/42/pending/${id}`)))
    expect(dropped.state.pending.map(p => p.body)).toEqual(['and a test'])

    const cleared = await json<StateResponse>(await app.request(...del('/api/prs/42/pending')))
    expect(cleared.state.pending).toEqual([])
  })

  it('refuses an edit to a draft that is not there', async () => {
    t = await contextWithCanvas(ghFor42({ postRoutes: POST_ROUTES }))
    const app = createApp(t.ctx)
    const res = await app.request(...patch('/api/prs/42/pending/nope', { body: 'x' }))
    expect(res.status).toBe(404)
  })

  it('submits the drafts as the comments of one review and clears them', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request(...post('/api/prs/42/pending', DRAFT))
    await app.request(...post('/api/prs/42/pending', { ...DRAFT, line: 5, startLine: 4, body: 'and this' }))

    const res = await app.request(...post('/api/prs/42/review', { event: 'COMMENT', body: 'a look' }))
    expect(res.status).toBe(201)
    expect((await json<PostReviewResponse>(res)).submitted).toBe(2)

    const sent = gh.calls.find(c => c.kind === 'post' && c.path.endsWith('/reviews'))
    expect(sent?.body).toMatchObject({
      event: 'COMMENT',
      body: 'a look',
      commit_id: HEAD_SHA,
      comments: [
        { path: 'src/app.ts', line: 4, side: 'RIGHT', body: 'needs a guard' },
        // The range goes out only because it covers more than the anchor line.
        { path: 'src/app.ts', line: 5, side: 'RIGHT', start_line: 4, start_side: 'RIGHT', body: 'and this' },
      ],
    })
    // The review holds them now, so the local pending review is empty again.
    expect((await t.ctx.state.read(42)).pending).toEqual([])
  })

  it('marks the point posted once the review its draft went out with has landed', async () => {
    const gh = reviewGh()
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    // A draft that came from an attention point carries the point's fingerprint.
    await app.request(
      ...post('/api/prs/42/pending', { ...DRAFT, body: POSTED_INLINE.body, pointFingerprint: 'fp-1' })
    )
    expect((await t.ctx.state.read(42)).pending[0]?.pointFingerprint).toBe('fp-1')

    const response = await json<PostReviewResponse>(
      await app.request(...post('/api/prs/42/review', { event: 'COMMENT', body: 'a look' }))
    )
    expect(response.comments).toMatchObject([{ id: 5001, body: POSTED_INLINE.body }])
    expect(response.warnings).toEqual([])
    expect((await t.ctx.prs.readComments(42))?.reviewComments).toContainEqual(response.comments[0])
    // The review call names none of the comments it made, so the draft is found in the list the
    // forge returns and the point is recorded as posted, the way posting it directly would.
    const state = await t.ctx.state.read(42)
    expect(state.pending).toEqual([])
    expect(state.posted).toEqual([
      { commentId: 5001, pointFingerprint: 'fp-1', at: '2026-09-10T12:00:00.000Z' },
    ])
  })

  it('leaves the drafts waiting when the page submits a review without them', async () => {
    const gh = ghFor42({ postRoutes: POST_ROUTES })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request(...post('/api/prs/42/pending', DRAFT))
    const res = await app.request(
      ...post('/api/prs/42/review', { event: 'COMMENT', body: 'later', includePending: false })
    )
    expect((await json<PostReviewResponse>(res)).submitted).toBe(0)
    expect(gh.calls.find(c => c.kind === 'post' && c.path.endsWith('/reviews'))?.body).not.toHaveProperty(
      'comments'
    )
    expect((await t.ctx.state.read(42)).pending).toHaveLength(1)
  })

  it('keeps the drafts when the forge refuses the review', async () => {
    const gh = ghFor42({
      postRoutes: {
        ...POST_ROUTES,
        'repos/acme/widgets/pulls/42/reviews': ghPostError(
          new HostCliError('gh', 'repos/acme/widgets/pulls/42/reviews', 'HTTP 422', 1)
        ),
      },
    })
    t = await contextWithCanvas(gh)
    const app = createApp(t.ctx)
    await app.request(...post('/api/prs/42/pending', DRAFT))
    const res = await app.request(...post('/api/prs/42/review', { event: 'COMMENT', body: 'a look' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    // Nothing landed, so the reviewer still has what they wrote.
    expect((await t.ctx.state.read(42)).pending).toHaveLength(1)
  })
})

describe('postedFromPending', () => {
  const draft = (over: Partial<Parameters<typeof postedFromPending>[0][number]> = {}) => ({
    id: 'p1',
    path: 'src/app.ts',
    line: 4,
    side: 'new' as const,
    body: 'needs a guard',
    headSha: HEAD_SHA,
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
    ...over,
  })
  const comment = (over: Record<string, unknown> = {}) => ({
    id: 5001,
    path: 'src/app.ts',
    line: 4,
    side: 'new',
    body: 'needs a guard',
    ...over,
  })

  it('only follows a draft that came from an attention point', () => {
    expect(postedFromPending([draft()], [comment()])).toEqual([])
    expect(postedFromPending([draft({ pointFingerprint: 'fp-1' })], [comment()])).toEqual([
      { commentId: 5001, pointFingerprint: 'fp-1' },
    ])
  })

  it('matches on where the comment sits and what it says', () => {
    const drafts = [draft({ pointFingerprint: 'fp-1' })]
    expect(postedFromPending(drafts, [comment({ line: 9 })])).toEqual([])
    expect(postedFromPending(drafts, [comment({ side: 'old' })])).toEqual([])
    expect(postedFromPending(drafts, [comment({ body: 'something else' })])).toEqual([])
    expect(postedFromPending(drafts, [comment({ path: 'src/other.ts' })])).toEqual([])
    // A draft that matches nothing is skipped rather than guessed at.
    expect(postedFromPending(drafts, [])).toEqual([])
  })

  it('never gives one comment to two drafts that read the same', () => {
    const drafts = [
      draft({ id: 'p1', pointFingerprint: 'fp-1' }),
      draft({ id: 'p2', pointFingerprint: 'fp-2' }),
    ]
    expect(postedFromPending(drafts, [comment(), comment({ id: 5002 })])).toEqual([
      { commentId: 5001, pointFingerprint: 'fp-1' },
      { commentId: 5002, pointFingerprint: 'fp-2' },
    ])
    // With only one comment to go round, the second draft goes unmatched.
    expect(postedFromPending(drafts, [comment()])).toEqual([{ commentId: 5001, pointFingerprint: 'fp-1' }])
  })
})
