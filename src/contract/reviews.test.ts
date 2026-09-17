import { PostReviewInputSchema, REVIEW_EVENTS } from './reviews.js'

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
