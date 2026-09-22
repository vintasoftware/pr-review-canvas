// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askButtonHtml, setChatEnabled } from './ask.js'
import { QUICK_QUESTIONS } from './chat.js'
import {
  ASK_SOMETHING_ELSE,
  CLOSE_DELAY_MS,
  HOVER_DELAY_MS,
  MENU_EDGE_PX,
  QQ_MENU_ID,
  quickMenuHtml,
  wireQuickQuestions,
} from './quick-questions.js'

/** @type {HTMLElement} */
let root
/** @type {Array<[unknown, string | null]>} */
let picked
/** @type {ReturnType<typeof wireQuickQuestions>} */
let menu

beforeEach(() => {
  vi.useFakeTimers()
  setChatEnabled(true)
  picked = []
  root = document.createElement('div')
  root.innerHTML =
    askButtonHtml({ kind: 'file', path: 'src/app.ts' }) +
    askButtonHtml({ kind: 'layer', layerId: 'layer-1' }) +
    '<span id="chip" data-ask-menu data-ask-path="src/app.ts" tabindex="0">src/app.ts</span>'
  document.body.replaceChildren(root)
  menu = wireQuickQuestions(root, { onPick: (context, question) => picked.push([context, question]) })
})

afterEach(() => {
  menu.stop?.()
  vi.useRealTimers()
  setChatEnabled(false)
})

/** @param {string} selector */
function el(selector) {
  const found = root.querySelector(selector)
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no ${selector}`)
  }
  return found
}

const menuEl = () => el(`#${QQ_MENU_ID}`)
const items = () => Array.from(root.querySelectorAll('.qq-item')).filter(e => e instanceof HTMLElement)

describe('quickMenuHtml', () => {
  it('offers the suggested questions and a way to write your own', () => {
    const html = quickMenuHtml()
    for (const q of QUICK_QUESTIONS) {
      expect(html).toContain(q)
    }
    expect(html).toContain(ASK_SOMETHING_ELSE)
    expect(html).toContain('role="menu"')
  })
})

describe('wireQuickQuestions', () => {
  it('waits before opening on hover, so a click on the way past does not open it', () => {
    el('[data-ask-path]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    expect(menuEl().hidden).toBe(true)
    vi.advanceTimersByTime(HOVER_DELAY_MS - 1)
    expect(menuEl().hidden).toBe(true)
    vi.advanceTimersByTime(1)
    expect(menuEl().hidden).toBe(false)
  })

  it('opens at once on focus, which is how the keyboard reaches it', () => {
    el('[data-ask-layer]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(menuEl().hidden).toBe(false)
    expect(el('[data-ask-layer]').getAttribute('aria-expanded')).toBe('true')
  })

  it('sends the question with the context of the command it opened on', () => {
    el('[data-ask-layer]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    items()[0]?.click()
    expect(picked).toEqual([[{ kind: 'layer', layerId: 'layer-1' }, QUICK_QUESTIONS[0]]])
    expect(menuEl().hidden).toBe(true)
  })

  it('opens on the context chip too, and "ask something else" sends no question', () => {
    el('#chip').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    items()
      .find(item => item.textContent === ASK_SOMETHING_ELSE)
      ?.click()
    expect(picked).toEqual([[{ kind: 'file', path: 'src/app.ts' }, null]])
  })

  it('moves between the questions with the arrow keys and closes on Escape', () => {
    const trigger = el('[data-ask-path]')
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(document.activeElement).toBe(items()[0])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(document.activeElement).toBe(items()[1])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    expect(document.activeElement).toBe(items()[0])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    expect(document.activeElement).toBe(items().at(-1))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(menuEl().hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)
  })

  it('ignores the keyboard while it is closed', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(menuEl().hidden).toBe(true)
  })

  it('closes when the pointer leaves for somewhere else, and stays open over itself', () => {
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    const overMenu = new PointerEvent('pointerout', { bubbles: true })
    Object.defineProperty(overMenu, 'relatedTarget', { value: items()[0] })
    el('[data-ask-path]').dispatchEvent(overMenu)
    expect(menuEl().hidden).toBe(false)
    el('[data-ask-path]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    expect(menuEl().hidden).toBe(false)
    vi.advanceTimersByTime(CLOSE_DELAY_MS)
    expect(menuEl().hidden).toBe(true)
  })

  it('stays open when the pointer crosses the gap and reaches the menu', () => {
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    el('[data-ask-path]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    menuEl().dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(CLOSE_DELAY_MS * 2)
    expect(menuEl().hidden).toBe(false)
  })

  it('stays open when the pointer leaves and comes back to the command', () => {
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    el('[data-ask-path]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    el('[data-ask-path]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(CLOSE_DELAY_MS * 2)
    expect(menuEl().hidden).toBe(false)
  })

  it('opens straight away when a tap asks for it', () => {
    menu.openFor?.(el('[data-ask-path]'))
    expect(menuEl().hidden).toBe(false)
    expect(document.activeElement).toBe(items()[0])
  })

  it('does nothing for a click that is not on a question', () => {
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    menuEl().click()
    expect(picked).toEqual([])
  })

  it('takes its listeners off on stop', () => {
    menu.stop()
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(menuEl().hidden).toBe(true)
  })

  it('reuses the menu already on the page rather than adding a second one', () => {
    wireQuickQuestions(root, { onPick: () => undefined }).stop()
    expect(root.querySelectorAll(`#${QQ_MENU_ID}`)).toHaveLength(1)
  })
})

describe('wireQuickQuestions in the odd cases', () => {
  it('ignores a pointer that is over nothing it opens on', () => {
    root.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(HOVER_DELAY_MS)
    expect(menuEl().hidden).toBe(true)
  })

  it('ignores a hover on the command the menu is already open on', () => {
    const trigger = el('[data-ask-path]')
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    vi.advanceTimersByTime(HOVER_DELAY_MS)
    expect(menuEl().hidden).toBe(false)
  })

  it('ignores focus that lands on the command it is already open on', () => {
    const trigger = el('[data-ask-path]')
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(root.querySelectorAll('.qq-menu')).toHaveLength(1)
  })

  it('ignores a pointer leaving while nothing is open', () => {
    root.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    expect(menuEl().hidden).toBe(true)
  })

  it('ignores a key that moves nothing', () => {
    el('[data-ask-path]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    expect(menuEl().hidden).toBe(false)
  })

  it('reports whether it is open', () => {
    expect(menu.isOpen?.()).toBe(false)
    menu.openFor?.(el('[data-ask-path]'))
    expect(menu.isOpen?.()).toBe(true)
  })

  /** happy-dom lays nothing out, so the menu's size is stated. @param {number} w @param {number} h */
  const sizeMenu = (w, h) => {
    Object.defineProperty(menuEl(), 'offsetWidth', { configurable: true, value: w })
    Object.defineProperty(menuEl(), 'offsetHeight', { configurable: true, value: h })
  }

  /** @param {HTMLElement} target @param {Partial<DOMRect>} rect */
  const placeTrigger = (target, rect) => {
    target.getBoundingClientRect = () => /** @type {DOMRect} */ ({
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...rect,
    })
  }

  it('stays inside the window when the command sits near the right edge', () => {
    const trigger = el('[data-ask-path]')
    sizeMenu(260, 200)
    placeTrigger(trigger, { left: 980, top: 20, bottom: 40, right: 1010, width: 30, height: 20 })
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    // 1024 wide, so the menu ends at the far edge less its margin instead of at 980.
    expect(menuEl().style.left).toBe(`${1024 - 260 - MENU_EDGE_PX}px`)
  })

  it('hangs above a command with no room below it', () => {
    const trigger = el('[data-ask-path]')
    sizeMenu(260, 200)
    placeTrigger(trigger, { left: 40, top: 700, bottom: 720, right: 120, width: 80, height: 20 })
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(menuEl().style.top).toBe('496px')
    expect(menuEl().style.left).toBe('40px')
  })

  it('places itself under the command it opened on', () => {
    const trigger = el('[data-ask-path]')
    trigger.getBoundingClientRect = () => /** @type {DOMRect} */ ({
      left: 120,
      bottom: 40,
      top: 20,
      right: 200,
      width: 80,
      height: 20,
      x: 120,
      y: 20,
      toJSON: () => ({}),
    })
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(menuEl().style.left).toBe('120px')
    expect(menuEl().style.top).toBe('44px')
  })
})

describe('wireQuickQuestions without a menu it can use', () => {
  it('does nothing when the element it was given cannot hold the menu', () => {
    const bare = /** @type {HTMLElement} */ (
      /** @type {unknown} */ ({
        querySelector: () => null,
        insertAdjacentHTML: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })
    )
    const wired = wireQuickQuestions(bare, { onPick: () => undefined })
    expect(wired.stop).toBeTypeOf('function')
    wired.stop()
  })
})
