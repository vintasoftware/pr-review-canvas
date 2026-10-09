// @ts-check
// The pane on the right of the review: AI Chat and the review being written share it as two tabs.
// With AI Chat off the pane holds the review alone, and stays minimized until the reader opens it.
import { wireChatPanel } from './chat-panel.js'
import { REVIEW_PANEL_ID } from './review-panel.js'

/** @typedef {'chat' | 'review'} SideTab */

/**
 * The tab strip at the top of the pane, which also holds the command that minimizes it.
 * @param {{ chat: boolean }} opts `chat` adds the AI Chat tab; without it the review is alone
 */
export function sideTabsHtml(opts) {
  const tab =
    /** @param {SideTab} name @param {string} label @param {string} controls @param {boolean} selected */ (
      name,
      label,
      controls,
      selected
    ) =>
      `<button class="side-tab" type="button" role="tab" id="side-tab-${name}" data-side-tab="${name}" aria-controls="${controls}" aria-selected="${selected}"${selected ? '' : ' tabindex="-1"'}>${label}</button>`
  return (
    '<div class="side-tabs" role="tablist" aria-label="Side pane">' +
    (opts.chat ? tab('chat', 'AI Chat', 'chat-log', true) : '') +
    tab('review', 'Your review <span class="review-count" data-empty>0</span>', REVIEW_PANEL_ID, !opts.chat) +
    `<button class="cmd chat-minimize" type="button" id="chat-minimize" aria-label="Minimize ${opts.chat ? 'AI Chat' : 'your review'}">minimize</button>` +
    '</div>'
  )
}

/**
 * The pane with the review alone, for a page without AI Chat. It uses the chat's ids for its
 * dialog, launcher, and minimize command, so the same panel wiring docks and floats it.
 */
export function reviewPaneHtml() {
  return (
    '<aside class="chat review-only" aria-label="Your review" data-tab="review" hidden>' +
    sideTabsHtml({ chat: false }) +
    `<section class="review-panel" id="${REVIEW_PANEL_ID}" role="tabpanel" aria-labelledby="side-tab-review"></section>` +
    '</aside>' +
    '<dialog class="chat-dialog" id="chat-dialog" aria-label="Your review"></dialog>' +
    '<button class="chat-launcher review-launcher" id="chat-launcher" type="button" hidden aria-controls="chat-dialog" aria-expanded="false">Your review</button>'
  )
}

/**
 * Shows one tab of the pane and hides the other. The chat's parts stay mounted while the review
 * is shown, so a draft message and the transcript's place survive the switch.
 * @param {HTMLElement} pane
 * @param {SideTab} tab
 */
export function selectSideTab(pane, tab) {
  pane.setAttribute('data-tab', tab)
  for (const button of Array.from(pane.querySelectorAll('[data-side-tab]'))) {
    const selected = button.getAttribute('data-side-tab') === tab
    button.setAttribute('aria-selected', String(selected))
    if (selected) {
      button.removeAttribute('tabindex')
    } else {
      button.setAttribute('tabindex', '-1')
    }
  }
  pane.querySelector(`#${REVIEW_PANEL_ID}`)?.toggleAttribute('hidden', tab !== 'review')
}

/**
 * Clicking a tab shows it; the arrow keys move between the tabs, the way a tab list works.
 * @param {HTMLElement} pane
 * @returns {() => void} the undo
 */
export function wireSideTabs(pane) {
  /** @param {Event} event */
  const tabOf = event => {
    const button = event.target instanceof Element ? event.target.closest('[data-side-tab]') : null
    return button instanceof HTMLElement ? button : null
  }
  /** @param {MouseEvent} event */
  const onClick = event => {
    const button = tabOf(event)
    if (button !== null) {
      selectSideTab(pane, button.getAttribute('data-side-tab') === 'review' ? 'review' : 'chat')
    }
  }
  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    const button = tabOf(event)
    if (button === null || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) {
      return
    }
    const tabs = Array.from(pane.querySelectorAll('[data-side-tab]'))
    const next =
      tabs[(tabs.indexOf(button) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
    if (next instanceof HTMLElement) {
      event.preventDefault()
      selectSideTab(pane, next.getAttribute('data-side-tab') === 'review' ? 'review' : 'chat')
      next.focus()
    }
  }
  pane.addEventListener('click', onClick)
  pane.addEventListener('keydown', onKeyDown)
  return () => {
    pane.removeEventListener('click', onClick)
    pane.removeEventListener('keydown', onKeyDown)
  }
}

/**
 * Shows the review tab, opening the pane when it is minimized, and puts the focus on the tab.
 * @param {HTMLElement} pane
 * @param {{ open: () => void }} panel
 */
export function openReviewTab(pane, panel) {
  selectSideTab(pane, 'review')
  panel.open()
  const tab = pane.querySelector('#side-tab-review')
  if (tab instanceof HTMLElement) {
    tab.focus({ preventScroll: true })
  }
}

/**
 * Wires the pane that holds the review alone, on a page without AI Chat. It always starts
 * minimized: nothing of the canvas's width is taken until the reader asks for the list.
 * @param {HTMLElement} root
 * @returns {{ openReview: () => void, uncover: () => void, stop: () => void } | null} null when the page has no such pane
 */
export function wireReviewPane(root) {
  const pane = root.querySelector('aside.review-only')
  if (!(pane instanceof HTMLElement)) {
    return null
  }
  const panel = wireChatPanel(root, pane, { minimized: true })
  return {
    openReview: () => openReviewTab(pane, panel),
    uncover: () => panel.uncover(),
    stop: () => panel.stop(),
  }
}
