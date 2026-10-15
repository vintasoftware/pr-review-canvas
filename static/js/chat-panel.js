// @ts-check
import { clickedCanvasLink } from './deep-link.js'

/** Keeps the same chat mounted while switching between the sidebar and floating panel.
 *
 * The chat minimizes at every width. Narrow screens float it over the canvas, so minimizing
 * closes the dialog; wide screens dock it in the layout grid, so minimizing drops the column.
 * Either way the launcher brings back the same pane with its draft and transcript intact.
 *
 * @param {HTMLElement} root
 * @param {HTMLElement} pane
 * @param {{ minimized?: boolean, onMinimizedChange?: (minimized: boolean) => void }} [opts]
 */
export function wireChatPanel(root, pane, opts = {}) {
  const dialog = /** @type {HTMLDialogElement} */ (root.querySelector('#chat-dialog'))
  const launcher = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-launcher'))
  const minimize = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-minimize'))
  const layout = root.querySelector('.layout')
  const narrow = window.matchMedia('(max-width: 1360px)')
  const mobile = window.matchMedia('(max-width: 600px)')
  /** Floating panels start minimized; a docked one starts the way the reader last left it. */
  let floating = false
  let docked = !opts.minimized

  const shown = () => (narrow.matches ? floating : docked)

  function sync() {
    if (dialog.open) dialog.close()
    if (narrow.matches) {
      dialog.append(pane)
      pane.hidden = false
      if (floating) {
        if (mobile.matches) dialog.showModal()
        else dialog.show()
      }
    } else {
      dialog.before(pane)
      pane.hidden = !docked
    }
    layout?.classList.toggle('no-chat', !narrow.matches && !docked)
    launcher.setAttribute('aria-expanded', String(shown()))
    launcher.hidden = shown()
  }

  function open() {
    if (!shown()) {
      if (narrow.matches) floating = true
      else {
        docked = true
        opts.onMinimizedChange?.(false)
      }
      sync()
    }
    // The composer sits low in a tall sticky pane, so plain focus() would scroll the canvas to it.
    pane.querySelector('textarea')?.focus({ preventScroll: true })
  }

  function close() {
    if (narrow.matches) floating = false
    else {
      docked = false
      opts.onMinimizedChange?.(true)
    }
    sync()
    launcher.focus()
  }

  /**
   * Minimizes the pane while it floats over the canvas, so what the reader is sent to on the
   * canvas is not left under it. A docked pane covers nothing.
   */
  function uncover() {
    if (narrow.matches && floating) close()
  }

  /**
   * A canvas link in the pane leads to the canvas, so the pane steps aside before the page scrolls
   * there. The pane is inside the page, so this runs before the page follows the link.
   * @param {MouseEvent} event
   */
  function onLinkClick(event) {
    if (clickedCanvasLink(event) !== null) uncover()
  }

  /** @param {Event} event */
  function cancel(event) {
    event.preventDefault()
    close()
  }

  /** @param {KeyboardEvent} event */
  function trapFocus(event) {
    if (event.key !== 'Tab' || !mobile.matches || !dialog.open) return
    const controls = [
      ...dialog.querySelectorAll('button, select, textarea, input, a[href], [tabindex]'),
    ].filter(
      el =>
        el instanceof HTMLElement &&
        el.tabIndex >= 0 &&
        !el.matches(':disabled') &&
        el.getClientRects().length
    )
    const first = /** @type {HTMLElement | undefined} */ (controls[0])
    const last = /** @type {HTMLElement | undefined} */ (controls.at(-1))
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  launcher.addEventListener('click', open)
  minimize.addEventListener('click', close)
  pane.addEventListener('click', onLinkClick)
  dialog.addEventListener('cancel', cancel)
  dialog.addEventListener('keydown', trapFocus)
  narrow.addEventListener('change', sync)
  mobile.addEventListener('change', sync)
  sync()

  return {
    open,
    uncover,
    stop() {
      if (dialog.open) dialog.close()
      launcher.removeEventListener('click', open)
      minimize.removeEventListener('click', close)
      pane.removeEventListener('click', onLinkClick)
      dialog.removeEventListener('cancel', cancel)
      dialog.removeEventListener('keydown', trapFocus)
      narrow.removeEventListener('change', sync)
      mobile.removeEventListener('change', sync)
    },
  }
}
