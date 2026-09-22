// @vitest-environment node
// A GitLab origin served through the same routes as GitHub: the Host adapter is the only thing
// that changes, so this is where its GitLab side is exercised end to end.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifactToModelOutput } from '../review/normalize.js'
import { prepare } from '../review/prepare.js'
import { publish } from '../review/publish.js'
import type { PostCommentResponse, PostReviewResponse, PrBundle } from '../contract/api.js'
import { gitlabHost } from '../host/host.js'
import { createApp } from '../server/app.js'
import {
  createFakeGh,
  createFakeGit,
  ghJson,
  ghHandler,
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
/** A review with no pending comments needs no diff to place them with. */
const NO_DIFF = { files: [], patches: {} }

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
  const drafts = new Map<number, { note: string; position?: unknown }>()
  const published: Array<{ id: string; notes: ReturnType<typeof NOTE>[] }> = []
  let nextDraft = 0
  return createFakeGh({
    routes: {
      user: ghJson({ username: 'alice' }),
      'projects/acme%2Fwidgets': ghJson({
        permissions: { project_access: { access_level: 30 }, group_access: null },
      }),
      [MR_API]: ghJson(MR),
      [`${MR_API}/draft_notes`]: ghHandler(() => [...drafts.keys()].map(id => ({ id }))),
      [`${MR_API}/discussions`]: ghHandler(() => [
        { id: 'd1', notes: [NOTE(1001, 'Look here', ON_LINE_4), NOTE(1002, 'Agreed', ON_LINE_4)] },
        { id: 'd2', notes: [NOTE(2001, 'Overall fine')] },
        ...published,
      ]),
    },
    graphql: [
      { project: { mergeRequest: { diffStatsSummary: { additions: 7, deletions: 5, fileCount: 7 } } } },
    ],
    postRoutes: {
      [`${MR_API}/draft_notes`]: ghPost(body => {
        const id = ++nextDraft
        drafts.set(id, body as { note: string; position?: unknown })
        return { id }
      }),
      [`${MR_API}/draft_notes/bulk_publish`]: ghPost(() => {
        for (const [id, draft] of drafts) {
          published.push({ id: `published-${id}`, notes: [NOTE(7000 + id, draft.note, draft.position)] })
        }
        drafts.clear()
        return null
      }),
      ...Object.fromEntries(
        [1, 2, 3].map(id => [
          `${MR_API}/draft_notes/${id}`,
          ghPost(() => {
            drafts.delete(id)
            return null
          }),
        ])
      ),
      [`${MR_API}/discussions`]: ghPost(() => ({ id: 'd3', notes: [NOTE(5001, 'New thread', ON_LINE_4)] })),
      [`${MR_API}/discussions/d1/notes`]: ghPost(() => NOTE(5002, 'A reply', ON_LINE_4)),
      [`${MR_API}/notes`]: ghPost(() => NOTE(6001, 'Overall looks fine')),
      [`${MR_API}/approve`]: ghPost(() => ({ id: 99, iid: 42, web_url: MR.web_url })),
    },
  })
}

/** The clone's view of MR 42, with its head fetched at `headSha`. */
function gitForMr42(headSha = HEAD_SHA) {
  return createFakeGit({
    refs: { 'merge-requests/42/head': headSha, 'refs/heads/main': BASE_SHA, main: BASE_SHA },
    mergeBases: { [`refs/pr/42/base..${headSha}`]: BASE_SHA },
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
    t.ctx.git = gitForMr42(moved)
    await expect(publish(t.ctx, canvasDir, opts)).rejects.toMatchObject({ code: 'CANVAS_STALE' })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    t.ctx.gh = glabFor42()
    t.ctx.git = gitForMr42()
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
      await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'ship it' }, NO_DIFF)
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
      await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'REQUEST_CHANGES', body: 'not yet' }, NO_DIFF)
    ).toEqual({
      comments: [],
      warnings: [],
      id: 6001,
      state: 'CHANGES_REQUESTED',
      url: `${MR.web_url}#note_6001`,
      submittedAt: '2026-09-10T12:00:00Z',
    })
  })

  it('posts a review with no verdict as a note and approves nothing', async () => {
    const gh = glabFor42()
    expect(
      await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'COMMENT', body: 'a look' }, NO_DIFF)
    ).toMatchObject({ id: 6001, state: 'COMMENTED' })
    expect(gh.calls.filter(c => c.kind === 'post').map(c => c.path)).toEqual([`${MR_API}/notes`])
  })

  it.each(['APPROVE', 'REQUEST_CHANGES'] as const)('batch publishes a %s review', async event => {
    const gh = glabFor42()
    t = await makeTestContext({ git: gitForMr42(), gh, host: GL })
    const derived = await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
    const result = await GL.postReview(
      gh,
      TEST_REPO,
      42,
      HEAD_SHA,
      {
        event,
        body: event === 'APPROVE' ? 'ship it' : '',
        comments: [
          {
            id: 'p1',
            path: 'src/app.ts',
            line: 4,
            side: 'new',
            body: 'needs a guard',
            headSha: HEAD_SHA,
            createdAt: '2026-09-10T12:00:00.000Z',
            updatedAt: '2026-09-10T12:00:00.000Z',
          },
        ],
      },
      derived
    )
    const posts = gh.calls.filter(c => c.kind === 'post').map(c => c.path)
    expect(posts).toEqual([
      `${MR_API}/draft_notes`,
      ...(event === 'APPROVE' ? [`${MR_API}/draft_notes`] : []),
      `${MR_API}/draft_notes/bulk_publish`,
      ...(event === 'APPROVE' ? [`${MR_API}/approve`] : []),
    ])
    expect(result.state).toBe(event === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED')
    const discussion = gh.calls.find(c => c.kind === 'post' && c.path.endsWith('/draft_notes'))
    expect(discussion?.body).toMatchObject({
      note: 'needs a guard',
      position: { head_sha: HEAD_SHA, new_line: 4 },
    })
    expect(result.comments).toMatchObject([{ id: 7001, body: 'needs a guard', line: 4 }])
  })
  it.each(['stage', 'publish'])(
    'removes its remote drafts on %s refusal and can retry without duplicates',
    async failure => {
      const gh = glabFor42()
      t = await makeTestContext({ git: gitForMr42(), gh, host: GL })
      const derived = await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
      const input = {
        event: 'COMMENT' as const,
        body: 'summary',
        comments: [
          {
            id: 'p1',
            path: 'src/app.ts',
            line: 4,
            side: 'new' as const,
            body: 'batch comment',
            headSha: HEAD_SHA,
            createdAt: 't',
            updatedAt: 't',
          },
        ],
      }
      const original = gh.post
      let fail = true
      const postSpy = vi.spyOn(gh, 'post').mockImplementation(async (path, body, method) => {
        if (
          fail &&
          ((failure === 'publish' && path.endsWith('/bulk_publish')) ||
            (failure === 'stage' && (body as { note?: string }).note === 'summary'))
        ) {
          throw new Error('refused')
        }
        return original(path, body, method)
      })
      await expect(GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, input, derived)).rejects.toThrow('refused')
      expect(await gh.api(`${MR_API}/draft_notes`)).toEqual([])
      expect(postSpy).toHaveBeenCalledWith(`${MR_API}/draft_notes/1`, {}, 'DELETE')
      fail = false
      const result = await GL.postReview(gh, TEST_REPO, 42, HEAD_SHA, input, derived)
      expect(result.comments).toHaveLength(1)
      expect(result.comments[0]?.body).toBe('batch comment')
    }
  )

  it('preserves a review already drafted in the GitLab UI', async () => {
    const gh = glabFor42()
    await gh.post(`${MR_API}/draft_notes`, { note: 'UI draft' })
    await expect(
      GL.postReview(
        gh,
        TEST_REPO,
        42,
        HEAD_SHA,
        {
          event: 'COMMENT',
          body: 'summary',
          comments: [
            {
              id: 'p1',
              path: 'src/app.ts',
              line: 4,
              side: 'new',
              body: 'canvas draft',
              headSha: HEAD_SHA,
              createdAt: 't',
              updatedAt: 't',
            },
          ],
        },
        NO_DIFF
      )
    ).rejects.toThrow('Finish or discard')
    expect(await gh.api(`${MR_API}/draft_notes`)).toEqual([{ id: 1 }])
    expect(gh.calls.filter(c => c.kind === 'post')).toHaveLength(1)
  })
  it.each(['approval', 'refresh'])(
    'reports a %s failure after publication without failing the submission',
    async failure => {
      const gh = glabFor42()
      t = await makeTestContext({ git: gitForMr42(), gh, host: GL })
      const derived = await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
      const originalPost = gh.post
      const originalApi = gh.api
      let published = false
      vi.spyOn(gh, 'post').mockImplementation(async (path, body, method) => {
        if (failure === 'approval' && path.endsWith('/approve')) throw new Error('approval refused')
        const result = await originalPost(path, body, method)
        if (path.endsWith('/bulk_publish')) published = true
        return result
      })
      vi.spyOn(gh, 'api').mockImplementation(async (path, params) => {
        if (failure === 'refresh' && published && path.endsWith('/discussions')) throw new Error('offline')
        return originalApi(path, params)
      })
      const result = await GL.postReview(
        gh,
        TEST_REPO,
        42,
        HEAD_SHA,
        {
          event: 'APPROVE',
          body: 'summary',
          comments: [
            {
              id: 'p1',
              path: 'src/app.ts',
              line: 4,
              side: 'new',
              body: 'canvas draft',
              headSha: HEAD_SHA,
              createdAt: 't',
              updatedAt: 't',
            },
          ],
        },
        derived
      )
      expect(result.state).toBe(failure === 'approval' ? 'COMMENTED' : 'APPROVED')
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain(
        failure === 'approval' ? 'approval failed' : 'could not be refreshed'
      )
      expect(await gh.api(`${MR_API}/draft_notes`)).toEqual([])
      expect(gh.calls.filter(c => c.path.endsWith('/bulk_publish'))).toHaveLength(1)
    }
  )
  it('submits locally saved drafts through the review route and returns their published threads', async () => {
    const gh = glabFor42()
    t = await makeTestContext({ git: gitForMr42(), gh, host: GL, fixtureArtifact: syntheticArtifact() })
    await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    const draft = await app.request(
      ...post('/api/prs/42/pending', {
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        body: 'route draft',
        headSha: HEAD_SHA,
      })
    )
    expect(draft.status).toBe(201)
    const submitted = await app.request(
      ...post('/api/prs/42/review', {
        event: 'COMMENT',
        body: 'summary',
        headSha: HEAD_SHA,
      })
    )
    expect(submitted.status).toBe(201)
    const result = (await submitted.json()) as PostReviewResponse
    expect(result.state.pending).toEqual([])
    expect(result.submitted).toBe(1)
    expect(result.comments).toMatchObject([{ id: 7001, body: 'route draft', line: 4 }])
    expect((await t.ctx.prs.readComments(42))?.reviewComments.some(c => c.id === 7001)).toBe(true)
  })
  it.each(['changed head', 'concurrent draft', 'replaced draft', 'cleanup failure'])(
    'retains local drafts after %s prevents GitLab submission',
    async failure => {
      const gh = glabFor42()
      t = await makeTestContext({ git: gitForMr42(), gh, host: GL, fixtureArtifact: syntheticArtifact() })
      await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
      const app = createApp(t.ctx)
      await app.request('/api/prs/42', { headers: LOCAL })
      expect(
        (
          await app.request(
            ...post('/api/prs/42/pending', {
              path: 'src/app.ts',
              line: 4,
              side: 'new',
              body: 'keep this draft',
              headSha: HEAD_SHA,
            })
          )
        ).status
      ).toBe(201)
      const originalApi = gh.api
      const originalPost = gh.post
      vi.spyOn(gh, 'api').mockImplementation(async (path, params) => {
        if (failure === 'changed head' && path === MR_API) {
          return { ...MR, diff_refs: { ...MR.diff_refs, head_sha: 'c'.repeat(40) } }
        }
        return originalApi(path, params)
      })
      vi.spyOn(gh, 'post').mockImplementation(async (path, body, method) => {
        if (failure === 'cleanup failure' && (path.endsWith('/bulk_publish') || method === 'DELETE')) {
          throw new Error('GitLab unavailable')
        }
        const result = await originalPost(path, body, method)
        if (
          (failure === 'concurrent draft' || failure === 'replaced draft') &&
          path.endsWith('/draft_notes') &&
          (body as { note?: string }).note === 'summary'
        ) {
          if (failure === 'replaced draft') await originalPost(`${MR_API}/draft_notes/1`, {}, 'DELETE')
          await originalPost(path, { note: 'new UI draft' })
        }
        return result
      })
      const response = await app.request(
        ...post('/api/prs/42/review', {
          event: 'COMMENT',
          body: 'summary',
          headSha: HEAD_SHA,
        })
      )
      expect(response.status).toBe(500)
      expect((await t.ctx.state.read(42)).pending.map(p => p.body)).toEqual(['keep this draft'])
      const text = await response.text()
      expect(text).toContain(
        failure === 'changed head'
          ? 'merge request changed'
          : failure === 'concurrent draft' || failure === 'replaced draft'
            ? 'pending review changed'
            : 'staged drafts remain'
      )
      const remote = await gh.api(`${MR_API}/draft_notes`)
      expect(remote).toEqual(
        failure === 'changed head'
          ? []
          : failure === 'concurrent draft' || failure === 'replaced draft'
            ? [{ id: 3 }]
            : [{ id: 1 }, { id: 2 }]
      )
      if (failure !== 'cleanup failure') {
        expect(gh.calls.some(c => c.path.endsWith('/bulk_publish'))).toBe(false)
      }
    }
  )
})
