// @vitest-environment node
// What the tool sends to GitHub for a comment, and what it refuses to send.
import { PostCommentInputSchema } from '../contract/comments.js'
import { toFileEntry } from '../git/diff-collector.js'
import { createFakeGh, ghPost, ghPostError, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA, SYNTHETIC_FILES } from '../testing/synthetic.js'
import { GitHubApiError } from './gh.js'
import { checkInlineTarget, commentRequest, ghSide, postComment } from './post-comment.js'

const FILES = SYNTHETIC_FILES.map(toFileEntry)

const GH_POSTED_REVIEW_COMMENT = {
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

const GH_POSTED_ISSUE_COMMENT = {
  id: 6001,
  user: { login: 'octocat' },
  body: 'Overall looks fine',
  created_at: '2026-09-10T12:00:00Z',
  html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
}

describe('checkInlineTarget', () => {
  it('accepts a line inside a hunk on the new side', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 4, side: 'new' })).toBeNull()
  })

  it('accepts a range inside one hunk and refuses one that leaves it', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 4, side: 'new', startLine: 2 })).toBeNull()
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 12, side: 'new', startLine: 4 })).toBe(
      'src/app.ts:4-12 (new) spans more than one hunk'
    )
  })

  it('refuses a range whose first line comes after its last', () => {
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 3, side: 'new', startLine: 4 })).toBe(
      'the first line of the range must come before 3'
    )
  })

  it('refuses a file that is not in the diff and a line outside every hunk', () => {
    expect(checkInlineTarget(FILES, { path: 'src/nope.ts', line: 1, side: 'new' })).toBe(
      'src/nope.ts is not in the diff'
    )
    expect(checkInlineTarget(FILES, { path: 'src/app.ts', line: 400, side: 'new' })).toBe(
      'src/app.ts:400 (new) is not in the diff'
    )
  })
})

describe('commentRequest', () => {
  it('maps an inline comment to the pulls comments endpoint with the head commit', () => {
    const input = PostCommentInputSchema.parse({
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      body: 'Look at this',
    })
    expect(commentRequest(TEST_REPO, 42, HEAD_SHA, input)).toEqual({
      path: 'repos/acme/widgets/pulls/42/comments',
      body: { body: 'Look at this', commit_id: HEAD_SHA, path: 'src/app.ts', line: 4, side: 'RIGHT' },
    })
  })

  it('adds the range only when it spans more than the anchor line', () => {
    const range = commentRequest(TEST_REPO, 42, HEAD_SHA, {
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'old',
      startLine: 2,
      body: 'b',
    })
    expect(range.body).toEqual({
      body: 'b',
      commit_id: HEAD_SHA,
      path: 'src/app.ts',
      line: 4,
      side: 'LEFT',
      start_line: 2,
      start_side: 'LEFT',
    })
    const single = commentRequest(TEST_REPO, 42, HEAD_SHA, {
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      startLine: 4,
      body: 'b',
    })
    expect(single.body).not.toHaveProperty('start_line')
  })

  it('maps a reply and a PR-level comment', () => {
    expect(commentRequest(TEST_REPO, 42, HEAD_SHA, { kind: 'reply', inReplyToId: 1001, body: 'ok' })).toEqual({
      path: 'repos/acme/widgets/pulls/42/comments/1001/replies',
      body: { body: 'ok' },
    })
    expect(commentRequest(TEST_REPO, 42, HEAD_SHA, { kind: 'issue', body: 'ok' })).toEqual({
      path: 'repos/acme/widgets/issues/42/comments',
      body: { body: 'ok' },
    })
  })

  it('names the two sides the way GitHub does', () => {
    expect([ghSide('new'), ghSide('old')]).toEqual(['RIGHT', 'LEFT'])
  })
})

describe('postComment', () => {
  it('returns the review comment GitHub created', async () => {
    const gh = createFakeGh({
      postRoutes: { 'repos/acme/widgets/pulls/42/comments': ghPost(() => GH_POSTED_REVIEW_COMMENT) },
    })
    const result = await postComment(gh, TEST_REPO, 42, HEAD_SHA, {
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      body: 'Look at this',
    })
    expect(result).toEqual({
      kind: 'review',
      comment: {
        id: 5001,
        author: 'octocat',
        body: 'Look at this',
        path: 'src/app.ts',
        line: 4,
        originalLine: 4,
        side: 'new',
        outdated: false,
        commitId: HEAD_SHA,
        createdAt: '2026-09-10T12:00:00Z',
        updatedAt: '2026-09-10T12:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
        resolved: false,
      },
    })
  })

  it('returns the issue comment for a PR-level post', async () => {
    const gh = createFakeGh({
      postRoutes: { 'repos/acme/widgets/issues/42/comments': ghPost(() => GH_POSTED_ISSUE_COMMENT) },
    })
    const result = await postComment(gh, TEST_REPO, 42, HEAD_SHA, { kind: 'issue', body: 'Overall looks fine' })
    expect(result).toEqual({
      kind: 'issue',
      comment: {
        id: 6001,
        author: 'octocat',
        body: 'Overall looks fine',
        createdAt: '2026-09-10T12:00:00Z',
        updatedAt: '2026-09-10T12:00:00Z',
        url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001',
      },
    })
  })

  it('reports a path the fake does not serve, like a 404 from GitHub', async () => {
    const gh = createFakeGh({})
    await expect(postComment(gh, TEST_REPO, 42, HEAD_SHA, { kind: 'issue', body: 'x' })).rejects.toThrow('HTTP 404')
  })

  it('passes the refusal from GitHub on to the caller', async () => {
    const gh = createFakeGh({
      postRoutes: {
        'repos/acme/widgets/pulls/42/comments/1001/replies': ghPostError(
          new GitHubApiError('replies', 'gh: Unprocessable Entity (HTTP 422)', 1)
        ),
      },
    })
    await expect(
      postComment(gh, TEST_REPO, 42, HEAD_SHA, { kind: 'reply', inReplyToId: 1001, body: 'x' })
    ).rejects.toThrow(GitHubApiError)
  })
})
