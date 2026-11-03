// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  codeRowAtMiddle,
  DEFAULT_HIDDEN_ITEM_CLICK,
  DEFAULT_INLINE_KINDS,
  getInlineHide,
  HIDE_ATTR,
  inlineHideControlHtml,
  inlineHideHint,
  isHiddenItemClick,
  isHiddenRow,
  isInlineKind,
  itemRowSelector,
  keepReadingPosition,
  setInlineHide,
  SHOWN_ATTR,
  showRow,
} from './inline-hide.js'
import { cssEscape } from './anchors.js'

/** @typedef {import('./inline-hide.js').InlineHide} InlineHide */

/** @type {InlineHide} */
const ON = { hideInline: true, hideInlineKinds: DEFAULT_INLINE_KINDS, hiddenItemClick: 'reveal' }
/** @type {InlineHide} */
const OFF = { ...ON, hideInline: false }

const html = document.documentElement
/** A view that never scrolls, so the tests see only the switch. */
const still = /** @type {Window} */ (/** @type {unknown} */ ({ innerHeight: 600, scrollBy: vi.fn() }))

/** A page with the switch's control and a diff of one code row and one row of each inline kind. */
function page() {
  const el = document.createElement('div')
  el.innerHTML =
    inlineHideControlHtml(getInlineHide()) +
    '<table><tbody>' +
    '<tr id="L-a-new-1" class="ann"><td class="ln">1</td></tr>' +
    '<tr class="annot ann" data-decoration="note"><td>note</td></tr>' +
    '<tr class="ifind check" data-point="p1"><td>point</td></tr>' +
    '<tr class="thread" data-thread="7"><td>thread</td></tr>' +
    '<tr class="pending-row" data-pending-id="d1"><td>draft</td></tr>' +
    '<tr class="composer" data-decoration="composer"><td>box</td></tr>' +
    '</tbody></table>'
  document.body.append(el)
  return el
}

/** @param {Element} root @param {string} selector */
function the(root, selector) {
  const el = root.querySelector(selector)
  if (el === null) throw new Error(`no ${selector}`)
  return el
}

afterEach(() => {
  setInlineHide(OFF, document.body, still)
  document.body.innerHTML = ''
})

describe('inline switch values', () => {
  it('hides every kind by default and shows only the item gone to', () => {
    expect(DEFAULT_INLINE_KINDS).toEqual(['points', 'comments', 'pending', 'annotations'])
    expect(DEFAULT_HIDDEN_ITEM_CLICK).toBe('reveal')
    expect(isInlineKind('pending')).toBe(true)
    expect(isInlineKind('tags')).toBe(false)
    expect(isInlineKind(3)).toBe(false)
    expect(isHiddenItemClick('show-all')).toBe(true)
    expect(isHiddenItemClick('open')).toBe(false)
  })
})

describe('setInlineHide', () => {
  it('names the kinds it hides on <html> in a fixed order, and removes the name when off', () => {
    const el = page()
    setInlineHide({ ...ON, hideInlineKinds: ['annotations', 'points'] }, el, still)
    expect(html.getAttribute(HIDE_ATTR)).toBe('points annotations')
    expect(getInlineHide().hideInlineKinds).toEqual(['points', 'annotations'])
    setInlineHide(OFF, el, still)
    expect(html.hasAttribute(HIDE_ATTR)).toBe(false)
  })

  it('hides nothing when on with no kind chosen, and says so', () => {
    const el = page()
    setInlineHide({ ...ON, hideInlineKinds: [] }, el, still)
    expect(html.hasAttribute(HIDE_ATTR)).toBe(false)
    expect(the(el, '#inline-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(the(el, '.inline-hint').textContent).toMatch(/^nothing chosen to hide/)
  })

  it('keeps a copy, so a caller changing its own list later changes nothing', () => {
    /** @type {import('./inline-hide.js').InlineKind[]} */
    const kinds = ['points']
    setInlineHide({ ...ON, hideInlineKinds: kinds }, document.body, still)
    kinds.push('pending')
    expect(getInlineHide().hideInlineKinds).toEqual(['points'])
  })

  it('makes the button and its hint follow, however the switch changed', () => {
    const el = page()
    setInlineHide(ON, el, still)
    expect(the(el, '#inline-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(the(el, '#inline-toggle').textContent).toBe('show inline items')
    expect(the(el, '.inline-hint').textContent).toMatch(/hidden from the diff/)
    setInlineHide(OFF, el, still)
    expect(the(el, '#inline-toggle').textContent).toBe('hide inline items')
    expect(the(el, '.inline-hint').textContent).toBe('')
  })

  it('puts the rows shown one at a time back under the rule when what shows changes', () => {
    const el = page()
    setInlineHide(ON, el, still)
    showRow(the(el, 'tr.ifind'))
    setInlineHide(OFF, el, still)
    setInlineHide(ON, el, still)
    expect(isHiddenRow(the(el, 'tr.ifind'), html)).toBe(true)
  })

  it('keeps the rows shown one at a time when a save changes nothing that shows', () => {
    const el = page()
    setInlineHide(ON, el, still)
    showRow(the(el, 'tr.ifind'))
    setInlineHide({ ...ON, hiddenItemClick: 'show-all' }, el, still)
    expect(isHiddenRow(the(el, 'tr.ifind'), html)).toBe(false)
  })

  it('leaves the resolved points the reader opened alone', () => {
    const el = page()
    const card = document.createElement('li')
    card.className = 'finding is-resolved'
    card.setAttribute('data-revealed', '')
    el.append(card)
    setInlineHide(ON, el, still)
    setInlineHide(OFF, el, still)
    expect(card.hasAttribute('data-revealed')).toBe(true)
  })

  it('keeps every row in the page, so turning it off brings back the same items', () => {
    const el = page()
    const before = the(el, 'tbody').innerHTML
    setInlineHide(ON, el, still)
    setInlineHide(OFF, el, still)
    expect(the(el, 'tbody').innerHTML).toBe(before)
  })
})

describe('isHiddenRow and showRow', () => {
  it('hides the rows of the kinds chosen and never a code row or a composer', () => {
    const el = page()
    setInlineHide({ ...ON, hideInlineKinds: ['points', 'pending'] }, el, still)
    expect(isHiddenRow(the(el, 'tr.ifind'), html)).toBe(true)
    expect(isHiddenRow(the(el, 'tr.pending-row'), html)).toBe(true)
    expect(isHiddenRow(the(el, 'tr.thread'), html)).toBe(false)
    expect(isHiddenRow(the(el, 'tr.annot'), html)).toBe(false)
    expect(isHiddenRow(the(el, 'tr.composer'), html)).toBe(false)
    expect(isHiddenRow(the(el, '#L-a-new-1'), html)).toBe(false)
  })

  it('hides nothing while off', () => {
    const el = page()
    expect(isHiddenRow(the(el, 'tr.ifind'), html)).toBe(false)
  })

  it('shows one hidden row and leaves the others hidden', () => {
    const el = page()
    setInlineHide(ON, el, still)
    showRow(the(el, 'tr.ifind'))
    expect(the(el, 'tr.ifind').hasAttribute(SHOWN_ATTR)).toBe(true)
    expect(isHiddenRow(the(el, 'tr.ifind'), html)).toBe(false)
    expect(isHiddenRow(the(el, 'tr.thread'), html)).toBe(true)
  })
})

describe('itemRowSelector', () => {
  it.each([
    ['points', 'p:1', '<tr class="ifind" data-point="p:1">'],
    ['pending', 'd.1', '<tr class="pending-row" data-pending-id="d.1">'],
  ])('finds the %s row a link goes to, and only that row', (kind, id, row) => {
    const table = document.createElement('table')
    table.innerHTML = `<tbody>${row}</tbody><tbody><tr class="${kind === 'points' ? 'thread' : 'ifind'}" data-point="${id}" data-pending-id="${id}"></tr></tbody>`
    const found = table.querySelectorAll(
      itemRowSelector(/** @type {'points' | 'pending'} */ (kind), cssEscape(id))
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.closest('tbody')).toBe(table.tBodies[0])
  })
})

describe('the hint', () => {
  it('says what is hidden and where each kind can still be found', () => {
    expect(inlineHideHint(OFF)).toBe('')
    expect(inlineHideHint(ON)).toBe(
      'points, comments, drafts and annotations hidden from the diff · points are still in the layer ' +
        'summary and on ]; drafts in the review panel; comments and annotations come back when you show them'
    )
    expect(inlineHideHint({ ...ON, hideInlineKinds: ['comments'] })).toBe(
      'comments hidden from the diff · comments come back when you show them'
    )
    expect(inlineHideHint({ ...ON, hideInlineKinds: ['pending', 'points'] })).toBe(
      'points and drafts hidden from the diff · points are still in the layer summary and on ]; drafts in the review panel'
    )
  })

  it('is a pressed button while on', () => {
    expect(inlineHideControlHtml(ON)).toContain('aria-pressed="true"')
    expect(inlineHideControlHtml(OFF)).toContain('aria-pressed="false"')
  })
})

describe('keepReadingPosition', () => {
  /**
   * @param {Element} el
   * @param {() => number} top
   */
  function placeAt(el, top) {
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() => /** @type {DOMRect} */ ({
      top: top(),
      bottom: top() + 20,
      height: 20,
    }))
  }

  it('finds the code row nearest the middle of the screen, skipping rows above it, not drawn, or below it', () => {
    const holder = document.createElement('div')
    holder.innerHTML =
      '<table><tbody>' +
      ['1', '2', '3', '4', '5'].map(n => `<tr id="L-a-new-${n}"></tr>`).join('') +
      '</tbody></table>'
    const [above, hidden, near, middle, below] = Array.from(holder.querySelectorAll('tr'))
    if (!above || !hidden || !near || !middle || !below) throw new Error('rows')
    placeAt(above, () => -100)
    vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(
      /** @type {DOMRect} */ ({ top: 0, bottom: 0, height: 0 })
    )
    placeAt(near, () => 40)
    placeAt(middle, () => 290)
    placeAt(below, () => 900)
    expect(codeRowAtMiddle(holder, 600)).toBe(middle)
    expect(codeRowAtMiddle(document.createElement('div'), 600)).toBeNull()
  })

  it('scrolls back by as much as the change moved the code row in the middle', () => {
    const holder = document.createElement('div')
    holder.innerHTML = '<table><tbody><tr id="L-a-new-1"></tr></tbody></table>'
    let top = 200
    placeAt(the(holder, 'tr'), () => top)
    const view = /** @type {Window} */ (/** @type {unknown} */ ({ scrollBy: vi.fn(), innerHeight: 600 }))
    keepReadingPosition(holder, () => (top = 80), view)
    expect(view.scrollBy).toHaveBeenCalledWith(0, -120)
  })

  it('does not scroll when nothing moved or no code row is on screen', () => {
    const holder = document.createElement('div')
    holder.innerHTML = '<table><tbody><tr id="L-a-new-1"></tr></tbody></table>'
    placeAt(the(holder, 'tr'), () => 50)
    const view = /** @type {Window} */ (/** @type {unknown} */ ({ scrollBy: vi.fn(), innerHeight: 600 }))
    const change = vi.fn()
    keepReadingPosition(holder, change, view)
    keepReadingPosition(document.createElement('div'), change, view)
    expect(change).toHaveBeenCalledTimes(2)
    expect(view.scrollBy).not.toHaveBeenCalled()
  })
})
