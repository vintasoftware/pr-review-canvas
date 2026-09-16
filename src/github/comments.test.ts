// @vitest-environment node
import { createFakeGh, ghHandler, ghJson, TEST_REPO } from '../testing/fakes.js'
import { GH_ISSUE_COMMENTS, GH_REVIEW_COMMENTS, GH_THREADS_PAGE, HEAD_SHA } from '../testing/synthetic.js'
import { COMMENTS_PAGE_SIZE, fetchComments, mapIssueComment, mapReviewComment } from './comments.js'
import { HostCliError } from '../host/client.js'
import { fetchResolvedCommentIds, THREADS_QUERY } from './threads.js'

const now = () => new Date('2026-09-10T12:00:00.000Z')

describe('mapReviewComment', () => {
  it('maps a root comment on the new side', () => {
    expect(mapReviewComment(GH_REVIEW_COMMENTS[0], new Set([1001]))).toEqual({
      id: 1001,
      author: 'reviewer',
      body: 'Why not `a() * b()`?',
      path: 'src/app.ts',
      line: 4,
      originalLine: 4,
      side: 'new',
      outdated: false,
      commitId: HEAD_SHA,
      createdAt: '2026-09-09T10:00:00Z',
      updatedAt: '2026-09-09T10:00:00Z',
      url: 'https://github.com/acme/widgets/pull/42#discussion_r1001',
      resolved: true,
    })
  })

  it('maps a reply, and an outdated LEFT comment with a start line and a deleted author', () => {
    expect(mapReviewComment(GH_REVIEW_COMMENTS[1], new Set()).inReplyToId).toBe(1001)
    expect(mapReviewComment(GH_REVIEW_COMMENTS[2], new Set())).toEqual({
      id: 1003,
      author: 'ghost',
      body: 'Outdated remark',
      path: 'src/app.ts',
      line: null,
      originalLine: 2,
      side: 'old',
      startLine: 1,
      outdated: true,
      commitId: 'c'.repeat(40),
      createdAt: '2026-09-08T10:00:00Z',
      updatedAt: '2026-09-08T10:00:00Z',
      url: 'https://github.com/acme/widgets/pull/42#discussion_r1003',
      resolved: false,
    })
  })
})

describe('mapReviewComment with sparse fields', () => {
  it('defaults line, original line, and side when GitHub omits them', () => {
    const sparse = {
      id: 5,
      user: { login: 'x' },
      body: 'b',
      path: 'p',
      commit_id: 'c',
      created_at: 't',
      html_url: 'u',
    }
    expect(mapReviewComment(sparse, new Set())).toMatchObject({
      line: null,
      originalLine: null,
      side: 'new',
      outdated: true,
    })
  })
})

describe('mapIssueComment', () => {
  it('maps an issue comment and defaults a null body', () => {
    expect(mapIssueComment(GH_ISSUE_COMMENTS[1])).toEqual({
      id: 2002,
      author: 'reviewer',
      body: '',
      createdAt: '2026-09-09T12:00:00Z',
      updatedAt: '2026-09-09T12:00:00Z',
      url: 'https://github.com/acme/widgets/pull/42#issuecomment-2002',
    })
  })

  it('takes the edit time when GitHub reports one, for a comment and for a review comment', () => {
    const edited = { ...GH_ISSUE_COMMENTS[0], updated_at: '2026-09-10T08:00:00Z' }
    expect(mapIssueComment(edited).updatedAt).toBe('2026-09-10T08:00:00Z')
    const editedReview = { ...GH_REVIEW_COMMENTS[0], updated_at: '2026-09-10T09:00:00Z' }
    expect(mapReviewComment(editedReview, new Set()).updatedAt).toBe('2026-09-10T09:00:00Z')
  })
})

describe('fetchResolvedCommentIds', () => {
  it('joins resolved threads across pages and skips null ids', async () => {
    const page1 = {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
            nodes: [{ isResolved: false, comments: { nodes: [{ databaseId: 5 }] } }],
          },
        },
      },
    }
    const gh = createFakeGh({ graphql: [page1, GH_THREADS_PAGE] })
    expect([...(await fetchResolvedCommentIds(gh, TEST_REPO, 42))]).toEqual([1001, 1002])
    expect(gh.calls.map(c => c.params)).toEqual([
      { owner: 'acme', name: 'widgets', number: 42 },
      { owner: 'acme', name: 'widgets', number: 42, after: 'c1' },
    ])
    expect(THREADS_QUERY).toContain('reviewThreads(first: 100, after: $after)')
  })
})

describe('fetchComments', () => {
  const routes = {
    'repos/acme/widgets/pulls/42/comments': ghJson(GH_REVIEW_COMMENTS),
    'repos/acme/widgets/pulls/42/reviews': { kind: 'json' as const, body: [] },
    'repos/acme/widgets/issues/42/comments': ghJson(GH_ISSUE_COMMENTS),
  }

  it('returns both comment kinds with the resolved flag joined in', async () => {
    const gh = createFakeGh({ routes, graphql: [GH_THREADS_PAGE] })
    const { payload, warnings } = await fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)
    expect(warnings).toEqual([])
    expect(payload.fetchedAt).toBe('2026-09-10T12:00:00.000Z')
    expect(payload.headSha).toBe(HEAD_SHA)
    expect(payload.reviewComments.map(c => [c.id, c.resolved])).toEqual([
      [1001, true],
      [1002, true],
      [1003, false],
    ])
    expect(payload.issueComments.map(c => c.author)).toEqual(['ci-bot[bot]', 'reviewer'])
    expect(gh.calls.filter(c => c.kind === 'api').map(c => c.params)).toEqual([
      { per_page: '100', page: '1' },
      { per_page: '100', page: '1' },
      { per_page: '100', page: '1' },
    ])
  })

  it('follows page= until a short page, so a PR with more than 100 comments is complete', async () => {
    const first = GH_REVIEW_COMMENTS[0]
    if (first === undefined) {
      throw new Error('fixture has no review comments')
    }
    const pages: Record<string, unknown[]> = {
      '1': Array.from({ length: COMMENTS_PAGE_SIZE }, (_, i) => ({ ...first, id: 5000 + i })),
      '2': [{ ...first, id: 9999 }],
    }
    const gh = createFakeGh({
      routes: {
        'repos/acme/widgets/pulls/42/comments': ghHandler(({ page = '' }) => pages[page] ?? []),
        'repos/acme/widgets/pulls/42/reviews': { kind: 'json' as const, body: [] },
        'repos/acme/widgets/issues/42/comments': ghJson([]),
      },
      graphql: [GH_THREADS_PAGE],
    })
    const { payload } = await fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)
    expect(payload.reviewComments.map(c => c.id)).toEqual([
      ...Array.from({ length: COMMENTS_PAGE_SIZE }, (_, i) => 5000 + i),
      9999,
    ])
    expect(gh.calls.filter(c => c.path.endsWith('pulls/42/comments')).map(c => c.params)).toEqual([
      { per_page: '100', page: '1' },
      { per_page: '100', page: '2' },
    ])
  })

  it('degrades to resolved: false with a warning when GraphQL fails', async () => {
    const gh = createFakeGh({ routes, graphql: [new HostCliError('gh', 'graphql', 'rate limited', 1)] })
    const { payload, warnings } = await fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)
    expect(payload.reviewComments.every(c => c.resolved === false)).toBe(true)
    expect(warnings).toEqual(['resolved state unavailable: gh api graphql failed (1): rate limited'])
  })

  it('propagates a REST failure', async () => {
    const gh = createFakeGh({ routes: {}, graphql: [GH_THREADS_PAGE] })
    await expect(fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)).rejects.toBeInstanceOf(HostCliError)
  })
})

it('fetches submitted reviews and preserves avatars', async () => {
  const gh = createFakeGh({
    routes: {
      'repos/acme/widgets/pulls/42/comments': ghJson([]),
      'repos/acme/widgets/issues/42/comments': ghJson([]),
      'repos/acme/widgets/pulls/42/reviews': ghJson([
        {
          id: 8,
          user: { login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
          body: '**Looks good**',
          submitted_at: '2026-09-10T10:00:00Z',
          state: 'APPROVED',
          html_url: 'https://github.com/review/8',
        },
        { id: 9, user: null, body: 'draft', state: 'PENDING', html_url: 'https://github.com/review/9' },
      ]),
    },
    graphql: [GH_THREADS_PAGE],
  })
  const { payload } = await fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)
  expect(payload.reviews).toHaveLength(1)
  expect(payload.reviews?.[0]).toMatchObject({
    state: 'APPROVED',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
    body: '**Looks good**',
  })
})

it('preserves review comment avatars and handles deleted issue authors', () => {
  expect(
    mapReviewComment(
      {
        ...GH_REVIEW_COMMENTS[0],
        user: { login: 'reviewer', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
      },
      new Set()
    )
  ).toMatchObject({ author: 'reviewer', avatarUrl: 'https://avatars.githubusercontent.com/u/1' })
  const deleted = mapIssueComment({ ...GH_ISSUE_COMMENTS[0], user: null })
  expect(deleted.author).toBe('ghost')
  expect(deleted).not.toHaveProperty('avatarUrl')
})

it('keeps comment text available when thread resolution throws a non-Error value', async () => {
  const gh = createFakeGh({
    routes: {
      'repos/acme/widgets/pulls/42/comments': ghJson(GH_REVIEW_COMMENTS),
      'repos/acme/widgets/issues/42/comments': ghJson([]),
      'repos/acme/widgets/pulls/42/reviews': ghJson([]),
    },
  })
  gh.graphql = async () => {
    throw 'offline'
  }
  const { payload, warnings } = await fetchComments(gh, TEST_REPO, 42, HEAD_SHA, now)
  expect(warnings).toEqual(['resolved state unavailable: offline'])
  expect(payload.reviewComments[0]?.body).toBe('Why not `a() * b()`?')
  expect(payload.reviewComments.every(comment => !comment.resolved)).toBe(true)
})
