// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  applyPointStates,
  hidingHandled,
  openPoints,
  pointCardHtml,
  pointLink,
  pointLocation,
  pointRowHtml,
  pointStatus,
  pointStatusesHtml,
  pointsByLevel,
  pointToMarkdown,
  setMentionCanvas,
  setPointExpanded,
  postedUrls,
  refreshPoint,
  sevsumHtml,
} from './points.js'

const points = syntheticArtifact().points
const ctx = { paths: new Set(['src/app.ts']) }

describe('points', () => {
  it('groups by level', () => {
    const by = pointsByLevel(points)
    expect(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.map(p => p.id)]))).toEqual({
      decide: ['p-1'],
      check: ['p-2'],
      fyi: ['p-3'],
    })
  })

  it('formats links and locations', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    expect(pointLink(p)).toBe('#line:src/app.ts:4')
    expect(pointLink({ ...p, endLine: 6 })).toBe('#line:src/app.ts:4-6')
    expect(pointLink({ ...p, side: 'old' })).toBe('#line:src/app.ts:4:old')
    expect(pointLocation({ ...p, endLine: 6 })).toBe('src/app.ts:4-6')
  })

  it('renders a card with square, kind tag, location link, body, and its four commands', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    document.body.innerHTML = `<ol>${pointCardHtml(p, ctx)}</ol>`
    const li = document.querySelector('li.finding')
    expect(li?.id).toBe('point-p-1')
    expect(li?.querySelector('.sq.decide')?.getAttribute('aria-label')).toBe('decide')
    expect(li?.querySelector('.pill.kind')?.textContent).toBe('decision')
    expect(li?.querySelector('a.loc')?.getAttribute('href')).toBe('#line:src/app.ts:4')
    expect(li?.querySelector('.prose p')?.textContent).toContain('Look at the operator')
    expect([...(li?.querySelectorAll('button.cmd') ?? [])].map(b => b.textContent)).toEqual([
      'copy',
      'post to github',
      'add to review',
      'dismiss',
    ])
    // Only "ask" waits for the chat pane; the other three work.
    // Nothing is disabled while the pane is off: the ask command is simply not there.
    expect([...(li?.querySelectorAll('button.cmd:disabled') ?? [])].map(b => b.textContent)).toEqual([])
    expect(li?.getAttribute('data-fingerprint')).toBe('fp-1')
  })

  it('renders the inline row and the level summary', () => {
    const p = points[1]
    if (!p) {
      throw new Error('no point')
    }
    document.body.innerHTML = `<table><tbody>${pointRowHtml(p, ctx)}</tbody></table>`
    const tr = document.querySelector('tr.ifind')
    expect(tr?.classList.contains('check')).toBe(true)
    expect(tr?.getAttribute('data-point')).toBe('p-2')
    expect(tr?.querySelector('.f-title span:not(.sq):not(.pill)')?.textContent).toBe(p.title)
    document.body.innerHTML = sevsumHtml(points)
    expect(document.querySelector('.sevsum')?.textContent).toBe('111decidecheckfyi')
    expect(document.querySelector('.sevsum a')).toBeNull()
    document.body.innerHTML = sevsumHtml(points, syntheticArtifact().layers)
    expect([...document.querySelectorAll('.sevsum > a')].map(a => a.getAttribute('href'))).toEqual([
      '#layer-run-path',
      '#layer-other',
      '#layer-other',
    ])
    expect(document.querySelector('.sq.decide')?.getAttribute('aria-label')).toBe('1 decide')
    document.body.innerHTML = sevsumHtml([], syntheticArtifact().layers)
    expect(document.querySelector('.sevsum a')).toBeNull()
    expect(document.querySelector('.sevsum')?.textContent).toBe('000decidecheckfyi')
  })
})

describe('where a point stands', () => {
  const artifact = syntheticArtifact()
  const BASE = emptyState('2026-09-10T12:00:00.000Z')
  const dismissed = { ...BASE, dismissed: { 'fp-1': { at: BASE.updatedAt } } }
  const first = points[0]
  if (first === undefined) {
    throw new Error('no point')
  }

  it('writes the point as a comment a human can read', () => {
    expect(pointToMarkdown(first)).toBe(
      '**Sum instead of product**\n\n' +
        'Look at the operator because the spec is ambiguous; if the spec says sum, this is fine.\n\n' +
        '_src/app.ts:4 · decision · decide · from the pr-review canvas_'
    )
  })

  it('leaves the canvas out of the comment when mentionCanvas is off', () => {
    setMentionCanvas(false)
    try {
      expect(pointToMarkdown(first)).toMatch(/_src\/app\.ts:4 · decision · decide_$/)
      expect(pointToMarkdown(first).toLowerCase()).not.toContain('canvas')
    } finally {
      setMentionCanvas(true)
    }
  })

  it('reads the status from the state, the one that says most winning', () => {
    const fp = first.fingerprint
    const at = BASE.updatedAt
    expect(pointStatus(first, undefined)).toBe('open')
    expect(pointStatus(first, BASE)).toBe('open')
    expect(pointStatus(first, dismissed)).toBe('dismissed')
    const queued = { ...dismissed, pending: [draftFor(first)] }
    expect(pointStatus(first, queued)).toBe('queued')
    expect(pointStatus(first, { ...queued, posted: [{ commentId: 1, pointFingerprint: fp, at }] })).toBe(
      'posted'
    )
    // A review submitted while its comment list could not be read still sent the point.
    expect(pointStatus(first, { ...BASE, submitted: [draftFor(first)] })).toBe('posted')
    expect(openPoints(points, queued).map(p => p.id)).toEqual(['p-2', 'p-3'])
  })

  it('counts the points by status in the overview, and offers to hide the ones acted on', () => {
    document.body.innerHTML = pointStatusesHtml([], BASE)
    expect(document.querySelector('.point-statuses')?.hasAttribute('hidden')).toBe(true)
    document.body.innerHTML = pointStatusesHtml(points, BASE)
    expect(document.querySelector('.point-statuses')?.textContent).toBe('Attention points: 3 open')
    expect(document.querySelector('[data-act="toggle-handled"]')).toBeNull()
    const second = points[1]
    if (second === undefined) throw new Error('no point')
    const state = { ...dismissed, pending: [{ ...draftFor(second), id: 'p2' }] }
    document.body.innerHTML = pointStatusesHtml(points, state)
    expect(document.querySelector('.point-statuses')?.textContent).toBe(
      'Attention points: 1 open · 1 in your review · 1 dismissed hide the 2 acted on'
    )
    expect(hidingHandled(document)).toBe(false)
    document.body.innerHTML = pointStatusesHtml(points, state, true)
    expect(document.querySelector('[data-act="toggle-handled"]')?.textContent).toBe('show the 2 acted on')
    expect(hidingHandled(document)).toBe(true)
  })

  it('links a posted point to its comment, and says it was sent when the comment is unknown', () => {
    const state = {
      ...BASE,
      posted: [
        { commentId: 1001, pointFingerprint: 'fp-1', at: BASE.updatedAt },
        { commentId: 4242, pointFingerprint: 'fp-2', at: BASE.updatedAt },
        { commentId: 1002, at: BASE.updatedAt },
      ],
    }
    const posted = postedUrls(state, [{ id: 1001, url: 'https://github.com/x#r1001' }])
    expect([...posted]).toEqual([['fp-1', 'https://github.com/x#r1001']])
    document.body.innerHTML = pointCardHtml(first, { ...ctx, state, posted })
    expect(document.querySelector('.pill.status.posted')?.textContent).toBe('posted')
    expect(document.querySelector('.p-summary a')?.getAttribute('href')).toBe('https://github.com/x#r1001')
    expect(document.querySelector('.tbtns a')?.textContent).toBe('view comment')
    expect(document.querySelector('[data-act="point-post"]')).toBeNull()
    const second = points[1]
    if (second === undefined) throw new Error('no point')
    document.body.innerHTML = pointCardHtml(second, { ...ctx, state, posted })
    expect(document.querySelector('.p-summary')?.textContent).toBe('Sent to GitHub with your review')
    expect(document.querySelector('.tbtns a')).toBeNull()
    document.body.innerHTML = pointCardHtml(first, ctx)
    expect(document.querySelector('.tbtns a')).toBeNull()
    expect(document.querySelector('[data-act="point-post"]')?.textContent).toBe('post to github')
  })

  it('keeps a dismissed point in place, collapsed, with the way to restore it', () => {
    document.body.innerHTML =
      `<ol>${pointCardHtml(first, { ...ctx, state: dismissed })}</ol>` +
      `<table><tbody>${pointRowHtml(first, { ...ctx, state: dismissed })}</tbody></table>`
    for (const el of document.querySelectorAll('[data-point]')) {
      expect(el.hasAttribute('hidden')).toBe(false)
      expect(el.getAttribute('data-status')).toBe('dismissed')
      expect(el.classList.contains('is-handled')).toBe(true)
      expect(el.hasAttribute('data-expanded')).toBe(false)
      expect(el.querySelector('.p-summary')?.textContent).toContain('You dismissed this point')
      expect([...el.querySelectorAll('.tbtns button')].map(b => b.getAttribute('data-act'))).toEqual([
        null,
        'point-restore',
      ])
    }
    // An open point is drawn whole and has nothing to expand.
    document.body.innerHTML = `<ol>${pointCardHtml(first, ctx)}</ol>`
    expect(document.querySelector('.is-handled, [data-act="point-expand"], .p-summary')).toBeNull()
  })

  it('expands and collapses a point acted on, never an open one', () => {
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state: dismissed })}</ol>`
    const el = document.querySelector('li.finding')
    const toggle = el?.querySelector('[data-act="point-expand"]')
    if (el === null || toggle === null || toggle === undefined) throw new Error('no point')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    setPointExpanded(el)
    expect(el.hasAttribute('data-expanded')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('hide')
    expect(toggle.getAttribute('aria-label')).toBe(`Hide the point: ${first.title}`)
    setPointExpanded(el)
    expect(el.hasAttribute('data-expanded')).toBe(false)
    expect(toggle.textContent).toBe('show')
    document.body.innerHTML = `<ol>${pointCardHtml(first, ctx)}</ol>`
    const open = document.querySelector('li.finding')
    if (open === null) throw new Error('no point')
    setPointExpanded(open, true)
    expect(open.hasAttribute('data-expanded')).toBe(false)
  })

  it('leaves a page that holds none of its parts alone', () => {
    document.body.innerHTML = '<div data-point="unknown" data-status="open"></div>'
    applyPointStates(document, artifact.points, dismissed, ctx)
    expect(document.querySelector('[data-point="unknown"]')?.getAttribute('data-status')).toBe('open')
  })

  it.each([true, false])(
    'keeps the switch that hides the points acted on (%s) when state updates',
    hiding => {
      document.body.innerHTML = pointStatusesHtml(artifact.points, dismissed, hiding)
      applyPointStates(document, artifact.points, dismissed, ctx)
      expect(hidingHandled(document)).toBe(hiding)
      expect(document.querySelector('.point-statuses')?.textContent).toContain('1 dismissed')
    }
  )

  it('counts the open points of each layer and collapses a point once it is acted on', () => {
    document.body.innerHTML =
      `<span class="sevsum">${sevsumHtml(artifact.points, artifact.layers)}</span>` +
      '<section data-layer="run-path"><span class="point-count">1</span>' +
      `<ol>${pointCardHtml(first, ctx)}</ol></section>` +
      pointStatusesHtml(artifact.points, BASE)
    applyPointStates(document, artifact.points, dismissed, ctx)
    expect(document.querySelector('.point-count')?.textContent).toBe('0')
    const card = document.querySelector('li.finding')
    expect(card?.hasAttribute('hidden')).toBe(false)
    expect(card?.getAttribute('data-status')).toBe('dismissed')
    expect(document.querySelector('.point-statuses')?.textContent).toContain('1 dismissed')
  })

  it('offers both ways to send a point, and shows its draft once it is waiting in the review', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state })}</ol>`
    // A point's text is written in advance, so it keeps both ways out even with a review open.
    expect([...document.querySelectorAll('li.finding button.cmd')].map(b => b.textContent)).toEqual([
      'copy',
      'post to github',
      'add to review',
      'dismiss',
    ])

    const queued = { ...state, pending: [draftFor(first)] }
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state: queued })}</ol>`
    expect(document.querySelector('li.finding .f-title .pill.pending.queued')?.textContent).toBe(
      'in your review'
    )
    expect(document.querySelector('.p-summary')?.textContent).toBe('Waits in your review · not on GitHub yet')
    // The draft itself is shown under the point, with its own edit and delete.
    const draft = document.querySelector('.p-outcome .pending-cmt')
    expect(draft?.getAttribute('data-pending-id')).toBe('p1')
    expect([...(draft?.querySelectorAll('button') ?? [])].map(b => b.getAttribute('data-act'))).toEqual([
      'pending-edit',
      'pending-delete',
    ])
    // Neither way out is offered again while it waits.
    expect(document.querySelector('[data-act="point-post"]')).toBeNull()
    expect(document.querySelector('[data-act="point-queue"]')).toBeNull()

    const edited = { ...state, pending: [{ ...draftFor(first), body: 'my words' }] }
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state: edited })}</ol>`
    expect(document.querySelector('.p-summary')?.textContent).toContain('Your edited draft waits')
  })

  it('draws a point that is already posted as its link, whatever the review holds', () => {
    const state = {
      ...emptyState('2026-09-10T12:00:00.000Z'),
      pending: [draftFor(first)],
      posted: [{ commentId: 1001, pointFingerprint: first.fingerprint, at: BASE.updatedAt }],
    }
    const posted = new Map([[first.fingerprint, 'https://github.com/x#r1001']])
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state, posted })}</ol>`
    expect(document.querySelector('.tbtns a')?.textContent).toBe('view comment')
  })

  it('redraws a point only when what it shows changes, keeping it expanded while its status holds', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state })}</ol>`
    const el = document.querySelector('li.finding')
    if (el === null) {
      throw new Error('no point element')
    }
    // Nothing changed, so the point is left exactly as it is.
    expect(refreshPoint(el, first, { ...ctx, state })).toBe(false)

    const queued = { ...state, pending: [draftFor(first)] }
    expect(refreshPoint(el, first, { ...ctx, state: queued })).toBe(true)
    expect(el.getAttribute('data-status')).toBe('queued')
    expect(el.hasAttribute('data-expanded')).toBe(false)
    expect(refreshPoint(el, first, { ...ctx, state: queued })).toBe(false)

    // An edit to the draft redraws it, and the reader's expanded view stays.
    setPointExpanded(el, true)
    const edited = { ...state, pending: [{ ...draftFor(first), body: 'my words' }] }
    expect(refreshPoint(el, first, { ...ctx, state: edited })).toBe(true)
    expect(el.hasAttribute('data-expanded')).toBe(true)
    expect(el.querySelector('[data-act="point-expand"]')?.textContent).toBe('hide')
    expect(el.querySelector('.pending-cmt .prose')?.textContent).toContain('my words')

    // Taking the draft away opens the point again, with every command back.
    expect(refreshPoint(el, first, { ...ctx, state })).toBe(true)
    expect(el.classList.contains('is-handled')).toBe(false)
    expect(el.hasAttribute('data-expanded')).toBe(false)
    expect([...el.querySelectorAll('button.cmd')].map(b => b.getAttribute('data-act'))).toEqual([
      null,
      'point-post',
      'point-queue',
      'point-dismiss',
    ])
  })

  it('moves the focus from the command used to the toggle that now stands for the point', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<ol>${pointCardHtml(first, { ...ctx, state })}</ol>`
    const el = document.querySelector('li.finding')
    const dismiss = el?.querySelector('[data-act="point-dismiss"]')
    if (el === null || !(dismiss instanceof HTMLElement)) throw new Error('no point')
    dismiss.focus()
    refreshPoint(el, first, { ...ctx, state: dismissed })
    expect(document.activeElement?.getAttribute('data-act')).toBe('point-expand')
  })

  it('redraws a row in the diff in place', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<table><tbody>${pointRowHtml(first, { ...ctx, state })}</tbody></table>`
    const row = document.querySelector('tr.ifind')
    if (row === null) throw new Error('no row')
    expect(refreshPoint(row, first, { ...ctx, state: dismissed })).toBe(true)
    expect(document.querySelector('tr.ifind')).toBe(row)
    expect(row.classList.contains('decide')).toBe(true)
    expect(row.getAttribute('data-status')).toBe('dismissed')
  })

  it('puts a point into and out of the review wherever it is drawn', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML =
      `<ol class="findings">${pointCardHtml(first, { ...ctx, state })}</ol>` +
      `<table><tbody>${pointRowHtml(first, { ...ctx, state })}</tbody></table>`
    const queued = { ...state, pending: [draftFor(first)] }
    applyPointStates(document.body, points, queued, ctx)
    expect(document.querySelectorAll('.pill.pending.queued').length).toBe(2)
    // The card shows the draft; the row leaves it to the draft's own row right under it.
    expect(document.querySelector('li.finding .p-outcome .pending-cmt')).not.toBeNull()
    expect(document.querySelector('tr.ifind .pending-cmt')).toBeNull()
    applyPointStates(document.body, points, state, ctx)
    expect(document.querySelectorAll('.pill.pending.queued').length).toBe(0)
    expect(document.querySelectorAll('[data-act="point-queue"]').length).toBe(2)
  })
})

/** @param {import('./contract-types.js').Point} p */
function draftFor(p) {
  return /** @type {import('./contract-types.js').PendingComment} */ ({
    id: 'p1',
    path: p.path,
    line: p.line,
    side: p.side ?? 'new',
    body: pointToMarkdown(p),
    pointFingerprint: p.fingerprint,
    headSha: 'a'.repeat(40),
    createdAt: '2026-09-10T12:00:00.000Z',
    updatedAt: '2026-09-10T12:00:00.000Z',
  })
}
