// @ts-check
// Every command that triggers a request goes through runCommand, so the click always shows a
// pending state and a failure always shows its message next to the command.
import { copyToClipboard } from './dom.js'

/**
 * @template T
 * @param {HTMLElement} el the .cmd button
 * @param {() => Promise<T>} fn
 * @param {{ pendingLabel?: string }} [opts] label shown while `fn` runs; default is the label plus `…`
 * @returns {Promise<T | undefined>} the result, or undefined after a failure (already shown inline)
 */
export async function runCommand(el, fn, opts = {}) {
  const original = el.textContent ?? ''
  const pending = opts.pendingLabel ?? `${original}…`
  clearCommandError(el)
  if (el instanceof HTMLButtonElement) {
    el.disabled = true
  }
  el.setAttribute('aria-busy', 'true')
  el.textContent = pending
  try {
    return await fn()
  } catch (err) {
    showCommandError(el, err instanceof Error ? err.message : String(err))
    return undefined
  } finally {
    el.textContent = original
    el.removeAttribute('aria-busy')
    if (el instanceof HTMLButtonElement) {
      el.disabled = false
    }
  }
}

/**
 * The same pending and error handling for a control whose label must not change: a checkbox
 * keeps its box, so only `aria-busy` and the disabled state move.
 * @template T
 * @param {HTMLElement} el the element the error is shown next to
 * @param {() => Promise<T>} fn
 * @returns {Promise<T | undefined>}
 */
export async function runControl(el, fn) {
  clearCommandError(el)
  const inputs = el instanceof HTMLInputElement ? [el] : Array.from(el.querySelectorAll('input'))
  /** @param {boolean} disabled */
  const setDisabled = disabled => {
    for (const input of inputs) {
      input.disabled = disabled
    }
  }
  el.setAttribute('aria-busy', 'true')
  setDisabled(true)
  try {
    return await fn()
  } catch (err) {
    showCommandError(el, err instanceof Error ? err.message : String(err))
    return undefined
  } finally {
    el.removeAttribute('aria-busy')
    setDisabled(false)
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} message
 */
export function showCommandError(el, message) {
  clearCommandError(el)
  const err = document.createElement('span')
  err.className = 'cmd-err'
  err.setAttribute('role', 'alert')
  err.textContent = message
  el.insertAdjacentElement('afterend', err)
}

/** @param {HTMLElement} el */
export function clearCommandError(el) {
  const next = el.nextElementSibling
  if (next?.classList.contains('cmd-err')) {
    next.remove()
  }
}

const COPY_WIRED = new WeakSet()

/**
 * One delegated click handler per root for every `button[data-copy]` under it, present now or
 * rendered later. Calling it again for the same root does nothing, so re-rendering the root's
 * content never stacks handlers (a second handler would run runCommand twice on one click).
 * @param {HTMLElement} root
 * @param {(text: string) => Promise<void>} [copy]
 * @returns {boolean} true when the handler was added by this call
 */
export function wireCopyCommands(root, copy = copyToClipboard) {
  if (COPY_WIRED.has(root)) {
    return false
  }
  COPY_WIRED.add(root)
  root.addEventListener('click', event => {
    const el = event.target instanceof Element ? event.target.closest('button[data-copy]') : null
    if (el instanceof HTMLElement) {
      const text = el.getAttribute('data-copy') ?? ''
      void runCommand(el, () => copy(text), { pendingLabel: 'copying…' })
    }
  })
  return true
}
