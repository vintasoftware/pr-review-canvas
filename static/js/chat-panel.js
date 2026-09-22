// @ts-check

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
    pane.querySelector('textarea')?.focus()
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
  dialog.addEventListener('cancel', cancel)
  dialog.addEventListener('keydown', trapFocus)
  narrow.addEventListener('change', sync)
  mobile.addEventListener('change', sync)
  sync()

  return {
    open,
    stop() {
      if (dialog.open) dialog.close()
      launcher.removeEventListener('click', open)
      minimize.removeEventListener('click', close)
      dialog.removeEventListener('cancel', cancel)
      dialog.removeEventListener('keydown', trapFocus)
      narrow.removeEventListener('change', sync)
      mobile.removeEventListener('change', sync)
    },
  }
}
