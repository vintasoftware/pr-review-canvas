// @ts-check
// @vitest-environment happy-dom
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  applyDismissed,
  dismissedListHtml,
  pointCardHtml,
  pointLink,
  pointLocation,
  pointRowHtml,
  pointsByLevel,
  pointToMarkdown,
  postedUrls,
  queuedFor,
  refreshPointCommands,
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

describe('dismissed points', () => {
  const artifact = syntheticArtifact()
  const BASE = emptyState('2026-09-10T12:00:00.000Z')
  const dismissed = { ...BASE, dismissed: { 'fp-1': { at: BASE.updatedAt } } }

  it('writes the point as a comment a human can read', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    expect(pointToMarkdown(p)).toBe(
      '**Sum instead of product**\n\n' +
        'Look at the operator because the spec is ambiguous; if the spec says sum, this is fine.\n\n' +
        '_src/app.ts:4 · decision · decide · from the pr-review canvas_'
    )
  })

  it('hides the list while nothing is dismissed and names the count when something is', () => {
    document.body.innerHTML = dismissedListHtml(artifact.points, BASE, ctx)
    expect(document.querySelector('.dismissed-list')?.hasAttribute('hidden')).toBe(true)
    document.body.innerHTML = dismissedListHtml(artifact.points, dismissed, ctx)
    expect(document.querySelector('.dismissed-line')?.textContent).toContain('1 dismissed')
    expect(document.querySelector('.findings.dismissed li')?.getAttribute('data-fingerprint')).toBe('fp-1')
    expect(document.querySelector('.findings.dismissed [data-act="point-restore"]')).not.toBeNull()
  })

  it('links a point to the comment it was posted as, and skips one whose comment is unknown', () => {
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
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    document.body.innerHTML = pointCardHtml(p, { ...ctx, posted })
    expect(document.querySelector('.tbtns a')?.getAttribute('href')).toBe('https://github.com/x#r1001')
    expect(document.querySelector('.tbtns a')?.textContent).toBe('view comment')
    expect(document.querySelector('[data-act="point-post"]')).toBeNull()
    document.body.innerHTML = pointCardHtml(p, ctx)
    expect(document.querySelector('.tbtns a')).toBeNull()
    expect(document.querySelector('[data-act="point-post"]')?.textContent).toBe('post to github')
  })

  it('leaves a page that holds none of its parts alone', () => {
    document.body.innerHTML = '<div data-point="unknown"></div>'
    applyDismissed(document, artifact.points, dismissed, ctx)
    expect(document.querySelector('[data-point="unknown"]')?.hasAttribute('hidden')).toBe(false)
  })

  it.each([true, false])('preserves the dismissed list expanded state (%s) when state updates', expanded => {
    document.body.innerHTML = dismissedListHtml(artifact.points, dismissed, ctx)
    const toggle = document.querySelector('[data-act="show-dismissed"]')
    toggle?.setAttribute('aria-expanded', String(expanded))
    if (toggle) {
      toggle.textContent = expanded ? 'hide' : 'show'
    }
    document.querySelector('ol.dismissed')?.toggleAttribute('hidden', !expanded)

    applyDismissed(document, artifact.points, dismissed, ctx)

    expect(document.querySelector('[data-act="show-dismissed"]')?.getAttribute('aria-expanded')).toBe(
      String(expanded)
    )
    expect(document.querySelector('[data-act="show-dismissed"]')?.textContent).toBe(
      expanded ? 'hide' : 'show'
    )
    expect(document.querySelector('ol.dismissed')?.hasAttribute('hidden')).toBe(!expanded)
    expect(document.querySelector('ol.dismissed li')?.getAttribute('data-fingerprint')).toBe('fp-1')
  })

  it('counts the active points of each layer and redraws the summary', () => {
    const first = points[0]
    document.body.innerHTML =
      `<span class="sevsum">${sevsumHtml(artifact.points, artifact.layers)}</span>` +
      '<section data-layer="layer-1"><span class="point-count">1</span>' +
      `<ol>${first === undefined ? '' : pointCardHtml(first, ctx)}</ol></section>` +
      dismissedListHtml(artifact.points, BASE, ctx)
    applyDismissed(document, artifact.points, dismissed, ctx)
    expect(document.querySelector('.point-count')?.textContent).toBe('0')
    expect(document.querySelector('li.finding')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('.dismissed-line')?.textContent).toContain('1 dismissed')
  })

  it('offers both ways to send a point, and says so once it is waiting in the review', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<ol>${pointCardHtml(p, { ...ctx, state })}</ol>`
    // A point's text is written in advance, so it keeps both ways out even with a review open.
    expect([...document.querySelectorAll('li.finding button.cmd')].map(b => b.textContent)).toEqual([
      'copy',
      'post to github',
      'add to review',
      'dismiss',
    ])
    expect(queuedFor(p, { state })).toBe(false)

    const queued = { ...state, pending: [draftFor(p)] }
    expect(queuedFor(p, { state: queued })).toBe(true)
    document.body.innerHTML = `<ol>${pointCardHtml(p, { ...ctx, state: queued })}</ol>`
    const marker = document.querySelector('li.finding .pill.pending')
    expect(marker?.textContent).toBe('in your review')
    // Neither way out is offered again while it waits: the draft itself is edited on the diff.
    expect(document.querySelector('[data-act="point-post"]')).toBeNull()
    expect(document.querySelector('[data-act="point-queue"]')).toBeNull()
  })

  it('draws a point that is already posted as its link, whatever the review holds', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    const state = { ...emptyState('2026-09-10T12:00:00.000Z'), pending: [draftFor(p)] }
    const posted = new Map([[p.fingerprint, 'https://github.com/x#r1001']])
    document.body.innerHTML = `<ol>${pointCardHtml(p, { ...ctx, state, posted })}</ol>`
    expect(document.querySelector('.tbtns a')?.textContent).toBe('view comment')
  })

  it('redraws a point only when it joins the review or leaves it', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML = `<ol>${pointCardHtml(p, { ...ctx, state })}</ol>`
    const el = document.querySelector('li.finding')
    if (el === null) {
      throw new Error('no point element')
    }
    // Nothing changed, so the commands are left exactly as they are.
    expect(refreshPointCommands(el, p, { dismissed: false, state })).toBe(false)

    const queued = { ...state, pending: [draftFor(p)] }
    expect(refreshPointCommands(el, p, { dismissed: false, state: queued })).toBe(true)
    expect(el.querySelector('.pill.pending')?.textContent).toBe('in your review')
    expect(refreshPointCommands(el, p, { dismissed: false, state: queued })).toBe(false)

    // Taking the draft away puts both commands back.
    expect(refreshPointCommands(el, p, { dismissed: false, state })).toBe(true)
    expect([...el.querySelectorAll('button.cmd')].map(b => b.getAttribute('data-act'))).toEqual([
      null,
      'point-post',
      'point-queue',
      'point-dismiss',
    ])
  })

  it('puts a point into and out of the review wherever it is drawn', () => {
    const p = points[0]
    if (!p) {
      throw new Error('no point')
    }
    const state = emptyState('2026-09-10T12:00:00.000Z')
    document.body.innerHTML =
      `<ol class="findings">${pointCardHtml(p, { ...ctx, state })}</ol>` +
      `<table><tbody>${pointRowHtml(p, { ...ctx, state })}</tbody></table>`
    const queued = { ...state, pending: [draftFor(p)] }
    applyDismissed(document.body, points, queued, ctx)
    expect(document.querySelectorAll('.pill.pending.queued').length).toBe(2)
    applyDismissed(document.body, points, state, ctx)
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
