// @vitest-environment node
import { createFakeGh, createFakeGit, ghJson, ghPost, TEST_REPO } from '../testing/fakes.js'
import { BASE_SHA, HEAD_SHA, ghFor42 } from '../testing/synthetic.js'
import { gitlabHost, GITHUB_HOST } from './host.js'
import {
  fetchHostComments,
  fetchPrMeta,
  fetchPrRefs,
  postHostComment,
  postHostReview,
  probeHostCapabilities,
  toPr,
} from './operations.js'

const now = () => new Date('2026-09-10T12:00:00.000Z')
const GL = gitlabHost('gitlab.com')

const GL_MR = {
  iid: 42,
  title: 'feat: add b',
  description: 'body',
  web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/42',
  state: 'opened',
  updated_at: '2026-09-09T09:00:00Z',
  target_branch: 'main',
  source_branch: 'feat/b',
  sha: HEAD_SHA,
  author: { username: 'octocat' },
  diff_refs: { base_sha: BASE_SHA, head_sha: HEAD_SHA, start_sha: BASE_SHA },
}

describe('host operations', () => {
  it('keeps GitHub fetch, comments, post, review, and capabilities on the GitHub client', async () => {
    const gh = ghFor42()
    const meta = await fetchPrMeta(gh, GITHUB_HOST, TEST_REPO, 42)
    expect(meta.number).toBe(42)
    expect(toPr(meta, TEST_REPO, { headSha: HEAD_SHA, mergeBaseSha: BASE_SHA }).url).toContain('github.com')
    const comments = await fetchHostComments(gh, GITHUB_HOST, TEST_REPO, 42, HEAD_SHA, now)
    expect(comments.payload.reviewComments.length).toBeGreaterThan(0)
    expect(await probeHostCapabilities(gh, GITHUB_HOST, TEST_REPO)).toMatchObject({ login: 'octocat' })
    const git = createFakeGit({
      refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    expect(await fetchPrRefs(git, GITHUB_HOST, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
  })

  it('routes GitLab fetch, comments, posts, and capabilities through GitLab APIs', async () => {
    const gh = createFakeGh({
      routes: {
        'projects/acme%2Fwidgets/merge_requests/42': ghJson(GL_MR),
        'projects/acme%2Fwidgets/merge_requests/42/discussions': ghJson([]),
        user: ghJson({ username: 'alice' }),
        'projects/acme%2Fwidgets': ghJson({ permissions: { project_access: { access_level: 30 } } }),
      },
      graphql: [
        { project: { mergeRequest: { diffStatsSummary: { additions: 1, deletions: 1, fileCount: 1 } } } },
      ],
      postRoutes: {
        'projects/acme%2Fwidgets/merge_requests/42/notes': ghPost(() => ({
          id: 9,
          body: 'hi',
          author: { username: 'alice' },
          created_at: '2026-09-10T12:00:00Z',
        })),
        'projects/acme%2Fwidgets/merge_requests/42/approve': ghPost(() => ({
          id: 1,
          iid: 42,
          web_url: GL_MR.web_url,
        })),
      },
    })
    const meta = await fetchPrMeta(gh, GL, TEST_REPO, 42)
    expect(meta.number).toBe(42)
    const comments = await fetchHostComments(gh, GL, TEST_REPO, 42, HEAD_SHA, now)
    expect(comments.payload.reviewComments).toEqual([])
    const posted = await postHostComment(gh, GL, TEST_REPO, 42, HEAD_SHA, { kind: 'issue', body: 'hi' }, [])
    expect(posted.kind).toBe('issue')
    expect(
      await postHostReview(gh, GL, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'ok' })
    ).toMatchObject({ state: 'APPROVED' })
    expect(await probeHostCapabilities(gh, GL, TEST_REPO)).toEqual({
      canComment: true,
      tokenKind: 'glab',
      login: 'alice',
    })
    const git = createFakeGit({
      refs: { 'merge-requests/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
      mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA },
    })
    expect(await fetchPrRefs(git, GL, meta)).toEqual({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
  })

  it('posts a GitHub issue comment through the GitHub path', async () => {
    const gh = ghFor42({
      postRoutes: {
        'repos/acme/widgets/issues/42/comments': ghPost(() => ({
          id: 6001,
          user: { login: 'octocat' },
          body: 'Overall looks fine',
          created_at: '2026-09-10T12:00:00Z',
          html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
        })),
        'repos/acme/widgets/pulls/42/reviews': ghPost(() => ({
          id: 7001,
          state: 'APPROVED',
          html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
          submitted_at: '2026-09-10T12:00:00Z',
        })),
      },
    })
    const posted = await postHostComment(gh, GITHUB_HOST, TEST_REPO, 42, HEAD_SHA, {
      kind: 'issue',
      body: 'Overall looks fine',
    })
    expect(posted.kind).toBe('issue')
    expect(
      await postHostReview(gh, GITHUB_HOST, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'ok' })
    ).toMatchObject({ state: 'APPROVED' })
  })
})
