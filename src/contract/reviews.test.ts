import { PostReviewInputSchema, REVIEW_EVENTS, reviewStateFor } from './reviews.js'

describe('PostReviewInputSchema', () => {
  it('takes the three events and an optional body', () => {
    expect(PostReviewInputSchema.parse({ event: 'APPROVE' })).toEqual({
      event: 'APPROVE',
      includePending: true,
    })
    expect(PostReviewInputSchema.parse({ event: 'REQUEST_CHANGES', body: 'x' })).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'x',
      includePending: true,
    })
    // A review with no verdict is the third event, so a thread-level review needs no approval.
    expect(PostReviewInputSchema.parse({ event: 'COMMENT' })).toEqual({
      event: 'COMMENT',
      includePending: true,
    })
    expect(PostReviewInputSchema.safeParse({ event: 'APPROVE', body: '' }).success).toBe(false)
    expect(PostReviewInputSchema.safeParse({ event: 'MERGE' }).success).toBe(false)
    expect(REVIEW_EVENTS).toEqual(['COMMENT', 'APPROVE', 'REQUEST_CHANGES'])
  })

  it('leaves the pending comments behind only when the page asks it to', () => {
    expect(PostReviewInputSchema.parse({ event: 'COMMENT', includePending: false }).includePending).toBe(
      false
    )
  })

  it('names the state each event leaves the review in', () => {
    expect(REVIEW_EVENTS.map(reviewStateFor)).toEqual(['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'])
  })
})
