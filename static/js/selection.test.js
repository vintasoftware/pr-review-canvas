// @ts-check
// @vitest-environment happy-dom
import { toPatchMap } from '../../src/git/diff-collector.js'
import { SYNTHETIC_FILES } from '../../src/testing/synthetic.js'
import { renderDiff } from './diff-renderer.js'
import { lineRefFromEvent, markSelection, selectionLabel, selectionReducer, selectionToolbarHtml } from './selection.js'

const KEY = 'src_app_ts'
const PATH = 'src/app.ts'

/** @type {import('./selection.js').LineRef} */
const line4 = { key: KEY, path: PATH, side: 'new', line: 4 }
/** @type {import('./selection.js').LineRef} */
const line2 = { key: KEY, path: PATH, side: 'new', line: 2 }
/** @type {import('./selection.js').LineRef} */
const otherFile = { key: 'src_new_ts', path: 'src/new.ts', side: 'new', line: 1 }

function single(line = 4, dragging = false) {
  return { key: KEY, path: PATH, side: /** @type {const} */ ('new'), anchor: line, start: line, end: line, dragging }
}

describe('selectionReducer', () => {
  it('selects a line on click', () => {
    expect(selectionReducer(null, { type: 'click', target: line4 })).toEqual(single(4))
  })

  it('deselects when the same single line is clicked again', () => {
    expect(selectionReducer(single(4), { type: 'click', target: line4 })).toBeNull()
  })

  it('starts over when another line, file, or side is clicked', () => {
    expect(selectionReducer(single(4), { type: 'click', target: line2 })).toEqual(single(2))
    expect(selectionReducer(single(4), { type: 'click', target: otherFile })).toEqual({
      key: 'src_new_ts',
      path: 'src/new.ts',
      side: 'new',
      anchor: 1,
      start: 1,
      end: 1,
      dragging: false,
    })
    const oldSide = { ...line4, side: /** @type {const} */ ('old') }
    expect(selectionReducer(single(4), { type: 'click', target: oldSide })?.side).toBe('old')
  })

  it('extends from the anchor on shift-click, in both directions', () => {
    expect(selectionReducer(single(4), { type: 'shift-click', target: line2 })).toEqual({
      ...single(4),
      start: 2,
      end: 4,
    })
    expect(selectionReducer(single(2), { type: 'shift-click', target: line4 })).toEqual({
      ...single(2),
      start: 2,
      end: 4,
    })
  })

  it('shift-clicking in another file starts a new selection there', () => {
    expect(selectionReducer(single(4), { type: 'shift-click', target: otherFile })?.key).toBe('src_new_ts')
    expect(selectionReducer(null, { type: 'shift-click', target: line4 })).toEqual(single(4))
  })

  it('extends while dragging and stops extending once the pointer is released', () => {
    const dragging = selectionReducer(null, { type: 'drag-start', target: line2 })
    expect(dragging).toEqual(single(2, true))
    const wider = selectionReducer(dragging, { type: 'drag-over', target: line4 })
    expect(wider).toEqual({ ...single(2, true), start: 2, end: 4 })
    const committed = selectionReducer(wider, { type: 'commit' })
    expect(committed).toEqual({ ...single(2, false), start: 2, end: 4 })
    // After the release, moving over another line changes nothing.
    expect(selectionReducer(committed, { type: 'drag-over', target: line2 })).toBe(committed)
  })

  it('ignores a drag over another file and a commit with nothing selected', () => {
    const dragging = selectionReducer(null, { type: 'drag-start', target: line2 })
    expect(selectionReducer(dragging, { type: 'drag-over', target: otherFile })).toBe(dragging)
    expect(selectionReducer(null, { type: 'drag-over', target: line4 })).toBeNull()
    expect(selectionReducer(null, { type: 'commit' })).toBeNull()
  })

  it('clears on Esc', () => {
    expect(selectionReducer(single(4), { type: 'clear' })).toBeNull()
  })
})

describe('selectionLabel', () => {
  it('names one line and a range', () => {
    expect(selectionLabel(single(4))).toBe('src/app.ts line 4')
    expect(selectionLabel({ ...single(2), end: 4 })).toBe('src/app.ts lines 2–4')
  })
})

describe('markSelection', () => {
  const entry = SYNTHETIC_FILES.find(f => f.path === PATH)
  beforeEach(() => {
    const patch = toPatchMap(SYNTHETIC_FILES)[KEY] ?? ''
    document.body.innerHTML = `<div id="card">${renderDiff({ key: KEY, path: PATH, lang: entry?.lang }, patch)}</div>`
  })

  it('marks every row of the range and puts the toolbar under the last one', () => {
    const last = markSelection(document.body, { ...single(2), end: 4 })
    expect([...document.querySelectorAll('tr.is-selected')].map(r => r.id)).toEqual([
      'L-src_app_ts-new-2',
      'L-src_app_ts-new-3',
      'L-src_app_ts-new-4',
    ])
    expect(last?.id).toBe('L-src_app_ts-new-4')
    expect(last?.nextElementSibling?.classList.contains('sel-bar')).toBe(true)
    expect(document.querySelector('tr.sel-bar .lbl')?.textContent).toBe('src/app.ts lines 2–4')
    expect(document.querySelector('tr.sel-bar [data-act="comment-selection"]')).not.toBeNull()
  })

  it('holds back the toolbar while the pointer is still down', () => {
    markSelection(document.body, { ...single(2, true), end: 4 })
    expect(document.querySelectorAll('tr.is-selected').length).toBe(3)
    expect(document.querySelector('tr.sel-bar')).toBeNull()
  })

  it('leaves one set of marks when it runs again, and none for an empty selection', () => {
    markSelection(document.body, single(2))
    markSelection(document.body, single(4))
    expect([...document.querySelectorAll('tr.is-selected')].map(r => r.id)).toEqual(['L-src_app_ts-new-4'])
    expect(document.querySelectorAll('tr.sel-bar').length).toBe(1)
    expect(markSelection(document.body, null)).toBeNull()
    expect(document.querySelectorAll('tr.is-selected').length).toBe(0)
    expect(document.querySelectorAll('tr.sel-bar').length).toBe(0)
  })

  it('answers null when no row of the range is on the page', () => {
    expect(markSelection(document.body, single(900))).toBeNull()
  })

  it('escapes the label it shows', () => {
    const html = selectionToolbarHtml({ ...single(1), path: '<script>x</script>.ts' })
    expect(html).not.toContain('<script>')
  })
})

describe('lineRefFromEvent', () => {
  const entry = SYNTHETIC_FILES.find(f => f.path === PATH)
  const pathForKey = (/** @type {string} */ key) => (key === KEY ? PATH : undefined)

  beforeEach(() => {
    const patch = toPatchMap(SYNTHETIC_FILES)[KEY] ?? ''
    document.body.innerHTML = renderDiff({ key: KEY, path: PATH, lang: entry?.lang }, patch)
  })

  /** @param {Element | null} el */
  function eventOn(el) {
    return { target: el }
  }

  it('reads the new-side line from an added or context row', () => {
    const cell = document.querySelector('#L-src_app_ts-new-4 td.ln:nth-child(2)')
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(cell)), pathForKey)).toEqual({
      key: KEY,
      path: PATH,
      side: 'new',
      line: 4,
    })
  })

  it('reads the old-side line from a deleted row', () => {
    const cell = document.querySelector('tr.del td.ln')
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(cell)), pathForKey)?.side).toBe('old')
  })

  it('ignores a row whose line cells are empty', () => {
    document.body.innerHTML =
      '<table class="diff" data-key="src_app_ts"><tbody><tr class="add"><td class="ln"></td><td class="ln"></td></tr></tbody></table>'
    const cell = document.querySelector('td.ln')
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(cell)), pathForKey)).toBeNull()
  })

  it('ignores hunk headers, fold rows, cells outside a diff, and unknown files', () => {
    expect(
      lineRefFromEvent(/** @type {Event} */ (eventOn(document.querySelector('tr.hunk td.ln'))), pathForKey)
    ).toBeNull()
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(document.querySelector('td.code'))), pathForKey)).toBeNull()
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(null)), pathForKey)).toBeNull()
    const cell = document.querySelector('#L-src_app_ts-new-4 td.ln:nth-child(2)')
    expect(lineRefFromEvent(/** @type {Event} */ (eventOn(cell)), () => undefined)).toBeNull()
  })
})
