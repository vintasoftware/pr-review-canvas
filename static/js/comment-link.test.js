// @ts-check
// @vitest-environment happy-dom
import { mapReviewComment } from '../../src/github/comments.js'
import { GH_REVIEW_COMMENTS } from '../../src/testing/synthetic.js'
import { isQueuedComment, postedCommentUrl, viewCommentHtml } from './comment-link.js'

const proposed = {
  path: 'src/app.ts',
  line: 4,
  startLine: 3,
  side: /** @type {const} */ ('new'),
  body: 'Review this.',
}
const posted = { ...mapReviewComment(GH_REVIEW_COMMENTS[0], new Set()), body: proposed.body, startLine: 3 }

afterEach(() => document.body.replaceChildren())

it('links to the comment in a new tab', () => {
  document.body.innerHTML = viewCommentHtml(posted.url)
  const link = document.querySelector('a')
  expect(link?.textContent).toBe('view comment')
  expect(link?.getAttribute('href')).toBe(posted.url)
  expect(link?.className).toBe('cmd')
  expect(link?.target).toBe('_blank')
  expect(link?.rel).toBe('noopener noreferrer')
})

it('escapes the comment URL', () => {
  document.body.innerHTML = viewCommentHtml('https://github.com/x?value="&other=1')
  expect(document.querySelector('a')?.getAttribute('href')).toBe('https://github.com/x?value="&other=1')
})

it('finds a posted proposal by its body and complete diff location', () => {
  expect(postedCommentUrl(proposed, [posted])).toBe(posted.url)
})

it.each([6, null])('keeps the link when GitHub moves or removes the current line: %s', line => {
  const moved = { ...posted, line, startLine: 5, originalLine: 4, originalStartLine: 3 }
  expect(postedCommentUrl(proposed, [moved])).toBe(posted.url)
})

it('matches an explicitly single-line original anchor', () => {
  const moved = { ...posted, line: 6, originalLine: 4, originalStartLine: null }
  const { startLine: _startLine, ...singleLine } = proposed
  expect(postedCommentUrl(singleLine, [moved])).toBe(posted.url)
})

it('keeps identical proposals linked to their own comments through two line moves', () => {
  const second = { ...proposed, line: 6, startLine: 5 }
  const originals = [
    { ...posted, originalLine: 4, originalStartLine: 3 },
    {
      ...posted,
      id: 1002,
      url: 'https://github.com/acme/widgets/pull/42#discussion_r1002',
      originalLine: 6,
      originalStartLine: 5,
    },
  ]
  for (const offset of [2, 4]) {
    const moved = originals.map(c => ({
      ...c,
      line: c.originalLine + offset,
      startLine: c.originalStartLine + offset,
    }))
    expect(postedCommentUrl(proposed, moved)).toBe(originals[0]?.url)
    expect(postedCommentUrl(second, moved)).toBe(originals[1]?.url)
    expect(postedCommentUrl(proposed, moved.toReversed())).toBe(originals[0]?.url)
  }
})

it('uses the saved proposal fingerprint after the posted text and coordinates change', () => {
  const proposal = { ...proposed, proposalFingerprint: 'turn:0' }
  const changed = { ...posted, body: 'Edited on GitHub', line: null, proposalFingerprint: 'turn:0' }
  expect(postedCommentUrl(proposal, [changed])).toBe(posted.url)
  expect(postedCommentUrl(proposal, [{ ...posted, proposalFingerprint: 'before-edit' }])).toBe(posted.url)
})

it.each([
  { originalLine: null },
  { originalStartLine: undefined },
  { originalStartLine: null },
  { originalStartLine: 2 },
  { path: 'other.ts' },
  { side: /** @type {const} */ ('old') },
  { body: 'A different comment.' },
  { inReplyToId: 1001 },
])('does not guess a moved proposal link from an incomplete or different anchor: %j', changes => {
  const moved = { ...posted, line: 6, startLine: 5, originalLine: 4, originalStartLine: 3 }
  expect(postedCommentUrl(proposed, [{ ...moved, ...changes }])).toBeUndefined()
})

it.each([
  { path: 'different.ts' },
  { line: 5 },
  { side: /** @type {const} */ ('old') },
  { startLine: 2 },
  { body: 'A different comment.' },
  { inReplyToId: 1001 },
])('does not match a different posted comment: %j', changes => {
  expect(postedCommentUrl(proposed, [{ ...posted, ...changes }])).toBeUndefined()
})

const queued = {
  id: 'p1',
  path: proposed.path,
  line: proposed.line,
  startLine: 3,
  side: proposed.side,
  body: proposed.body,
  headSha: '',
  createdAt: '',
  updatedAt: '',
}

it('finds a queued proposal by its body and complete diff location', () => {
  expect(isQueuedComment(proposed, [queued])).toBe(true)
})

it('keeps an edited draft associated with its proposal and recognizes its edited text again', () => {
  const proposal = { ...proposed, proposalFingerprint: 'turn:0' }
  expect(
    isQueuedComment(proposal, [{ ...queued, body: 'Edited draft', proposalFingerprint: 'turn:0' }])
  ).toBe(true)
  expect(isQueuedComment(proposal, [{ ...queued, proposalFingerprint: 'before-edit' }])).toBe(true)
})

it.each([
  { path: 'different.ts' },
  { line: 5 },
  { side: /** @type {const} */ ('old') },
  { startLine: 2 },
  { body: 'A different comment.' },
])('does not match a different draft: %j', changes => {
  expect(isQueuedComment(proposed, [{ ...queued, ...changes }])).toBe(false)
})
