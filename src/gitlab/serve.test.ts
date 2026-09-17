// @vitest-environment node
// A GitLab origin served through the same routes as GitHub: the Host adapter is the only thing
// that changes, so this is where its GitLab side is exercised end to end.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactToModelOutput } from '../review/normalize.js'
import { prepare } from '../review/prepare.js'
import { publish } from '../review/publish.js'
import type { PostCommentResponse, PrBundle } from '../contract/api.js'
import { gitlabHost } from '../host/host.js'
import { createApp } from '../server/app.js'
import {
  createFakeGh,
  createFakeGit,
  ghJson,
  ghPost,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'

const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }
const GL = gitlabHost('gitlab.example.com')
const MR_API = 'projects/acme%2Fwidgets/merge_requests/42'

const MR = {
  iid: 42,
  title: 'feat: add b',
  description: 'Adds b()',
  web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42',
  state: 'opened',
  updated_at: '2026-09-09T09:00:00Z',
  target_branch: 'main',
  source_branch: 'feat/b',
  sha: HEAD_SHA,
  author: { username: 'alice' },
  diff_refs: { base_sha: BASE_SHA, head_sha: HEAD_SHA, start_sha: BASE_SHA },
  changes_count: '7',
}

const NOTE = (id: number, body: string, position?: unknown) => ({
  id,
  body,
  author: { username: 'alice' },
  created_at: '2026-09-10T12:00:00Z',
  ...(position === undefined ? {} : { position }),
})
const ON_LINE_4 = {
  new_path: 'src/app.ts',
  old_path: 'src/app.ts',
  new_line: 4,
  old_line: null,
  head_sha: HEAD_SHA,
}

function glabFor42() {
  return createFakeGh({
    routes: {
      user: ghJson({ username: 'alice' }),
      'projects/acme%2Fwidgets': ghJson({
        permissions: { project_access: { access_level: 30 }, group_access: null },
      }),
      [MR_API]: ghJson(MR),
      [`${MR_API}/discussions`]: ghJson([
        { id: 'd1', notes: [NOTE(1001, 'Look here', ON_LINE_4), NOTE(1002, 'Agreed', ON_LINE_4)] },
        { id: 'd2', notes: [NOTE(2001, 'Overall fine')] },
      ]),
    },
    graphql: [
      { project: { mergeRequest: { diffStatsSummary: { additions: 7, deletions: 5, fileCount: 7 } } } },
    ],
    postRoutes: {
      [`${MR_API}/discussions`]: ghPost(() => ({ id: 'd3', notes: [NOTE(5001, 'New thread', ON_LINE_4)] })),
      [`${MR_API}/discussions/d1/notes`]: ghPost(() => NOTE(5002, 'A reply', ON_LINE_4)),
      [`${MR_API}/notes`]: ghPost(() => NOTE(6001, 'Overall looks fine')),
      [`${MR_API}/approve`]: ghPost(() => ({ id: 99, iid: 42, web_url: MR.web_url })),
    },
  })
}

function gitForMr42() {
  return createFakeGit({
    refs: { 'merge-requests/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF },
    blobs: SYNTHETIC_BLOBS,
    topLevel: '/repo',
  })
}

function post(path: string, body: unknown): [string, RequestInit] {
  return [path, { method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify(body) }]
}

describe('a GitLab origin', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('prepares and publishes an MR canvas, and refuses a changed head', async () => {
    t = await makeTestContext({ host: GL, gh: glabFor42(), git: gitForMr42() })
    const { canvasDir } = await prepare(
      t.ctx,
      { kind: 'pr', number: 42 },
      { force: false, log: () => undefined }
    )
    await writeFile(join(canvasDir, 'model.json'), JSON.stringify(artifactToModelOutput(syntheticArtifact())))
    const opts = { agent: 'test', harness: 'other' as const, allowStale: false }
    const moved = 'e'.repeat(40)
    t.ctx.gh = createFakeGh({
      routes: { [MR_API]: ghJson({ ...MR, sha: moved, diff_refs: { ...MR.diff_refs, head_sha: moved } }) },
    })
    await expect(publish(t.ctx, canvasDir, opts)).rejects.toMatchObject({ code: 'CANVAS_STALE' })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    t.ctx.gh = glabFor42()
    await expect(publish(t.ctx, canvasDir, opts)).resolves.toMatchObject({
      status: 'published',
      headSha: HEAD_SHA,
    })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
  })

  it('serves the merge request, its threads, and the login through the GitHub routes', async () => {
    const gh = glabFor42()
    const git = gitForMr42()
    t = await makeTestContext({ host: GL, gh, git })
    const app = createApp(t.ctx)
    const res = await app.request('/api/prs/42', { headers: LOCAL })
    expect(res.status).toBe(200)
    const bundle = (await res.json()) as PrBundle
    expect(bundle.pr).toMatchObject({
      number: 42,
      url: MR.web_url,
      author: 'alice',
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      additions: 7,
      deletions: 5,
      changedFiles: 7,
    })
    expect(bundle.comments.reviewComments.map(c => [c.id, c.inReplyToId, c.line])).toEqual([
      [1001, undefined, 4],
      [1002, 1001, 4],
    ])
    expect(bundle.comments.issueComments.map(c => c.url)).toEqual([`${MR.web_url}#note_2001`])
    expect(bundle.capabilities).toEqual({ canComment: true, tokenKind: 'glab', login: 'alice' })
    expect(git.calls[0]).toEqual([
      'fetch',
      'origin',
      `+merge-requests/42/head:refs/pr/42/head`,
      `+refs/heads/main:refs/pr/42/base`,
    ])
    const page = await app.request('/review/42', { headers: LOCAL })
    expect(await page.text()).toContain(
      '"host":{"kind":"gitlab","label":"GitLab","webBase":"https://gitlab.example.com"}'
    )
    const health = (await (await app.request('/api/health', { headers: LOCAL })).json()) as { host: unknown }
    expect(health.host).toEqual({ kind: 'gitlab', label: 'GitLab', webBase: 'https://gitlab.example.com' })
  })

  it('posts an inline discussion, a reply into its thread, and a merge request note', async () => {
    const gh = glabFor42()
    t = await makeTestContext({ host: GL, gh, git: gitForMr42() })
    await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })

    const inline = await app.request(
      ...post('/api/prs/42/comments', {
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        body: 'New thread',
      })
    )
    expect(inline.status).toBe(201)
    expect((await inline.json()) as PostCommentResponse).toMatchObject({
      kind: 'review',
      comment: { id: 5001, path: 'src/app.ts', line: 4, url: `${MR.web_url}#note_5001` },
    })
    const reply = await app.request(
      ...post('/api/prs/42/comments', { kind: 'reply', inReplyToId: 1001, body: 'A reply' })
    )
    expect((await reply.json()) as PostCommentResponse).toMatchObject({
      comment: { id: 5002, inReplyToId: 1001 },
    })
    const note = await app.request(
      ...post('/api/prs/42/comments', { kind: 'issue', body: 'Overall looks fine' })
    )
    expect((await note.json()) as PostCommentResponse).toMatchObject({ kind: 'issue', comment: { id: 6001 } })

    const posts = gh.calls.filter(c => c.kind === 'post')
    expect(posts.map(c => c.path)).toEqual([
      `${MR_API}/discussions`,
      `${MR_API}/discussions/d1/notes`,
      `${MR_API}/notes`,
    ])
    expect(posts[0]?.body).toMatchObject({
      body: 'New thread',
      position: {
        base_sha: BASE_SHA,
        start_sha: BASE_SHA,
        head_sha: HEAD_SHA,
        new_path: 'src/app.ts',
        new_line: 4,
      },
    })
    expect((await t.ctx.prs.readComments(42))?.issueComments.map(c => c.id)).toEqual([2001, 6001])
  })

  it('approves with the head sha and posts request-changes as a note', async () => {
    const gh = glabFor42()
    expect(
      await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'ship it' })
    ).toMatchObject({
      id: 99,
      state: 'APPROVED',
      url: MR.web_url,
    })
    expect(gh.calls.filter(c => c.kind === 'post').map(c => [c.path, c.body])).toEqual([
      [`${MR_API}/notes`, { body: 'ship it' }],
      [`${MR_API}/approve`, { sha: HEAD_SHA }],
    ])
    expect(
      await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'REQUEST_CHANGES', body: 'not yet' })
    ).toEqual({
      id: 6001,
      state: 'CHANGES_REQUESTED',
      url: `${MR.web_url}#note_6001`,
      submittedAt: '2026-09-10T12:00:00Z',
    })
  })
})
