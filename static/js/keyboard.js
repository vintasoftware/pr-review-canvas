// @ts-check
// The key map of the review page. `keyAction` is the whole decision: which key does what, when
// the page is listening at all, and how the two-key `g o` sequence works.
import { esc } from './dom.js'

/**
 * @typedef {'next-layer' | 'prev-layer' | 'next-file' | 'prev-file' | 'next-point' | 'prev-point'
 *   | 'toggle' | 'reviewed-file' | 'reviewed-layer' | 'comment' | 'dismiss' | 'overview'
 *   | 'help' | 'escape' | 'ask' | 'focus-chat'} KeyAction
 */

export const KEY_HELP = [
  { keys: 'j / k', what: 'next / previous layer' },
  { keys: 'n / p', what: 'next / previous file' },
  { keys: '] / [', what: 'next / previous attention point' },
  { keys: 'o', what: 'open or collapse the card in focus' },
  { keys: 'r', what: 'mark the file in focus reviewed' },
  { keys: 'R', what: 'mark the layer in focus reviewed and move on' },
  { keys: 'c', what: 'comment on the line in focus or on the selection' },
  { keys: 'd', what: 'dismiss the attention point in focus' },
  { keys: 'g o', what: 'go to the overview' },
  { keys: '?', what: 'this help' },
  { keys: 'Esc', what: 'clear the selection, close a composer or a dialog' },
  { keys: 'a', what: 'ask AI Chat about the card, point, or selection in focus' },
  { keys: '/', what: 'put the cursor in the AI Chat box' },
]

/**
 * True while the reader is typing, when no key of this map should fire.
 * @param {EventTarget | null} target
 */
export function isTypingTarget(target) {
  if (!(target instanceof Element)) {
    return false
  }
  const tag = target.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.closest('[contenteditable="true"]') !== null
  )
}

/**
 * @param {KeyboardEvent} event
 * @param {{ pendingG?: boolean }} [opts]
 * @returns {{ action: KeyAction | null, pendingG: boolean }}
 */
export function keyAction(event, opts = {}) {
  const none = { action: null, pendingG: false }
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return none
  }
  if (event.key === 'Escape') {
    return { action: 'escape', pendingG: false }
  }
  if (isTypingTarget(event.target)) {
    return none
  }
  if (opts.pendingG === true) {
    return event.key === 'o' ? { action: 'overview', pendingG: false } : none
  }
  switch (event.key) {
    case 'j':
      return { action: 'next-layer', pendingG: false }
    case 'k':
      return { action: 'prev-layer', pendingG: false }
    case 'n':
      return { action: 'next-file', pendingG: false }
    case 'p':
      return { action: 'prev-file', pendingG: false }
    case ']':
      return { action: 'next-point', pendingG: false }
    case '[':
      return { action: 'prev-point', pendingG: false }
    case 'o':
      return { action: 'toggle', pendingG: false }
    case 'r':
      return { action: 'reviewed-file', pendingG: false }
    case 'R':
      return { action: 'reviewed-layer', pendingG: false }
    case 'c':
      return { action: 'comment', pendingG: false }
    case 'd':
      return { action: 'dismiss', pendingG: false }
    case 'g':
      return { action: null, pendingG: true }
    case '?':
      return { action: 'help', pendingG: false }
    case 'a':
      return { action: 'ask', pendingG: false }
    case '/':
      return { action: 'focus-chat', pendingG: false }
    default:
      return none
  }
}

export const HELP_DIALOG_ID = 'help-dialog'

export function helpDialogHtml() {
  const rows = KEY_HELP.map(r => `<tr><td class="mono">${esc(r.keys)}</td><td>${esc(r.what)}</td></tr>`).join(
    ''
  )
  return (
    `<dialog id="${HELP_DIALOG_ID}" class="help" aria-labelledby="help-h"><form method="dialog">` +
    '<h2 id="help-h">Keyboard</h2>' +
    `<table class="keys"><tbody>${rows}</tbody></table>` +
    '<div class="dialog-actions"><button class="cmd" type="submit" value="close">close</button></div>' +
    '</form></dialog>'
  )
}

/**
 * @param {HTMLElement} root
 * @returns {HTMLDialogElement}
 */
export function openHelpDialog(root) {
  let dialog = root.querySelector(`#${HELP_DIALOG_ID}`)
  if (!(dialog instanceof HTMLDialogElement)) {
    const t = document.createElement('template')
    t.innerHTML = helpDialogHtml()
    root.appendChild(t.content)
    dialog = root.querySelector(`#${HELP_DIALOG_ID}`)
  }
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error('help dialog did not render')
  }
  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
  return dialog
}
