// @ts-check
// The list of a review's chat threads that opens under the thread's name: a filter, the threads
// grouped by kind of place, and new thread at the bottom. chat.js draws the entries, since they
// read its threads; this module owns how the list opens, filters, moves, and closes.
import { esc, qs } from './dom.js'

/**
 * @param {{
 *   head: HTMLElement,
 *   pop: HTMLElement,
 *   filter: HTMLInputElement,
 *   index: HTMLElement,
 *   draw: () => void,
 * }} parts `head` opens the list, `pop` holds it, `index` holds its entries, which `draw` redraws
 *   and ends with `refilter`
 */
export function wireThreadList(parts) {
  const { head, pop, filter, index, draw } = parts

  /** The threads the filter leaves, in the order the list draws them. */
  const shownItems = () =>
    /** @type {HTMLElement[]} */ (
      Array.from(index.querySelectorAll('.thread-item')).filter(
        el => el instanceof HTMLElement && el.closest('[hidden]') === null
      )
    )

  /**
   * Hides the threads the filter does not match, by name or by the kind of place their group
   * names, and a group left empty. A filter that leaves nothing says so.
   */
  const refilter = () => {
    const query = filter.value.trim().toLowerCase()
    for (const list of Array.from(index.querySelectorAll('.thread-list'))) {
      const group = (list.previousElementSibling?.textContent ?? '').toLowerCase()
      for (const li of Array.from(list.children)) {
        const name = (li.querySelector('.thread-item-t')?.textContent ?? '').toLowerCase()
        li.toggleAttribute('hidden', query !== '' && !name.includes(query) && !group.includes(query))
      }
      const empty = !Array.from(list.children).some(li => !li.hasAttribute('hidden'))
      list.toggleAttribute('hidden', empty)
      list.previousElementSibling?.toggleAttribute('hidden', empty)
    }
    index.querySelector('.thread-nomatch')?.remove()
    const anyThread = index.querySelector('.thread-item') !== null
    if (query !== '' && anyThread && shownItems().length === 0) {
      index.insertAdjacentHTML(
        'beforeend',
        `<p class="empty thread-nomatch">No thread matches “${esc(filter.value.trim())}”.</p>`
      )
    }
  }

  /** Opens the list under the head, with the filter empty and in focus, at the open thread. */
  const open = () => {
    filter.value = ''
    draw()
    pop.hidden = false
    head.setAttribute('aria-expanded', 'true')
    const current = qs('.thread-item.current', index)
    if (current instanceof HTMLElement && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest' })
    }
    filter.focus()
  }

  /** @param {{ back?: boolean }} [opts] `back` returns the focus to the head */
  const close = (opts = {}) => {
    if (pop.hidden) {
      return
    }
    pop.hidden = true
    head.setAttribute('aria-expanded', 'false')
    if (opts.back === true) {
      head.focus()
    }
  }

  /**
   * The list's keys: the arrows move between the threads and back up to the filter, Enter in the
   * filter opens the first thread it leaves, and Escape closes the list.
   * @param {KeyboardEvent} event
   */
  const onKey = event => {
    if (event.key === 'Escape') {
      // The list closes, not the dialog the pane floats in.
      event.preventDefault()
      event.stopPropagation()
      close({ back: true })
      return
    }
    const items = shownItems()
    if (event.key === 'Enter' && event.target === filter) {
      event.preventDefault()
      items[0]?.click()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return
    }
    event.preventDefault()
    const at = items.indexOf(/** @type {HTMLElement} */ (document.activeElement))
    if (event.key === 'ArrowUp' && at === 0) {
      filter.focus()
      return
    }
    const next = event.key === 'ArrowDown' ? (at + 1) % items.length : at < 0 ? items.length - 1 : at - 1
    items[next]?.focus()
  }

  /** @param {Node | null} target */
  const outside = target => target !== null && !pop.contains(target) && !head.contains(target)

  /**
   * The focus leaving the list, by Tab or otherwise, closes it, as a press outside does.
   * @param {FocusEvent} event
   */
  const onFocusOut = event => {
    if (event.relatedTarget instanceof Node && outside(event.relatedTarget)) {
      close()
    }
  }

  /** @param {Event} event */
  const onPress = event => {
    if (!pop.hidden && outside(event.target instanceof Node ? event.target : null)) {
      close()
    }
  }

  pop.addEventListener('keydown', onKey)
  pop.addEventListener('focusout', onFocusOut)
  filter.addEventListener('input', refilter)
  document.addEventListener('pointerdown', onPress)

  return {
    /** Opens the list, or closes it when it is open. */
    toggle() {
      if (pop.hidden) {
        open()
      } else {
        close()
      }
    },
    close,
    refilter,
    stop() {
      pop.removeEventListener('keydown', onKey)
      pop.removeEventListener('focusout', onFocusOut)
      filter.removeEventListener('input', refilter)
      document.removeEventListener('pointerdown', onPress)
    },
  }
}
