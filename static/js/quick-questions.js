// @ts-check
// The small menu that opens on an `[ ask ]` command: questions that are worth asking about almost
// anything of its kind, plus a way to write your own. Picking one sets the context to that target
// and sends, so the common questions cost one click. A file's ask has no menu.

import { chatContextFromElement } from './chat-context.js'
import { esc, qs } from './dom.js'

/** A menu that opened on the way to a click would be in the way, so it waits. */
export const HOVER_DELAY_MS = 150
/** The pointer crosses a gap between the command and the menu, so closing waits out the crossing. */
export const CLOSE_DELAY_MS = 200
export const QQ_MENU_ID = 'qq-menu'
/** The gap between a command and its menu, and the room the menu keeps from the window edge. */
export const MENU_GAP_PX = 4
export const MENU_EDGE_PX = 8
export const ASK_SOMETHING_ELSE = 'ask something else…'

/** The questions the quick menu offers on a point or lines of code. */
export const QUICK_QUESTIONS = [
  'Suggestion to solve this?',
  'Why this way, and what were the alternatives?',
  'What could break?',
  'Does this follow how the codebase already does it?',
  'Is this covered by tests?',
]

/** What the quick menu offers on a layer, which asks about a whole step of the change. */
export const LAYER_QUESTIONS = [
  'Walk me through this layer.',
  'What could this layer break?',
  'Does this follow how the codebase already does it?',
  'Are its tests enough?',
]

/**
 * The quick questions for what a command asks about. A file and the whole PR get none: the
 * questions are about one change, and an ask about either opens its thread at once. Every place
 * that offers the menu asks this, so the rule lives here only.
 * @param {import('./chat-context.js').ChatContext} context
 * @returns {ReadonlyArray<string>}
 */
export function quickQuestionsFor(context) {
  switch (context.kind) {
    case 'layer':
      return LAYER_QUESTIONS
    case 'point':
    case 'lines':
      return QUICK_QUESTIONS
    case 'file':
    case 'pr':
      return []
  }
}

/**
 * @param {ReadonlyArray<string>} questions
 * @returns {string}
 */
function itemsHtml(questions) {
  return [...questions, ASK_SOMETHING_ELSE]
    .map(
      (q, i) =>
        `<button class="qq-item" type="button" role="menuitem" tabindex="-1" data-qq="${i}">${esc(q)}</button>`
    )
    .join('')
}

/** @returns {string} */
export function quickMenuHtml() {
  return `<div class="qq-menu" id="${QQ_MENU_ID}" role="menu" aria-label="Quick questions" hidden>${itemsHtml(QUICK_QUESTIONS)}</div>`
}

/**
 * @typedef {{
 *   onPick: (context: import('./chat-context.js').ChatContext, question: string | null) => void,
 *   delayMs?: number,
 *   doc?: Document,
 * }} QuickQuestionOptions
 */

/**
 * Wires one menu for every `[ ask ]` command under `root` and for the context chip. The menu is
 * a single element that moves to whichever trigger is in play.
 * @param {HTMLElement} root
 * @param {QuickQuestionOptions} options
 */
export function wireQuickQuestions(root, options) {
  const doc = options.doc ?? document
  const delayMs = options.delayMs ?? HOVER_DELAY_MS
  if (qs(`#${QQ_MENU_ID}`, root) === null) {
    root.insertAdjacentHTML('beforeend', quickMenuHtml())
  }
  const menu = qs(`#${QQ_MENU_ID}`, root)
  if (!(menu instanceof HTMLElement)) {
    return { stop: () => undefined }
  }
  /** @type {HTMLElement | null} */
  let trigger = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let closeTimer = null
  /**
   * The command Escape closed the menu on. Focus goes back to it, and that focus must not open
   * the menu again.
   */
  /** @type {HTMLElement | null} */
  let dismissed = null

  const items = () => Array.from(menu.querySelectorAll('.qq-item')).filter(el => el instanceof HTMLElement)

  const close = () => {
    menu.hidden = true
    trigger?.setAttribute('aria-expanded', 'false')
    trigger = null
  }

  /** @param {HTMLElement} el */
  const open = el => {
    dismissed = null
    trigger = el
    el.setAttribute('aria-expanded', 'true')
    menu.innerHTML = itemsHtml(quickQuestionsFor(chatContextFromElement(el)))
    menu.hidden = false
    const rect = el.getBoundingClientRect()
    // The menu is positioned against the window, so a command near an edge would push it off
    // screen: keep it inside, and hang it above a command with no room below.
    const view = doc.defaultView ?? window
    // `clientWidth` leaves out the scrollbar; a document that does not report it falls back.
    const roomAcross = doc.documentElement.clientWidth || view.innerWidth
    const roomDown = doc.documentElement.clientHeight || view.innerHeight
    const below = rect.bottom + MENU_GAP_PX
    const top =
      below + menu.offsetHeight > roomDown - MENU_EDGE_PX ? rect.top - MENU_GAP_PX - menu.offsetHeight : below
    const left = Math.min(rect.left, roomAcross - menu.offsetWidth - MENU_EDGE_PX)
    menu.style.left = `${Math.round(Math.max(MENU_EDGE_PX, left))}px`
    menu.style.top = `${Math.round(Math.max(MENU_EDGE_PX, top))}px`
  }

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  /** @param {EventTarget | null} target */
  const triggerOf = target => {
    const el = target instanceof Element ? target.closest('[data-ask], [data-ask-menu]') : null
    return el instanceof HTMLElement ? el : null
  }

  /** @param {Event} event */
  const onTriggerOver = event => {
    const el = triggerOf(event.target)
    if (el === null) {
      return
    }
    // Being back on a command calls off the countdown its own pointer-out started.
    cancelClose()
    if (el === trigger) {
      return
    }
    clearTimer()
    timer = setTimeout(() => open(el), delayMs)
  }

  /**
   * Leaving starts a short countdown rather than closing at once: the pointer has to cross the
   * few pixels between the command and the menu to reach it.
   * @param {Event} event
   */
  const onOut = event => {
    const to = /** @type {MouseEvent} */ (event).relatedTarget
    if (to instanceof Node && (menu.contains(to) || trigger?.contains(to) === true)) {
      return
    }
    clearTimer()
    if (trigger !== null) {
      closeTimer = setTimeout(close, CLOSE_DELAY_MS)
    }
  }

  const cancelClose = () => {
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  /** Reaching the menu calls the countdown off. */
  const onOver = cancelClose

  /** @param {Event} event */
  const onFocusIn = event => {
    const el = triggerOf(event.target)
    if (el !== null && el === dismissed) {
      dismissed = null
      return
    }
    if (el !== null && el !== trigger) {
      clearTimer()
      open(el)
    }
  }

  /** @param {Event} event */
  const onClick = event => {
    const item = event.target instanceof Element ? event.target.closest('.qq-item') : null
    if (!(item instanceof HTMLElement) || trigger === null) {
      return
    }
    event.preventDefault()
    const index = Number(item.getAttribute('data-qq'))
    const context = chatContextFromElement(trigger)
    const question = quickQuestionsFor(context)[index] ?? null
    close()
    options.onPick(context, question)
  }

  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    if (menu.hidden) {
      return
    }
    const list = items()
    const at = list.indexOf(/** @type {HTMLElement} */ (doc.activeElement))
    if (event.key === 'Escape') {
      event.preventDefault()
      const back = trigger
      close()
      dismissed = back
      back?.focus()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = list[(at + step + list.length) % list.length] ?? list[0]
      next?.focus()
    }
  }

  root.addEventListener('pointerover', onTriggerOver)
  root.addEventListener('pointerout', onOut)
  menu.addEventListener('pointerover', onOver)
  root.addEventListener('focusin', onFocusIn)
  menu.addEventListener('click', onClick)
  doc.addEventListener('keydown', /** @type {EventListener} */ (onKeyDown))

  return {
    stop() {
      clearTimer()
      root.removeEventListener('pointerover', onTriggerOver)
      root.removeEventListener('pointerout', onOut)
      menu.removeEventListener('pointerover', onOver)
      root.removeEventListener('focusin', onFocusIn)
      menu.removeEventListener('click', onClick)
      doc.removeEventListener('keydown', /** @type {EventListener} */ (onKeyDown))
    },
  }
}
