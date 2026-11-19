import { buildCanvasComment } from '../src/canvas/comment.js'
import { buildCanvasZip } from '../src/canvas/zip.js'
import type { PrBundle, StateResponse } from '../src/contract/api.js'
import type { CanvasManifest } from '../src/contract/canvas-manifest.js'
import { tallyCanvas } from '../src/review/self-review.js'
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
import { createViewerState } from './review-state.js'
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
  const zip = { name: 'pr-42-canvas.zip', headSha: m.headSha, prNumber: 42, bytes }
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
  diffs?: Record<string, string>
  routes?: Record<string, unknown>
}) {
  const calls: string[] = []
  const routes: Record<string, unknown> = {
    'repos/acme/widgets/pulls/42': GH_PULL,
    [`repos/acme/widgets/compare/main...${HEAD_SHA}`]: { merge_base_commit: { sha: BASE_SHA } },
    'repos/acme/widgets/pulls/42/comments': GH_REVIEW_COMMENTS,
    'repos/acme/widgets/pulls/42/reviews': [],
    'repos/acme/widgets/issues/42/comments': [...GH_ISSUE_COMMENTS, ...(opts.comments ?? [])],
    ...opts.routes,
  }
  const diffs: Record<string, string> = { [`${BASE_SHA}...${HEAD_SHA}`]: SYNTHETIC_DIFF, ...opts.diffs }
  const gh: BrowserGithub = {
    api(path, params) {
      calls.push(path)
      if (!(path in routes)) return Promise.reject(new Error(`HTTP 404: no route ${path}`))
      const body = routes[path]
      // One page holds everything: a second page asked for is empty.
      return Promise.resolve(params?.['page'] === '2' ? [] : body)
    },
    apiWithHeaders: () => Promise.reject(new Error('unused')),
    post: () => Promise.reject(new Error('read-only')),
    graphql: () => Promise.reject(new Error('needs a token')),
    authStatus: () => Promise.resolve({ installed: true, authenticated: false, detail: 'anonymous' }),
    authToken: () => Promise.resolve(null),
    diff(_owner, _repo, base, head) {
      calls.push(`diff ${base}...${head}`)
      const text = diffs[`${base}...${head}`]
      return text === undefined ? Promise.reject(new Error('HTTP 404: no diff')) : Promise.resolve(text)
    },
    refresh: () => calls.push('refresh'),
  }
  return { gh, calls }
}

function viewer(opts: Parameters<typeof fakeGithub>[0] = {}) {
  const github = fakeGithub(opts)
  const state = createViewerState('github/acme/widgets/42', { storage: null, now })
  const api = createViewerApi(target, { gh: github.gh, state, now })
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
  expect(bundle.warnings).toEqual([])

  const patches = (await call('GET', '/api/prs/42/patches')).body as { patches: Record<string, string> }
  expect(Object.keys(patches.patches)).toEqual(bundle.files.map(f => f.key))
})

it('reads the newest canvas comment when the pull request has several', async () => {
  const older = {
    ...canvasComment(manifest({ headSha: OLD_HEAD }), 3001),
    created_at: '2026-11-01T00:00:00Z',
  }
  const { call } = viewer({ comments: [older, canvasComment(manifest(), 3002)] })
  expect(((await call('GET', '/api/prs/42')).body as PrBundle).canvas?.headSha).toBe(HEAD_SHA)
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
    ['POST', '/api/prs/42/comments'],
    ['POST', '/api/prs/42/review'],
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
  const api = createViewerApi(
    { ...target, number: 43 },
    { gh, state: createViewerState('x', { storage: null }), now }
  )
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
