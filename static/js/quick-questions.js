// @ts-check
// The small menu that opens on an `[ ask ]` command: four questions that are worth asking about
// almost anything, plus a way to write your own. Picking one sets the context to that target and
// sends, so the common questions cost one click.

import { QUICK_QUESTIONS } from './chat.js'
import { chatContextFromElement } from './chat-context.js'
import { esc, qs } from './dom.js'

/** A menu that opened on the way to a click would be in the way, so it waits. */
export const HOVER_DELAY_MS = 150
/** The pointer crosses a gap between the command and the menu, so closing waits out the crossing. */
export const CLOSE_DELAY_MS = 200
export const QQ_MENU_ID = 'qq-menu'
export const ASK_SOMETHING_ELSE = 'ask something else…'

/** @returns {string} */
export function quickMenuHtml() {
  const items = [...QUICK_QUESTIONS, ASK_SOMETHING_ELSE]
    .map(
      (q, i) =>
        `<button class="qq-item" type="button" role="menuitem" tabindex="-1" data-qq="${i}">${esc(q)}</button>`
    )
    .join('')
  return `<div class="qq-menu" id="${QQ_MENU_ID}" role="menu" aria-label="Quick questions" hidden>${items}</div>`
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
    menu.hidden = false
    const rect = el.getBoundingClientRect()
    menu.style.left = `${Math.round(rect.left)}px`
    menu.style.top = `${Math.round(rect.bottom + 4)}px`
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
    const question = QUICK_QUESTIONS[index] ?? null
    const context = chatContextFromElement(trigger)
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
    /** Opens the menu on a target without waiting, which is what a tap and the `a` key do. */
    openFor(/** @type {HTMLElement} */ el) {
      clearTimer()
      open(el)
      items()[0]?.focus()
    },
    isOpen: () => !menu.hidden,
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
