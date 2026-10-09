// @ts-check
// @vitest-environment happy-dom
import { wireChatPanel } from './chat-panel.js'

/** @param {boolean} isNarrow @param {boolean} isMobile */
function screen(isNarrow, isMobile) {
  const narrow = new EventTarget()
  const mobile = new EventTarget()
  Object.assign(narrow, { matches: isNarrow })
  Object.assign(mobile, { matches: isMobile })
  vi.spyOn(window, 'matchMedia').mockImplementation(
    query => (/** @type {MediaQueryList} */ (query.includes('1360') ? narrow : mobile))
  )
  return { narrow, mobile }
}

function shell() {
  document.body.innerHTML =
    '<div id="root"><div class="layout"><button id="chat-launcher">open</button><dialog id="chat-dialog"></dialog><aside><button id="chat-minimize">close</button><textarea>keep my draft</textarea><button disabled>disabled</button><a href="#" tabindex="-1">skip</a><a id="canvas-link" href="#line:src/app.ts:3">line 3</a><button id="last">send</button></aside></div></div>'
  const root = /** @type {HTMLElement} */ (document.querySelector('#root'))
  const pane = /** @type {HTMLElement} */ (root.querySelector('aside'))
  const dialog = /** @type {HTMLDialogElement} */ (root.querySelector('dialog'))
  const launcher = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-launcher'))
  const minimize = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-minimize'))
  return { root, pane, dialog, launcher, minimize }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

it('keeps the draft mounted while minimizing a docked pane and reopening it', () => {
  screen(false, false)
  const { root, pane, launcher, minimize } = shell()
  const saved = vi.fn()
  const panel = wireChatPanel(root, pane, { minimized: true, onMinimizedChange: saved })
  expect(pane.hidden).toBe(true)
  launcher.click()
  expect(pane.hidden).toBe(false)
  expect(document.activeElement).toBe(pane.querySelector('textarea'))
  panel.open()
  expect(saved.mock.calls).toEqual([[false]])
  minimize.click()
  expect(root.querySelector('.layout')?.classList.contains('no-chat')).toBe(true)
  expect(document.activeElement).toBe(launcher)
  expect(pane.querySelector('textarea')?.value).toBe('keep my draft')
  expect(saved.mock.calls).toEqual([[false], [true]])
  panel.stop()
  launcher.click()
  expect(pane.hidden).toBe(true)
})

it('moves the same pane between nonmodal tablet, modal phone, and docked layouts', () => {
  const { narrow, mobile } = screen(true, false)
  const { root, pane, dialog, launcher, minimize } = shell()
  const modal = vi.spyOn(dialog, 'showModal')
  const nonmodal = vi.spyOn(dialog, 'show')
  const panel = wireChatPanel(root, pane)
  expect(dialog.open).toBe(false)
  launcher.click()
  expect(nonmodal).toHaveBeenCalledOnce()
  expect(dialog.contains(pane)).toBe(true)
  Object.assign(mobile, { matches: true })
  mobile.dispatchEvent(new Event('change'))
  expect(modal).toHaveBeenCalledOnce()
  const cancel = new Event('cancel', { cancelable: true })
  dialog.dispatchEvent(cancel)
  expect(cancel.defaultPrevented).toBe(true)
  expect(dialog.open).toBe(false)
  launcher.click()
  minimize.click()
  expect(dialog.open).toBe(false)
  Object.assign(narrow, { matches: false })
  narrow.dispatchEvent(new Event('change'))
  expect(dialog.contains(pane)).toBe(false)
  expect(pane.hidden).toBe(false)
  minimize.click()
  panel.open()
  Object.assign(narrow, { matches: true })
  narrow.dispatchEvent(new Event('change'))
  panel.open()
  panel.stop()
  expect(dialog.open).toBe(false)
})

it('traps Tab inside the mobile dialog while skipping disabled, hidden, and negative-tabindex controls', () => {
  const { mobile } = screen(true, true)
  const { root, pane, dialog, launcher, minimize } = shell()
  const panel = wireChatPanel(root, pane)
  launcher.click()
  for (const el of dialog.querySelectorAll('button, textarea, a')) {
    vi.spyOn(el, 'getClientRects').mockReturnValue(/** @type {DOMRectList} */ (/** @type {unknown} */ ([{}])))
  }
  const last = /** @type {HTMLButtonElement} */ (root.querySelector('#last'))
  const key = (/** @type {boolean} */ shiftKey = false, name = 'Tab') => {
    const e = new KeyboardEvent('keydown', { key: name, shiftKey, cancelable: true })
    dialog.dispatchEvent(e)
    return e
  }
  minimize.focus()
  expect(key(true).defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(last)
  expect(key().defaultPrevented).toBe(true)
  expect(document.activeElement).toBe(minimize)
  pane.querySelector('textarea')?.focus()
  expect(key().defaultPrevented).toBe(false)
  expect(key(false, 'ArrowDown').defaultPrevented).toBe(false)
  Object.assign(mobile, { matches: false })
  expect(key().defaultPrevented).toBe(false)
  Object.assign(mobile, { matches: true })
  minimize.click()
  expect(key().defaultPrevented).toBe(false)
  panel.stop()
})

it('steps a floating pane aside for the canvas, from a canvas link in it or when asked', () => {
  const { narrow } = screen(true, false)
  const { root, pane, dialog, launcher } = shell()
  const panel = wireChatPanel(root, pane)
  const link = /** @type {HTMLAnchorElement} */ (root.querySelector('#canvas-link'))
  launcher.click()
  expect(dialog.open).toBe(true)
  // A modified click asks the browser for a new tab, and a plain link is not a canvas link.
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  pane.querySelector('a[href="#"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(dialog.open).toBe(true)
  link.click()
  expect(dialog.open).toBe(false)
  expect(launcher.hidden).toBe(false)
  launcher.click()
  panel.uncover()
  expect(dialog.open).toBe(false)
  // Minimized already, or docked beside the canvas: there is nothing to step aside.
  panel.uncover()
  Object.assign(narrow, { matches: false })
  narrow.dispatchEvent(new Event('change'))
  launcher.click()
  link.click()
  panel.uncover()
  expect(pane.hidden).toBe(false)
  panel.stop()
  launcher.click()
  link.click()
})
