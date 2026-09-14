// @vitest-environment node
// The sign-off call itself: what it sends, and what it makes of the answer.
import { createFakeGh, ghPost, ghPostError, TEST_REPO } from '../testing/fakes.js'
import { HEAD_SHA } from '../testing/synthetic.js'
import { GitHubApiError } from './gh.js'
import { PostReviewInputSchema, postReview, REVIEW_EVENTS } from './post-review.js'

const PATH = 'repos/acme/widgets/pulls/42/reviews'

describe('PostReviewInputSchema', () => {
  it('takes the two events and an optional body', () => {
    expect(PostReviewInputSchema.parse({ event: 'APPROVE' })).toEqual({ event: 'APPROVE' })
    expect(PostReviewInputSchema.parse({ event: 'REQUEST_CHANGES', body: 'x' })).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'x',
    })
    expect(PostReviewInputSchema.safeParse({ event: 'COMMENT' }).success).toBe(false)
    expect(PostReviewInputSchema.safeParse({ event: 'APPROVE', body: '' }).success).toBe(false)
    expect(REVIEW_EVENTS).toEqual(['APPROVE', 'REQUEST_CHANGES'])
  })
})

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
    const gh = createFakeGh({ postRoutes: { [PATH]: ghPostError(new GitHubApiError(PATH, 'HTTP 422', 1)) } })
    await expect(postReview(gh, TEST_REPO, 42, HEAD_SHA, { event: 'APPROVE', body: 'x' })).rejects.toThrow(
      GitHubApiError
    )
  })
})
