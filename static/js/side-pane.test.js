// @ts-check
// @vitest-environment happy-dom
import { renderChatShell } from './chat.js'
import {
  openReviewTab,
  reviewPaneHtml,
  selectSideTab,
  sideTabsHtml,
  wireReviewPane,
  wireSideTabs,
} from './side-pane.js'

/** A wide screen, where the pane docks beside the canvas. */
function wide() {
  const query = Object.assign(new EventTarget(), { matches: false })
  vi.spyOn(window, 'matchMedia').mockImplementation(() => /** @type {MediaQueryList} */ (query))
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

/** @param {string} html */
function mount(html) {
  document.body.innerHTML = `<div id="root"><div class="layout no-chat">${html}</div></div>`
  const root = /** @type {HTMLElement} */ (document.querySelector('#root'))
  const pane = /** @type {HTMLElement} */ (root.querySelector('aside'))
  return { root, pane }
}

describe('the side pane tabs', () => {
  it('starts on AI Chat when the chat is on, and on the review alone when it is off', () => {
    document.body.innerHTML = sideTabsHtml({ chat: true })
    expect([...document.querySelectorAll('[role="tab"]')].map(t => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
    ])
    expect(document.querySelector('#chat-minimize')?.getAttribute('aria-label')).toBe('Minimize AI Chat')
    document.body.innerHTML = sideTabsHtml({ chat: false })
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1)
    expect(document.querySelector('#side-tab-review')?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('#chat-minimize')?.getAttribute('aria-label')).toBe('Minimize your review')
  })

  it('switches tabs by click and by arrow keys, keeping the chat mounted', () => {
    const { pane } = mount(renderChatShell({ enabled: true }))
    const stop = wireSideTabs(pane)
    const chatTab = /** @type {HTMLElement} */ (pane.querySelector('#side-tab-chat'))
    const reviewTab = /** @type {HTMLElement} */ (pane.querySelector('#side-tab-review'))
    const panel = /** @type {HTMLElement} */ (pane.querySelector('#review-panel'))
    expect(panel.hidden).toBe(true)
    reviewTab.click()
    expect(pane.getAttribute('data-tab')).toBe('review')
    expect(panel.hidden).toBe(false)
    expect(chatTab.getAttribute('tabindex')).toBe('-1')
    expect(reviewTab.hasAttribute('tabindex')).toBe(false)
    expect(pane.querySelector('#msg')).not.toBeNull()

    reviewTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(pane.getAttribute('data-tab')).toBe('chat')
    expect(document.activeElement).toBe(chatTab)
    chatTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(pane.getAttribute('data-tab')).toBe('review')
    // Other keys and clicks away from the tabs change nothing.
    reviewTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    pane
      .querySelector('#chat-log')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    pane.querySelector('#chat-log')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(pane.getAttribute('data-tab')).toBe('review')

    stop()
    chatTab.click()
    expect(pane.getAttribute('data-tab')).toBe('review')
  })

  it('opens a minimized pane on the review tab and focuses the tab', () => {
    const { pane } = mount(renderChatShell({ enabled: true }))
    selectSideTab(pane, 'chat')
    const open = vi.fn()
    openReviewTab(pane, { open })
    expect(open).toHaveBeenCalledOnce()
    expect(pane.getAttribute('data-tab')).toBe('review')
    expect(document.activeElement?.id).toBe('side-tab-review')
  })
})

describe('the review pane without AI Chat', () => {
  it('is not wired on a page without it', () => {
    const { root } = mount(renderChatShell({ enabled: true }))
    expect(wireReviewPane(root)).toBeNull()
  })

  it('starts minimized and opens on demand', () => {
    wide()
    const { root, pane } = mount(reviewPaneHtml())
    const handle = wireReviewPane(root)
    if (handle === null) throw new Error('no pane')
    expect(pane.hidden).toBe(true)
    expect(root.querySelector('.layout')?.classList.contains('no-chat')).toBe(true)
    handle.openReview()
    expect(pane.hidden).toBe(false)
    expect(root.querySelector('.layout')?.classList.contains('no-chat')).toBe(false)
    expect(document.activeElement?.id).toBe('side-tab-review')
    handle.stop()
  })
})
