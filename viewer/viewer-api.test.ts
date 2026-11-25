import { buildCanvasComment } from '../src/canvas/comment.js'
import { buildCanvasZipName } from '../src/canvas/name.js'
import { buildCanvasZip } from '../src/canvas/zip.js'
import type { PrBundle, StateResponse } from '../src/contract/api.js'
import type { CanvasManifest } from '../src/contract/canvas-manifest.js'
import { VIEWER_REVIEW_BODY_FOOTER } from '../src/review/review-body.js'
import { tallyCanvas } from '../src/review/self-review.js'
import { createStateStore } from '../src/store/state-store.js'
import {
  BASE_SHA,
  GH_ISSUE_COMMENTS,
  GH_PULL,
  GH_REVIEW_COMMENTS,
  HEAD_SHA,
  publishedSyntheticArtifact,
  SYNTHETIC_DIFF,
} from '../src/testing/synthetic.js'
import type { BrowserGithub } from './github-client.js'
import { browserState } from './review-state.js'
import { createViewerApi } from './viewer-api.js'

const OLD_HEAD = 'c'.repeat(40)
const target = { owner: 'acme', repo: 'widgets', number: 42 }
const now = () => new Date('2026-11-19T12:00:00Z')

function manifest(over: Partial<CanvasManifest> = {}): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.11.1' },
    repo: { owner: 'acme', name: 'widgets' },
    prNumber: 42,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-11-18T10:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
    ...over,
  }
}

/** The canvas comment `pr-review publish` posts for a canvas of `m`. */
function canvasComment(m: CanvasManifest, id = 3001) {
  const artifact = {
    ...publishedSyntheticArtifact(),
    pr: { ...publishedSyntheticArtifact().pr, headSha: m.headSha },
  }
  const bytes = buildCanvasZip(m, artifact)
  // Named for acme/widgets, as discovery requires, whatever repository the manifest names.
  const name = buildCanvasZipName({
    repo: { owner: 'acme', name: 'widgets' },
    headSha: m.headSha,
    generatedAt: m.generatedAt,
    prNumber: 42,
  })
  const zip = { name, headSha: m.headSha, prNumber: 42, bytes }
  return {
    id,
    user: { login: 'octocat' },
    body: buildCanvasComment(zip, tallyCanvas(artifact), 1_000_000),
    created_at: '2026-11-18T11:00:00Z',
    html_url: `https://github.com/acme/widgets/pull/42#issuecomment-${id}`,
  }
}

/** GitHub for acme/widgets#42 at HEAD_SHA, with `diffs` keyed `base...head`. */
function fakeGithub(opts: {
  comments?: unknown[]
  /** The raw diff of each `base...head`; an Error is GitHub refusing to send it. */
  diffs?: Record<string, string | Error>
  routes?: Record<string, unknown>
  signedIn?: boolean
  /** What GitHub answers to each write, by path; an Error is thrown as GitHub's refusal. */
  writes?: Record<string, unknown>
}) {
  const posts: Array<{ path: string; body: unknown }> = []
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    'repos/acme/widgets/pulls/42': GH_PULL,
    [`repos/acme/widgets/compare/main...${HEAD_SHA}`]: { merge_base_commit: { sha: BASE_SHA } },
    'repos/acme/widgets/pulls/42/comments': GH_REVIEW_COMMENTS,
    'repos/acme/widgets/pulls/42/reviews': [],
    'repos/acme/widgets/issues/42/comments': [...GH_ISSUE_COMMENTS, ...(opts.comments ?? [])],
    ...opts.routes,
  }
  const diffs: Record<string, string | Error> = {
    [`${BASE_SHA}...${HEAD_SHA}`]: SYNTHETIC_DIFF,
    ...opts.diffs,
  }
  const gh: BrowserGithub = {
    api(path, params) {
      calls.push(path)
      if (!(path in routes)) return Promise.reject(new Error(`HTTP 404: no route ${path}`))
      const body = routes[path]
      // One page holds everything: a second page asked for is empty.
      return Promise.resolve(params?.['page'] === '2' ? [] : body)
    },
    apiWithHeaders: () => Promise.reject(new Error('unused')),
    post(path, body) {
      posts.push({ path, body })
      const answer = opts.writes?.[path]
      if (answer instanceof Error) return Promise.reject(answer)
      return answer === undefined
        ? Promise.reject(new Error(`HTTP 404: no write ${path}`))
        : Promise.resolve(answer)
    },
    graphql: () => Promise.reject(new Error('needs a token')),
    authStatus: () =>
      Promise.resolve({ installed: true, authenticated: opts.signedIn === true, detail: 'fake' }),
    authToken: () => Promise.resolve(null),
    diff(_owner, _repo, base, head) {
      calls.push(`diff ${base}...${head}`)
      const text = diffs[`${base}...${head}`]
      if (text instanceof Error) return Promise.reject(text)
      return text === undefined ? Promise.reject(new Error('HTTP 404: no diff')) : Promise.resolve(text)
    },
    refresh: () => calls.push('refresh'),
    apiFresh(path) {
      calls.push(`fresh ${path}`)
      return path in routes
        ? Promise.resolve(routes[path])
        : Promise.reject(new Error(`HTTP 404: no route ${path}`))
    },
  }
  return { gh, calls, posts, routes }
}

/** The review state as the viewer keeps it when the browser refuses storage: in memory. */
const memoryState = () => createStateStore(browserState(null), now)

function viewer(opts: Parameters<typeof fakeGithub>[0] = {}) {
  const github = fakeGithub(opts)
  const api = createViewerApi(target, { gh: github.gh, state: memoryState(), now })
  const call = (method: string, path: string, body: unknown = null) =>
    api.handle(method, new URL(path, 'http://viewer.test'), body)
  return { ...github, call }
}

it('shows the canvas comment of the head as a ready canvas over the diff GitHub serves', async () => {
  const { call } = viewer({ comments: [canvasComment(manifest())] })
  const answer = await call('GET', '/api/prs/42')
  expect(answer.status).toBe(200)
  const bundle = answer.body as PrBundle
  expect(bundle.status).toBe('ready')
  expect(bundle.canvas).toMatchObject({ headSha: HEAD_SHA, source: 'import' })
  expect(bundle.pr).toMatchObject({
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    repo: { owner: 'acme', name: 'widgets' },
  })
  expect(bundle.files.map(f => f.path)).toContain('src/app.ts')
  expect(bundle.capabilities.canComment).toBe(false)
  expect(bundle.chat.enabled).toBe(false)
  expect(bundle.viewer).toBe(true)
  expect(bundle.skillCommand).toBe('/pr-review-canvas 42 --force')
  expect(bundle.warnings).toEqual([])

  const patches = (await call('GET', '/api/prs/42/patches')).body as { patches: Record<string, string> }
  expect(Object.keys(patches.patches)).toEqual(bundle.files.map(f => f.key))
})

it("ranks canvas comments as the local app does: the head's canvas first, then the newest", async () => {
  const headCanvas = {
    ...canvasComment(manifest(), 3001),
    created_at: '2026-11-01T00:00:00Z',
  }
  const newerOfOlder = canvasComment(manifest({ headSha: OLD_HEAD }), 3002)
  const { call } = viewer({ comments: [headCanvas, newerOfOlder] })
  expect(((await call('GET', '/api/prs/42')).body as PrBundle).canvas?.headSha).toBe(HEAD_SHA)

  const older = {
    ...canvasComment(manifest({ headSha: 'd'.repeat(40) }), 3003),
    created_at: '2026-11-01T00:00:00Z',
  }
  const twoOlder = viewer({
    comments: [older, newerOfOlder],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: SYNTHETIC_DIFF },
    routes: { [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'ahead', ahead_by: 1 } },
  })
  expect(((await twoOlder.call('GET', '/api/prs/42')).body as PrBundle).canvas?.headSha).toBe(OLD_HEAD)
})

it('skips a canvas comment from someone with no role on the repository, and says whose it was', async () => {
  const author = {
    ...canvasComment(manifest({ headSha: OLD_HEAD }), 3001),
    created_at: '2026-11-01T00:00:00Z',
  }
  const stranger = {
    ...canvasComment(manifest(), 3002),
    user: { login: 'mallory' },
    author_association: 'CONTRIBUTOR',
  }
  const { call } = viewer({
    comments: [author, stranger],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: SYNTHETIC_DIFF },
    routes: { [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'ahead', ahead_by: 1 } },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.canvas?.headSha).toBe(OLD_HEAD)
  expect(bundle.warnings).toContain(
    "the canvas comment at https://github.com/acme/widgets/pull/42#issuecomment-3002 is by @mallory, who is neither the pull request's author nor an owner, member, or collaborator of acme/widgets; skipped"
  )
})

it('takes a canvas comment from a collaborator who did not open the pull request', async () => {
  const teammate = {
    ...canvasComment(manifest()),
    user: { login: 'teammate' },
    author_association: 'COLLABORATOR',
  }
  const { call } = viewer({ comments: [teammate] })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('ready')
  expect(bundle.warnings ?? []).toEqual([])
})

it('carries an older canvas over when its diff is identical to the head', async () => {
  const { call } = viewer({
    comments: [canvasComment(manifest({ headSha: OLD_HEAD }))],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: SYNTHETIC_DIFF },
    routes: { [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'ahead', ahead_by: 2 } },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('ready')
  expect(bundle.carriedOver).toEqual({ canvasHeadSha: OLD_HEAD, currentHeadSha: HEAD_SHA, commitsBehind: 2 })
})

it('does not carry an older canvas over when both diffs are empty, as the local app does not', async () => {
  const { call } = viewer({
    comments: [canvasComment(manifest({ headSha: OLD_HEAD }))],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: '', [`${BASE_SHA}...${HEAD_SHA}`]: '' },
    routes: { [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'ahead', ahead_by: 1 } },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('stale')
  expect(bundle.carriedOver).toBeUndefined()
})

it("shows the head's own canvas from another base as ready when the diff is the same, not carried over", async () => {
  const otherBase = 'b'.repeat(40)
  const { call } = viewer({
    comments: [canvasComment(manifest({ mergeBaseSha: otherBase }))],
    diffs: { [`${otherBase}...${HEAD_SHA}`]: SYNTHETIC_DIFF },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('ready')
  expect(bundle.carriedOver).toBeUndefined()
})

it('marks a canvas of another diff outdated, and serves that canvas its own patches', async () => {
  const oldDiff = SYNTHETIC_DIFF.replace('+  const y = 2', '+  const y = 3')
  const { call } = viewer({
    comments: [canvasComment(manifest({ headSha: OLD_HEAD }))],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: oldDiff },
    routes: { [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'diverged', ahead_by: 1 } },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('stale')
  expect(bundle.stale).toEqual({ canvasHeadSha: OLD_HEAD, currentHeadSha: HEAD_SHA, relation: 'unrelated' })
  const own = (await call('GET', `/api/prs/42/patches?headSha=${OLD_HEAD}`)).body as {
    patches: Record<string, string>
  }
  expect(Object.values(own.patches).join('\n')).toContain('const y = 3')
})

it('diffs a merged pull request from the base as it was at merge time', async () => {
  const merge = 'd'.repeat(40)
  const parent = 'e'.repeat(40)
  const { call, calls } = viewer({
    routes: {
      'repos/acme/widgets/pulls/42': { ...GH_PULL, state: 'closed', merged: true, merge_commit_sha: merge },
      [`repos/acme/widgets/commits/${merge}`]: { parents: [{ sha: parent }] },
      [`repos/acme/widgets/compare/${parent}...${HEAD_SHA}`]: { merge_base_commit: { sha: BASE_SHA } },
    },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.pr.state).toBe('merged')
  expect(bundle.pr.mergeBaseSha).toBe(BASE_SHA)
  expect(calls).toContain(`repos/acme/widgets/compare/${parent}...${HEAD_SHA}`)
})

it('says so when the pull request has no canvas comment, and skips one for another repository', async () => {
  const elsewhere = canvasComment(manifest({ repo: { owner: 'acme', name: 'other' } }))
  const { call } = viewer({ comments: [elsewhere] })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('missing')
  expect(bundle.skillCommand).toBe('/pr-review-canvas 42')
  expect(bundle.artifact).toBeUndefined()
  expect(bundle.warnings).toEqual([
    'the canvas comment at https://github.com/acme/widgets/pull/42#issuecomment-3001 is for acme/other; skipped',
  ])
})

it('keeps review marks per canvas, and dismissals and hidden threads, in the browser', async () => {
  const { call } = viewer({ comments: [canvasComment(manifest())] })
  await call('GET', '/api/prs/42')
  const marked = (await call('PUT', '/api/prs/42/reviewed/layer:run-path', { reviewed: true }))
    .body as StateResponse
  expect(marked.state.reviewed).toEqual({ 'layer:run-path': true })
  expect(marked.state.reviewedCanvasSha).toBe(HEAD_SHA)

  await call('PUT', '/api/prs/42/points/fp-1/dismissed', { dismissed: true, reason: 'known' })
  await call('PUT', '/api/prs/42/threads/1001/hidden', { hidden: true })
  const { state } = (await call('GET', '/api/prs/42/state')).body as StateResponse
  expect(state.dismissed).toEqual({ 'fp-1': { at: now().toISOString(), reason: 'known' } })
  expect(state.hiddenThreads).toEqual({ '1001': { at: now().toISOString() } })

  // A mark made on another canvas starts the marks again.
  const other = (
    await call('PUT', '/api/prs/42/reviewed/layer:tests', {
      reviewed: true,
      canvasSha: OLD_HEAD,
      canvasMergeBaseSha: BASE_SHA,
    })
  ).body as StateResponse
  expect(other.state.reviewed).toEqual({ 'layer:tests': true })
})

it('refuses what needs the local app with the error envelope the page reads', async () => {
  const { call } = viewer()
  for (const [method, path] of [
    ['POST', '/api/prs/42/chat'],
    ['POST', '/api/prs/42/import'],
    ['GET', '/api/settings'],
  ] as const) {
    const answer = await call(method, path, {})
    expect(answer.status).toBe(501)
    expect(answer.body).toMatchObject({ error: { code: 'NOT_IMPLEMENTED' } })
  }
  expect((await call('GET', '/api/prs/7')).status).toBe(404)
})

it('reports a pull request GitHub does not serve as not found', async () => {
  const { gh } = fakeGithub({})
  const api = createViewerApi({ ...target, number: 43 }, { gh, state: memoryState(), now })
  const answer = await api.handle('GET', new URL('http://viewer.test/api/prs/43'), null)
  expect(answer).toMatchObject({
    status: 404,
    body: { error: { code: 'PR_NOT_FOUND', message: 'acme/widgets#43 was not found, or is not public' } },
  })
})

it('asks GitHub again on refresh', async () => {
  const { call, calls } = viewer()
  await call('GET', '/api/prs/42')
  await call('GET', '/api/prs/42')
  expect(calls.filter(c => c === 'repos/acme/widgets/pulls/42')).toHaveLength(1)
  await call('GET', '/api/prs/42?refresh=1')
  expect(calls).toContain('refresh')
  expect(calls.filter(c => c === 'repos/acme/widgets/pulls/42')).toHaveLength(2)
})

it('names the signed-in reader, and points a missing private pull request at the app install', async () => {
  const { gh } = fakeGithub({ signedIn: true, routes: { user: { login: 'octocat' } } })
  const api = createViewerApi(target, {
    gh,
    state: memoryState(),
    now,
    installUrl: 'https://github.com/apps/pr-review-canvas/installations/new',
  })
  const bundle = (await api.handle('GET', new URL('http://viewer.test/api/prs/42'), null)).body as PrBundle
  expect(bundle.capabilities).toMatchObject({
    login: 'octocat',
    tokenKind: 'github-app',
    canComment: 'unknown',
  })

  const other = createViewerApi(
    { ...target, number: 43 },
    {
      gh,
      state: memoryState(),
      now,
      installUrl: 'https://github.com/apps/pr-review-canvas/installations/new',
    }
  )
  expect(await other.handle('GET', new URL('http://viewer.test/api/prs/43'), null)).toMatchObject({
    status: 404,
    body: {
      error: {
        message:
          'acme/widgets#43 was not found, or the GitHub App is not installed where it can read acme/widgets',
        hint: 'ask an admin of acme to install the app: https://github.com/apps/pr-review-canvas/installations/new',
      },
    },
  })
})

/** GitHub's answer to a review comment on src/app.ts, line 2 of the new side. */
const GH_POSTED_INLINE = {
  id: 5001,
  user: { login: 'octocat' },
  body: 'Why b?',
  path: 'src/app.ts',
  line: 2,
  side: 'RIGHT',
  commit_id: HEAD_SHA,
  created_at: '2026-11-23T12:00:00Z',
  updated_at: '2026-11-23T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
  pull_request_review_id: 7001,
}

function signedInViewer(writes: Record<string, unknown> = {}, extra: Parameters<typeof fakeGithub>[0] = {}) {
  return viewer({
    comments: [canvasComment(manifest())],
    signedIn: true,
    ...extra,
    routes: { user: { login: 'reviewer' }, ...extra.routes },
    writes,
  })
}

it('asks a signed-out reader to sign in before posting, and offers posting once they have', async () => {
  const anonymous = viewer({ comments: [canvasComment(manifest())] })
  expect(((await anonymous.call('GET', '/api/prs/42')).body as PrBundle).capabilities.canComment).toBe(false)
  const refused = await anonymous.call('POST', '/api/prs/42/comments', { kind: 'issue', body: 'hi' })
  expect(refused).toMatchObject({ status: 401, body: { error: { code: 'GH_UNAUTHENTICATED' } } })
  expect(anonymous.posts).toEqual([])

  const { call } = signedInViewer()
  expect(((await call('GET', '/api/prs/42')).body as PrBundle).capabilities).toMatchObject({
    canComment: 'unknown',
    login: 'reviewer',
  })
})

it('posts an inline comment on the head and records it against its attention point', async () => {
  const { call, posts } = signedInViewer({ 'repos/acme/widgets/pulls/42/comments': GH_POSTED_INLINE })
  const answer = await call('POST', '/api/prs/42/comments', {
    kind: 'inline',
    path: 'src/app.ts',
    line: 2,
    side: 'new',
    body: 'Why b?',
    pointFingerprint: 'fp-1',
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
  })
  expect(answer.status).toBe(201)
  expect(posts).toEqual([
    {
      path: 'repos/acme/widgets/pulls/42/comments',
      body: { body: 'Why b?', commit_id: HEAD_SHA, path: 'src/app.ts', line: 2, side: 'RIGHT' },
    },
  ])
  const body = answer.body as { kind: string; comment: { id: number }; state: StateResponse['state'] }
  expect(body.kind).toBe('review')
  expect(body.comment.id).toBe(5001)
  expect(body.state.posted).toEqual([{ commentId: 5001, pointFingerprint: 'fp-1', at: now().toISOString() }])
})

it('refuses a comment on a line the diff does not show, or from a page drawn on another head', async () => {
  const { call, posts } = signedInViewer()
  const offDiff = await call('POST', '/api/prs/42/comments', {
    kind: 'inline',
    path: 'src/app.ts',
    line: 400,
    side: 'new',
    body: 'here?',
  })
  expect(offDiff).toMatchObject({ status: 422, body: { error: { code: 'COMMENT_LINE_NOT_IN_DIFF' } } })
  const moved = await call('POST', '/api/prs/42/comments', { kind: 'issue', body: 'hi', headSha: OLD_HEAD })
  expect(moved).toMatchObject({ status: 409, body: { error: { code: 'CANVAS_STALE' } } })
  expect(posts).toEqual([])
})

it('reads the pull request again before a write, and refuses one drawn before a push', async () => {
  const { call, posts, routes, calls } = signedInViewer({
    'repos/acme/widgets/pulls/42/comments': GH_POSTED_INLINE,
  })
  expect((await call('GET', '/api/prs/42')).status).toBe(200)
  // A commit lands after the page was drawn.
  const pushed = 'f'.repeat(40)
  routes['repos/acme/widgets/pulls/42'] = { ...GH_PULL, head: { ...GH_PULL.head, sha: pushed } }
  routes[`repos/acme/widgets/compare/main...${pushed}`] = { merge_base_commit: { sha: BASE_SHA } }
  const stale = await call('POST', '/api/prs/42/comments', {
    kind: 'inline',
    path: 'src/app.ts',
    line: 2,
    side: 'new',
    body: 'Why b?',
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
  })
  expect(stale).toMatchObject({ status: 409, body: { error: { code: 'CANVAS_STALE' } } })
  // Only the pull request is asked for again: the comments loaded with the page are not.
  expect(calls).toContain('fresh repos/acme/widgets/pulls/42')
  expect(calls).not.toContain('refresh')
  expect(calls.filter(c => c === 'repos/acme/widgets/issues/42/comments')).toHaveLength(1)
  expect(posts).toEqual([])
})

it('names the app permission when GitHub refuses the post', async () => {
  const { call } = signedInViewer({
    'repos/acme/widgets/issues/42/comments': new Error('HTTP 403: Resource not accessible by integration'),
  })
  const answer = await call('POST', '/api/prs/42/comments', { kind: 'issue', body: 'hi' })
  expect(answer).toMatchObject({
    status: 403,
    body: {
      error: {
        code: 'COMMENT_FORBIDDEN',
        hint: expect.stringContaining('Pull requests: read and write'),
      },
    },
  })
})

it('keeps the pending review in the browser and submits it with the review', async () => {
  const { call, posts } = signedInViewer(
    {
      'repos/acme/widgets/pulls/42/reviews': {
        id: 7001,
        state: 'COMMENTED',
        html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
        submitted_at: '2026-11-23T12:00:00Z',
      },
    },
    { routes: { 'repos/acme/widgets/pulls/42/reviews/7001/comments': [GH_POSTED_INLINE] } }
  )
  await call('GET', '/api/prs/42')
  const draft = {
    path: 'src/app.ts',
    line: 2,
    side: 'new',
    body: 'Why b?',
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
  }
  const added = (await call('POST', '/api/prs/42/pending', draft)).body as StateResponse
  expect(added.state.pending).toHaveLength(1)
  const id = added.state.pending[0]!.id
  await call('PATCH', `/api/prs/42/pending/${id}`, { body: 'Why b?' })
  expect((await call('PATCH', '/api/prs/42/pending/nope', { body: 'x' })).status).toBe(404)

  const summary = (await call('GET', '/api/prs/42/review/body')).body as {
    body: string
    pending: number
    unreviewed: string[]
  }
  // Signed as the viewer's: no local app wrote it.
  expect(summary.body.trimEnd().endsWith(VIEWER_REVIEW_BODY_FOOTER)).toBe(true)
  expect(summary.body).not.toContain('localhost')
  expect(summary.pending).toBe(1)
  expect(summary.unreviewed.length).toBeGreaterThan(0)

  const approve = await call('POST', '/api/prs/42/review', { event: 'APPROVE', headSha: HEAD_SHA })
  expect(approve).toMatchObject({ status: 409, body: { error: { code: 'SIGNOFF_INCOMPLETE' } } })

  const submitted = await call('POST', '/api/prs/42/review', { event: 'COMMENT', body: 'Looks fine.' })
  expect(submitted.status).toBe(201)
  expect(posts.at(-1)).toEqual({
    path: 'repos/acme/widgets/pulls/42/reviews',
    body: {
      event: 'COMMENT',
      body: 'Looks fine.',
      commit_id: HEAD_SHA,
      comments: [{ path: 'src/app.ts', body: 'Why b?', line: 2, side: 'RIGHT' }],
    },
  })
  const { state, submitted: count } = submitted.body as { state: StateResponse['state']; submitted: number }
  expect(count).toBe(1)
  expect(state.pending).toEqual([])
  expect(state.submitted).toMatchObject([{ id, reviewId: 7001 }])
  expect(state.posted).toMatchObject([{ commentId: 5001 }])
})

it('refuses a review carrying a draft of an earlier diff until the draft is deleted', async () => {
  const { call, posts, routes } = signedInViewer(
    {
      'repos/acme/widgets/pulls/42/reviews': {
        id: 7003,
        state: 'COMMENTED',
        html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7003',
      },
    },
    { diffs: { [`${BASE_SHA}...${'f'.repeat(40)}`]: SYNTHETIC_DIFF } }
  )
  await call('GET', '/api/prs/42')
  const draft = {
    path: 'src/app.ts',
    line: 2,
    side: 'new',
    body: 'Why b?',
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
  }
  const { state } = (await call('POST', '/api/prs/42/pending', draft)).body as StateResponse
  // A commit lands, its canvas is published, and the reader reloads the page.
  const pushed = 'f'.repeat(40)
  routes['repos/acme/widgets/pulls/42'] = { ...GH_PULL, head: { ...GH_PULL.head, sha: pushed } }
  routes[`repos/acme/widgets/compare/main...${pushed}`] = { merge_base_commit: { sha: BASE_SHA } }
  routes['repos/acme/widgets/issues/42/comments'] = [canvasComment(manifest({ headSha: pushed }), 3005)]
  expect(((await call('GET', '/api/prs/42?refresh=1')).body as PrBundle).status).toBe('ready')

  const review = {
    event: 'COMMENT',
    body: 'looks fine',
    includePending: true,
    headSha: pushed,
    mergeBaseSha: BASE_SHA,
  }
  const refused = await call('POST', '/api/prs/42/review', review)
  expect(refused).toMatchObject({
    status: 409,
    body: { error: { code: 'CANVAS_STALE', message: 'pending comments were written on a different diff' } },
  })
  expect(posts).toEqual([])

  await call('DELETE', `/api/prs/42/pending/${state.pending[0]!.id}`)
  expect((await call('POST', '/api/prs/42/review', review)).status).toBe(201)
  expect(posts).toHaveLength(1)
})

it("refuses the author's own approval, and clears the pending review on request", async () => {
  const { call } = signedInViewer({}, { routes: { user: { login: 'octocat' } } })
  const own = await call('POST', '/api/prs/42/review', { event: 'APPROVE' })
  expect(own).toMatchObject({ status: 403, body: { error: { code: 'SIGNOFF_BY_AUTHOR' } } })
  await call('POST', '/api/prs/42/pending', { path: 'src/app.ts', line: 2, side: 'new', body: 'a' })
  expect(((await call('DELETE', '/api/prs/42/pending')).body as StateResponse).state.pending).toEqual([])
})

it("keeps each reader's drafts and marks apart, so one never submits another's", async () => {
  let reader = 'alice'
  const github = fakeGithub({
    comments: [canvasComment(manifest())],
    signedIn: true,
    writes: {
      'repos/acme/widgets/pulls/42/reviews': {
        id: 7002,
        state: 'COMMENTED',
        html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7002',
      },
    },
  })
  const api = (gh: typeof github.gh) =>
    createViewerApi(target, {
      gh: {
        ...gh,
        api: (path, params) => (path === 'user' ? Promise.resolve({ login: reader }) : gh.api(path, params)),
      },
      state: memoryState(),
      now,
    })
  const viewerApi = api(github.gh)
  const call = (method: string, path: string, body: unknown = null) =>
    viewerApi.handle(method, new URL(path, 'http://viewer.test'), body)

  await call('POST', '/api/prs/42/pending', {
    path: 'src/app.ts',
    line: 2,
    side: 'new',
    body: "alice's draft",
  })
  await call('PUT', '/api/prs/42/reviewed/layer:run-path', { reviewed: true })

  reader = 'bob'
  const { state } = (await call('GET', '/api/prs/42/state')).body as StateResponse
  expect(state.pending).toEqual([])
  expect(state.reviewed).toEqual({})
  await call('POST', '/api/prs/42/review', { event: 'COMMENT', body: 'from bob' })
  expect(github.posts.at(-1)?.body).not.toHaveProperty('comments')

  reader = 'alice'
  expect(((await call('GET', '/api/prs/42/state')).body as StateResponse).state.pending).toHaveLength(1)
})

it('rebuilds a diff GitHub is too slow to send from the file list, and names the files it left out', async () => {
  const tooSlow = new Error('HTTP 422: The diff is taking too long to generate.')
  const listed = [
    {
      filename: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: "@@ -1,1 +1,2 @@\n import { a } from './a'\n+import { b } from './b'",
    },
    { filename: 'data/huge.json', status: 'modified', additions: 90000, deletions: 3 },
  ]
  const { call, calls } = viewer({
    comments: [canvasComment(manifest())],
    diffs: { [`${BASE_SHA}...${HEAD_SHA}`]: tooSlow },
    routes: { 'repos/acme/widgets/pulls/42/files': listed },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('ready')
  expect(calls).toContain('repos/acme/widgets/pulls/42/files')
  expect(bundle.files.find(f => f.path === 'data/huge.json')).toMatchObject({
    additions: 90000,
    deletions: 3,
  })
  // The pull request changes 7 files, and the list GitHub sent holds 2: both gaps are said once.
  expect(bundle.warnings).toHaveLength(1)
  expect(bundle.warnings[0]).toMatch(/too large to diff \(data\/huge\.json\).*so 5 files are not shown/)

  const { patches } = (await call('GET', '/api/prs/42/patches')).body as { patches: Record<string, string> }
  const huge = bundle.files.find(f => f.path === 'data/huge.json')!
  expect(patches[huge.key]).toBeUndefined()
  expect(Object.keys(patches)).toHaveLength(1)
})

it('rebuilds the diff of an older canvas from the comparison, which lists at most 300 files', async () => {
  const listed = Array.from({ length: 300 }, (_, i) => ({
    filename: `gen/file-${i}.ts`,
    status: 'added',
    additions: 1,
    deletions: 0,
    patch: `@@ -0,0 +1,1 @@\n+export const n = ${i}`,
  }))
  const { call } = viewer({
    comments: [canvasComment(manifest({ headSha: OLD_HEAD }))],
    diffs: { [`${BASE_SHA}...${OLD_HEAD}`]: new Error('HTTP 422: The diff is taking too long to generate.') },
    routes: {
      [`repos/acme/widgets/compare/${BASE_SHA}...${OLD_HEAD}`]: { files: listed },
      [`repos/acme/widgets/compare/${OLD_HEAD}...${HEAD_SHA}`]: { status: 'ahead', ahead_by: 1 },
    },
  })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  // A diff with files left out never proves the head's identical, so the canvas reads as outdated.
  expect(bundle.status).toBe('stale')
  expect(bundle.files).toHaveLength(300)
  expect(bundle.warnings).toEqual([expect.stringContaining('GitHub lists at most 300 files of a comparison')])
})

it('skips a canvas comment it cannot read, and says why', async () => {
  const unreadable = { ...canvasComment(manifest(), 3010) }
  unreadable.body = unreadable.body.replace(/\n([A-Za-z0-9+/]{8})/, '\nAAAAAAAA')
  const { call } = viewer({ comments: [unreadable] })
  const bundle = (await call('GET', '/api/prs/42')).body as PrBundle
  expect(bundle.status).toBe('missing')
  expect(bundle.warnings).toEqual([
    'the canvas comment at https://github.com/acme/widgets/pull/42#issuecomment-3010 could not be read: this file is not a zip',
  ])
})

it('answers a body of the wrong shape with 400, and GitHub failures with their message', async () => {
  const { call, routes } = signedInViewer({
    'repos/acme/widgets/issues/42/comments': new Error('HTTP 500: Server Error'),
    'repos/acme/widgets/pulls/42/comments': new Error('HTTP 401: Bad credentials'),
  })
  expect(await call('POST', '/api/prs/42/comments', { kind: 'nope' })).toMatchObject({
    status: 400,
    body: { error: { code: 'BAD_REQUEST' } },
  })
  expect(await call('POST', '/api/prs/42/comments', { kind: 'issue', body: 'hi' })).toMatchObject({
    status: 502,
    body: { error: { code: 'GITHUB_API_ERROR', message: 'HTTP 500: Server Error' } },
  })
  const inline = { kind: 'inline', path: 'src/app.ts', line: 2, side: 'new', body: 'b?' }
  expect(await call('POST', '/api/prs/42/comments', inline)).toMatchObject({
    status: 401,
    body: { error: { code: 'GH_UNAUTHENTICATED' } },
  })
  routes[`repos/acme/widgets/compare/main...${HEAD_SHA}`] = {}
  expect(await call('GET', '/api/prs/42?refresh=1')).toMatchObject({
    status: 502,
    body: { error: { message: 'GitHub did not report the merge base of this pull request' } },
  })
})

it('reports a diff GitHub refuses for another reason than size as its error', async () => {
  const { call } = viewer({ diffs: { [`${BASE_SHA}...${HEAD_SHA}`]: new Error('HTTP 500: boom') } })
  expect(await call('GET', '/api/prs/42')).toMatchObject({
    status: 502,
    body: { error: { code: 'GITHUB_API_ERROR', message: 'HTTP 500: boom' } },
  })
})
