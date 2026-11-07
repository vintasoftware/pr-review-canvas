// @ts-check
// Every command that triggers a request goes through runCommand, so the click always shows a
// pending state and a failure always shows its message next to the command.
import { copyToClipboard, externalLink } from './dom.js'

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

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const toastTimers = new WeakMap()

/**
 * Clears a toast five seconds from now.
 * @param {Element} box
 */
function clearToastLater(box) {
  clearTimeout(toastTimers.get(box))
  toastTimers.set(
    box,
    setTimeout(() => {
      box.textContent = ''
      toastTimers.delete(box)
    }, 5000)
  )
}

/**
 * What a toast says about what happened: `done` for something the reader did that worked, `note`
 * for news or a hint, `failed` for something that did not happen.
 * @typedef {'done' | 'note' | 'failed'} ToastTone
 */

/**
 * The one place the page says what just happened. Screen readers get it through `aria-live`.
 * The region is a direct child of `root`, so a page toast never lands in the region of a dialog
 * inside the page. While a modal dialog in `root` is open, the toast goes in that dialog instead:
 * the dialog is in the top layer and makes the page behind it inert, so the page's toast would be
 * hidden under it and unannounced. The toast stays up while the pointer is on it, and a click on it
 * clears it; a click on its link still follows the link.
 * @param {HTMLElement} root
 * @param {string} message
 * @param {{ tone?: ToastTone, link?: { url: string, text: string } }} [opts] `tone` sets its icon
 *   and color, `done` by default; `link` follows the message, to what just happened on the forge
 */
export function toast(root, message, opts = {}) {
  const modal = [...root.querySelectorAll('dialog:modal')].at(-1)
  const host = modal instanceof HTMLElement ? modal : root
  let box = host.querySelector(':scope > .toast')
  if (!(box instanceof HTMLElement)) {
    const region = document.createElement('div')
    region.className = 'toast'
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.addEventListener('pointerenter', () => clearTimeout(toastTimers.get(region)))
    region.addEventListener('pointerleave', () => clearToastLater(region))
    region.addEventListener('click', () => {
      clearTimeout(toastTimers.get(region))
      region.textContent = ''
    })
    host.appendChild(region)
    box = region
  }
  clearTimeout(toastTimers.get(box))
  box.textContent = message
  if (opts.link !== undefined) {
    box.append(' · ', externalLink(opts.link.url, opts.link.text))
  }
  box.setAttribute('data-tone', opts.tone ?? 'done')
  // Plays the entrance again, so a message that replaces another is seen to change.
  box.classList.remove('enter')
  void box.clientWidth
  box.classList.add('enter')
  // Under the pointer it waits for the pointer to leave.
  if (!box.matches(':hover')) clearToastLater(box)
  return box
}

/** How long a copy command shows how its last click went. */
export const COPY_RESULT_MS = 2000

const COPY_WIRED = new WeakSet()
/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const copyResultTimers = new WeakMap()

/**
 * Shows on the button how a copy went, `copied` or `failed`, in its label and `data-copied` for
 * COPY_RESULT_MS. null puts `copy` back; a click does that first, so runCommand restores `copy`.
 * Every copy button is labelled `copy`, which commands.test.js checks across the renderers.
 * @param {HTMLElement} el
 * @param {'copied' | 'failed' | null} result
 */
function showCopyResult(el, result) {
  clearTimeout(copyResultTimers.get(el))
  copyResultTimers.delete(el)
  if (result === null) {
    if (el.hasAttribute('data-copied')) {
      el.removeAttribute('data-copied')
      el.textContent = 'copy'
    }
    return
  }
  el.setAttribute('data-copied', result)
  el.textContent = result
  copyResultTimers.set(
    el,
    setTimeout(() => showCopyResult(el, null), COPY_RESULT_MS)
  )
}

/**
 * One delegated click handler per root for every `button[data-copy]` under it, present now or
 * rendered later. Calling it again for the same root does nothing, so re-rendering the root's
 * content never stacks handlers (a second handler would run runCommand twice on one click). The
 * button shows how the copy went, and a toast says it: the root's, or the modal dialog's when the
 * button is in one.
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
      void copyFrom(root, el, copy)
    }
  })
  return true
}

/**
 * @param {HTMLElement} root
 * @param {HTMLElement} el
 * @param {(text: string) => Promise<void>} copy
 */
async function copyFrom(root, el, copy) {
  showCopyResult(el, null)
  // On a failure runCommand shows the reason beside the button, so the toast does not repeat it.
  const copied = await runCommand(
    el,
    async () => {
      await copy(el.getAttribute('data-copy') ?? '')
      return true
    },
    { pendingLabel: 'copying…' }
  )
  showCopyResult(el, copied ? 'copied' : 'failed')
  toast(root, copied ? 'copied to clipboard' : 'could not copy', { tone: copied ? 'done' : 'failed' })
}
