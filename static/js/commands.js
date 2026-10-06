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

/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const toastTimers = new WeakMap()

/**
 * The one place the page says what just happened. Screen readers get it through `aria-live`.
 * The region is a direct child of `root`, so a page toast never lands in the region of a dialog
 * inside the page.
 * @param {HTMLElement} root
 * @param {string} message
 * @param {{ failed?: boolean }} [opts] `failed` draws it as a failure
 */
export function toast(root, message, opts = {}) {
  let box = root.querySelector(':scope > .toast')
  if (!(box instanceof HTMLElement)) {
    box = document.createElement('div')
    box.className = 'toast'
    box.setAttribute('role', 'status')
    box.setAttribute('aria-live', 'polite')
    root.appendChild(box)
  }
  clearTimeout(toastTimers.get(box))
  box.textContent = message
  box.classList.toggle('failed', opts.failed === true)
  const region = box
  toastTimers.set(
    region,
    setTimeout(() => {
      region.textContent = ''
      toastTimers.delete(region)
    }, 5000)
  )
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
  // A modal dialog is in the top layer and makes the page behind it inert, so the page's toast
  // would be hidden and unannounced there. The dialog gets its own.
  const where = el.closest('dialog:modal')
  toast(where instanceof HTMLElement ? where : root, copied ? 'copied to clipboard' : 'could not copy', {
    failed: !copied,
  })
}
