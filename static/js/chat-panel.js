// @ts-check

/** Keeps the same chat mounted while switching between the sidebar and floating panel.
 * @param {HTMLElement} root
 * @param {HTMLElement} pane
 */
export function wireChatPanel(root, pane) {
  const dialog = /** @type {HTMLDialogElement} */ (root.querySelector('#chat-dialog'))
  const launcher = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-launcher'))
  const minimize = /** @type {HTMLButtonElement} */ (root.querySelector('#chat-minimize'))
  const narrow = window.matchMedia('(max-width: 1360px)')
  const mobile = window.matchMedia('(max-width: 600px)')
  let expanded = false

  function sync() {
    if (dialog.open) dialog.close()
    if (narrow.matches) {
      dialog.append(pane)
      if (expanded) {
        if (mobile.matches) dialog.showModal()
        else dialog.show()
      }
    } else {
      dialog.before(pane)
    }
    launcher.setAttribute('aria-expanded', String(narrow.matches && expanded))
    launcher.hidden = narrow.matches && expanded
  }

  function open() {
    if (narrow.matches && !expanded) {
      expanded = true
      sync()
    }
    pane.querySelector('textarea')?.focus()
  }

  function close() {
    expanded = false
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
    const controls = [...dialog.querySelectorAll('button, select, textarea, input, a[href], [tabindex]')]
      .filter(el => el instanceof HTMLElement && el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length)
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
