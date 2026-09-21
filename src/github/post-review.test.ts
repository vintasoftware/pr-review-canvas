// @vitest-environment node
// The sign-off call itself: what it sends, and what it makes of the answer.
import { createFakeGh, ghPost, ghPostError, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { HostCliError } from '../host/client.js'
import type { PendingComment } from '../contract/pending.js'
import { postReview, reviewComments } from './post-review.js'

const PATH = 'repos/acme/widgets/pulls/42/reviews'

describe('postReview', () => {
  it('sends the event, the body, and the commit it reviews', async () => {
    const gh = createFakeGh({
      postRoutes: {
        [PATH]: ghPost(() => ({
          id: 7001,
          state: 'APPROVED',
          html_url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
          submitted_at: '2026-09-10T12:00:00Z',
        })),
      },
    })
    expect(await postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'looks good' })).toEqual({
      id: 7001,
      state: 'APPROVED',
      url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-7001',
      submittedAt: '2026-09-10T12:00:00Z',
    })
    expect(gh.calls[0]?.body).toEqual({ event: 'APPROVE', body: 'looks good', commit_id: HEAD_SHA })
  })

  it('reads a review that has no submitted time yet', async () => {
    const gh = createFakeGh({
      postRoutes: { [PATH]: ghPost(() => ({ id: 1, state: 'PENDING', html_url: 'https://github.com/x' })) },
    })
    expect(
      (await postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'REQUEST_CHANGES', body: 'x' })).submittedAt
    ).toBeNull()
  })

  it('passes a refusal from GitHub on to the caller', async () => {
    const gh = createFakeGh({
      postRoutes: { [PATH]: ghPostError(new HostCliError('gh', PATH, 'HTTP 422', 1)) },
    })
    await expect(postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'x' })).rejects.toThrow(
      HostCliError
    )
  })

  it('carries the pending comments into the one call that creates the review', async () => {
    const gh = createFakeGh({
      postRoutes: {
        [PATH]: ghPost(() => ({ id: 7002, state: 'COMMENTED', html_url: 'https://github.com/x' })),
      },
    })
    await postReview(gh, TEST_REPO, 42, HEAD_SHA, {
      event: 'COMMENT',
      body: 'a look',
      comments: [draft({ body: 'one' }), draft({ id: 'p2', line: 9, startLine: 7, body: 'two' })],
    })
    expect(gh.calls[0]?.body).toEqual({
      event: 'COMMENT',
      body: 'a look',
      commit_id: HEAD_SHA,
      comments: [
        { path: 'src/app.ts', line: 4, side: 'RIGHT', body: 'one' },
        { path: 'src/app.ts', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT', body: 'two' },
      ],
    })
  })

  it('sends no comments field when the review carries none', async () => {
    const gh = createFakeGh({
      postRoutes: { [PATH]: ghPost(() => ({ id: 1, state: 'APPROVED', html_url: 'https://github.com/x' })) },
    })
    await postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'x', comments: [] })
    expect(gh.calls[0]?.body).not.toHaveProperty('comments')
  })
})

describe('reviewComments', () => {
  it('names the old side of the diff the way GitHub does', () => {
    expect(reviewComments([draft({ side: 'old' })])).toEqual([
      { path: 'src/app.ts', line: 4, side: 'LEFT', body: 'needs a guard' },
    ])
  })

  it('leaves out a range that covers only the anchor line, which GitHub rejects', () => {
    expect(reviewComments([draft({ startLine: 4 })])[0]).not.toHaveProperty('start_line')
  })
})

/** @param over the fields this draft differs from the plain one in */
function draft(over: Partial<PendingComment> = {}): PendingComment {
  return {
    id: 'p1',
    path: 'src/app.ts',
    line: 4,
    side: 'new',
    body: 'needs a guard',
    headSha: HEAD_SHA,
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
    ...over,
  }
}
