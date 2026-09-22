// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import {
  pendingBarHtml,
  pendingComments,
  pendingCount,
  pendingForPath,
  pendingLabel,
  pendingRange,
  pendingRowHtml,
  refreshPendingBar,
} from './pending.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')
const BASE = emptyState(NOW.toISOString())

/** @param {Partial<import('./contract-types.js').PendingComment>} [over] */
function draft(over = {}) {
  return /** @type {import('./contract-types.js').PendingComment} */ ({
    id: 'p1',
    path: 'src/app.ts',
    line: 4,
    side: 'new',
    body: 'this needs a guard',
    headSha: 'a'.repeat(40),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  })
}

describe('pendingComments', () => {
  it('reads an empty list from a state an older tool version wrote', () => {
    const { pending: _pending, ...older } = BASE
    expect(pendingComments(/** @type {never} */ (older))).toEqual([])
    expect(pendingCount(null)).toBe(0)
    expect(pendingCount(undefined)).toBe(0)
  })

  it('counts and filters the drafts by the file they sit on', () => {
    const state = {
      ...BASE,
      pending: [draft(), draft({ id: 'p2', path: 'src/other.ts' }), draft({ id: 'p3' })],
    }
    expect(pendingCount(state)).toBe(3)
    expect(pendingForPath(state, 'src/app.ts').map(p => p.id)).toEqual(['p1', 'p3'])
    expect(pendingForPath(state, 'nothing.ts')).toEqual([])
  })
})

describe('pendingLabel', () => {
  it('says one comment in the singular', () => {
    expect(pendingLabel(1)).toBe('1 pending comment')
    expect(pendingLabel(0)).toBe('0 pending comments')
    expect(pendingLabel(4)).toBe('4 pending comments')
  })
})

describe('pendingRange', () => {
  it('names one line, a range, and the old side', () => {
    expect(pendingRange(draft())).toBe('src/app.ts:4')
    expect(pendingRange(draft({ startLine: 2 }))).toBe('src/app.ts:2–4')
    // A start line equal to the anchor is a single-line comment, not a range of one.
    expect(pendingRange(draft({ startLine: 4 }))).toBe('src/app.ts:4')
    expect(pendingRange(draft({ side: 'old' }))).toBe('src/app.ts:4 (old)')
  })
})

describe('pendingRowHtml', () => {
  it('marks the draft as not posted and carries the commands that change it', () => {
    document.body.innerHTML = `<table><tbody>${pendingRowHtml([draft()], NOW)}</tbody></table>`
    const row = document.querySelector('tr.pending-row')
    expect(row?.querySelector('.pill.pending')?.textContent).toBe('pending')
    expect(row?.textContent).toContain('not posted to')
    expect(row?.querySelector('.prose')?.textContent).toContain('this needs a guard')
    expect([...(row?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('data-act'))).toEqual([
      'pending-edit',
      'pending-delete',
    ])
    expect(row?.querySelector('[data-act="pending-delete"]')?.getAttribute('data-pending-id')).toBe('p1')
  })

  it('draws two drafts on one line in the order they were written', () => {
    document.body.innerHTML = `<table><tbody>${pendingRowHtml([draft(), draft({ id: 'p2', body: 'and a test' })], NOW)}</tbody></table>`
    expect(
      [...document.querySelectorAll('.pending-cmt')].map(c => c.getAttribute('data-pending-id'))
    ).toEqual(['p1', 'p2'])
  })
})

describe('pendingBarHtml', () => {
  it('is nothing at all while no review is open', () => {
    expect(pendingBarHtml(0)).toBe('')
  })

  it('says how many are waiting and offers both ways out', () => {
    document.body.innerHTML = pendingBarHtml(2)
    const bar = document.querySelector('.pending-bar')
    expect(bar?.getAttribute('role')).toBe('status')
    expect(bar?.textContent).toContain('2 pending comments')
    // The reviewer is told plainly that nothing has left the machine yet.
    expect(bar?.textContent).toContain('until you submit it')
    expect([...(bar?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('data-act'))).toEqual([
      'pending-finish',
      'pending-discard',
    ])
    // Finishing a review posts, so it is gated with everything else that posts.
    expect(bar?.querySelector('[data-act="pending-finish"]')?.hasAttribute('data-needs-post')).toBe(true)
  })
})

describe('refreshPendingBar', () => {
  it('adds the bar with the first draft and takes it away with the last', () => {
    document.body.innerHTML = '<div class="pending-bar-host"></div>'
    const root = document.body
    expect(refreshPendingBar(root, BASE)).toBe(0)
    expect(root.querySelector('.pending-bar')).toBeNull()
    expect(root.querySelector('.pending-bar-host')?.classList.contains('has-pending')).toBe(false)

    expect(refreshPendingBar(root, { ...BASE, pending: [draft()] })).toBe(1)
    expect(root.querySelector('.pending-bar')?.textContent).toContain('1 pending comment')
    expect(root.querySelector('.pending-bar-host')?.classList.contains('has-pending')).toBe(true)

    expect(refreshPendingBar(root, BASE)).toBe(0)
    expect(root.querySelector('.pending-bar')).toBeNull()
  })

  it('keeps earlier-commit drafts separate and preserves the expanded list on other state changes', () => {
    document.body.innerHTML = '<div class="pending-bar-host"></div>'
    const state = { ...BASE, pending: [draft()] }
    const head = 'f'.repeat(40)
    refreshPendingBar(document.body, state, head)
    const details = document.querySelector('details')
    expect(details?.textContent).toContain('Comments written on earlier commits')
    expect(details?.textContent).toContain('src/app.ts:4')
    expect(details?.querySelector('[data-act="pending-delete"]')).not.toBeNull()
    expect(details?.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe(draft().body)
    details?.setAttribute('open', '')
    refreshPendingBar(document.body, { ...state, reviewed: { 'layer:x': true } }, head)
    expect(document.querySelector('details')).toBe(details)
    expect(details?.open).toBe(true)
    refreshPendingBar(document.body, { ...state, pending: [...state.pending, draft({ id: 'p2' })] }, head)
    expect(document.querySelector('details')?.open).toBe(true)
  })

  it('does nothing when the page has no place for the bar', () => {
    document.body.innerHTML = '<div></div>'
    expect(refreshPendingBar(document.body, { ...BASE, pending: [draft()] })).toBe(1)
  })
})
