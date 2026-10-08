// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { refreshReviewPanel, reviewPanelHtml } from './review-panel.js'

const artifact = syntheticArtifact()
const HEAD = 'a'.repeat(40)
const NOW = new Date('2026-09-10T12:00:00.000Z')
const BASE = emptyState(NOW.toISOString())

/**
 * @param {Partial<import('./contract-types.js').PendingComment>} over
 * @returns {import('./contract-types.js').PendingComment}
 */
function draft(over) {
  return {
    id: 'd1',
    path: 'src/app.ts',
    line: 4,
    side: 'new',
    body: 'Mind the guard.',
    headSha: HEAD,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  }
}

afterEach(() => document.body.replaceChildren())

describe('the review tab', () => {
  it('says how to start a review while nothing waits', () => {
    document.body.innerHTML = reviewPanelHtml(BASE, { headSha: HEAD, points: artifact.points, now: NOW })
    expect(document.querySelector('.review-empty')?.textContent).toContain('add to review')
    expect(document.querySelector('[data-act="pending-finish"]')).toBeNull()
  })

  it('lists the drafts by file, with where they sit and where they came from', () => {
    const state = {
      ...BASE,
      pending: [
        draft({ id: 'd1', pointFingerprint: 'fp-1' }),
        draft({
          id: 'd2',
          path: 'src/gone.ts',
          line: 3,
          startLine: 1,
          side: 'old',
          proposalFingerprint: 'x',
        }),
        draft({ id: 'd3', line: 6 }),
        draft({ id: 'd4', line: 7, pointFingerprint: 'fp-unknown' }),
      ],
    }
    document.body.innerHTML = reviewPanelHtml(state, { headSha: HEAD, points: artifact.points, now: NOW })
    expect(document.querySelector('.review-head')?.textContent).toContain('4 pending comments')
    expect(document.querySelector('[data-act="pending-finish"]')?.hasAttribute('data-needs-post')).toBe(true)
    expect([...document.querySelectorAll('.review-path')].map(h => h.textContent)).toEqual([
      'src/app.ts',
      'src/gone.ts',
    ])
    const rows = [...document.querySelectorAll('.review-draft')]
    expect(rows.map(r => r.getAttribute('data-pending-id'))).toEqual(['d1', 'd3', 'd4', 'd2'])
    expect(rows.map(r => r.querySelector('.review-where .muted')?.textContent)).toEqual([
      '· from the point “Sum instead of product”',
      '· your comment',
      '· from an attention point',
      '· proposed by AI Chat',
    ])
    expect(rows[3]?.querySelector('a.loc')?.getAttribute('href')).toBe('#line:src/gone.ts:1-3:old')
    expect(rows[0]?.querySelector('a.loc')?.getAttribute('href')).toBe('#line:src/app.ts:4')
    // Each draft keeps the commands it has on the diff.
    expect([...(rows[0]?.querySelectorAll('.pending-cmt button') ?? [])].map(b => b.textContent)).toEqual([
      'edit',
      'delete',
    ])
  })

  it('keeps drafts of earlier commits apart, to copy or delete', () => {
    const state = { ...BASE, pending: [draft({ id: 'old', headSha: 'b'.repeat(40) })] }
    document.body.innerHTML = reviewPanelHtml(state, { headSha: HEAD, points: artifact.points, now: NOW })
    const old = document.querySelector('.review-draft.earlier')
    expect(old?.textContent).toContain('commit bbbbbbb')
    expect(old?.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe('Mind the guard.')
    expect(old?.querySelector('[data-act="pending-delete"]')).not.toBeNull()
    expect(old?.querySelector('[data-act="pending-edit"]')).toBeNull()
    // Without a commit to compare with, every draft is current.
    document.body.innerHTML = reviewPanelHtml(state, { points: artifact.points, now: NOW })
    expect(document.querySelector('.review-draft.earlier')).toBeNull()
  })

  it('redraws only when the drafts change, and keeps the counts up to date', () => {
    document.body.innerHTML =
      '<span class="review-count" data-empty>0</span><button class="review-launcher"></button>' +
      '<section id="review-panel"></section>'
    const ctx = { headSha: HEAD, points: artifact.points }
    const state = { ...BASE, pending: [draft({})] }
    refreshReviewPanel(document, state, ctx)
    const count = document.querySelector('.review-count')
    const launcher = document.querySelector('.review-launcher')
    expect(count?.textContent).toBe('1')
    expect(count?.hasAttribute('data-empty')).toBe(false)
    expect(launcher?.textContent).toBe('Your review · 1')
    expect(launcher?.hasAttribute('data-empty')).toBe(false)
    const row = document.querySelector('.review-draft')
    refreshReviewPanel(document, { ...state, rev: 9 }, ctx)
    expect(document.querySelector('.review-draft')).toBe(row)
    refreshReviewPanel(document, { ...state, pending: [draft({ body: 'Edited.' })] }, ctx)
    expect(document.querySelector('.review-draft')).not.toBe(row)
    expect(document.querySelector('.review-draft .pending-cmt > .prose')?.textContent).toContain('Edited.')
    refreshReviewPanel(document, BASE, ctx)
    expect(count?.hasAttribute('data-empty')).toBe(true)
    expect(launcher?.textContent).toBe('Your review')
    expect(launcher?.hasAttribute('data-empty')).toBe(true)
  })

  it('keeps the row of a draft being edited while other drafts come and go', () => {
    document.body.innerHTML = '<section id="review-panel"></section>'
    const ctx = { headSha: HEAD, points: artifact.points }
    // Two drafts with the same text on the same commit are still two rows.
    const first = draft({ id: 'd1' })
    const twin = draft({ id: 'd2' })
    refreshReviewPanel(document, { ...BASE, pending: [first, twin] }, ctx)
    const row = document.querySelector('.review-draft[data-pending-id="d1"]')
    row?.insertAdjacentHTML('beforeend', '<div class="composer-box"><textarea>half an edit</textarea></div>')

    refreshReviewPanel(document, { ...BASE, pending: [first, twin, draft({ id: 'd3', line: 9 })] }, ctx)
    expect(document.querySelector('.review-draft[data-pending-id="d1"]')).toBe(row)
    expect(row?.querySelector('textarea')?.value).toBe('half an edit')
    expect(document.querySelectorAll('.review-draft')).toHaveLength(3)

    refreshReviewPanel(document, { ...BASE, pending: [first] }, ctx)
    expect(document.querySelector('.review-draft[data-pending-id="d1"]')).toBe(row)
    expect(document.querySelectorAll('.review-draft')).toHaveLength(1)
  })

  it('updates the counts on a page without the tab', () => {
    document.body.innerHTML = '<span class="review-count">0</span>'
    refreshReviewPanel(document, { ...BASE, pending: [draft({})] }, { points: [] })
    expect(document.querySelector('.review-count')?.textContent).toBe('1')
  })
})
