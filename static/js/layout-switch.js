// @ts-check
// The reader's switch between the unified and split layouts of the diffs. The choice is saved in
// the settings file; the page draws split only while the diff column is wide enough for two sides.
import { chosenDiffLayout, drawnDiffLayout, layoutForWidth, SPLIT_MIN_WIDTH } from './diff-layouts.js'

/** @typedef {import('./diff-layouts.js').DiffLayout} DiffLayout */

/** What the layout button and the `s` key say while the column is too narrow for split. */
export const TOO_NARROW = `split needs a diff column at least ${SPLIT_MIN_WIDTH}px wide`

export const DIFF_LAYOUT_TOGGLE_ID = 'diff-layout-toggle'

/**
 * The header's layout button, beside skin and theme: it names the layout on screen and switches to
 * the other. `initLayoutSwitch` paints it once the page knows how wide the diff column is.
 */
export function diffLayoutToggleHtml() {
  const drawn = drawnDiffLayout()
  return `<button class="cmd" type="button" id="${DIFF_LAYOUT_TOGGLE_ID}" data-act="diff-layout" data-layout="${drawn}">layout: ${drawn}</button>`
}

/**
 * @param {ParentNode} root
 * @param {boolean} fits
 */
function paintToggle(root, fits) {
  const button = root.querySelector(`#${DIFF_LAYOUT_TOGGLE_ID}`)
  if (!(button instanceof HTMLButtonElement)) {
    return
  }
  const drawn = drawnDiffLayout()
  const other = drawn === 'split' ? 'unified' : 'split'
  button.textContent = `layout: ${drawn}`
  button.setAttribute('data-layout', drawn)
  button.disabled = other === 'split' && !fits
  button.title = button.disabled
    ? `Diff layout: unified; ${TOO_NARROW}`
    : `Diff layout: ${drawn}. Switch to ${other} (s); the choice is saved`
}

/** @param {Element} el */
function contentWidth(el) {
  const style = getComputedStyle(el)
  return el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0)
}

/**
 * Keeps the drawn layout at what the reader chose and the column allows, calling `relayout` with
 * the layout to draw whenever that changes: on a new choice, or when the column crosses the width
 * split needs, as when AI Chat opens.
 * @param {ParentNode} root
 * @param {(layout: DiffLayout) => void} relayout
 */
export function initLayoutSwitch(root, relayout) {
  const main = root.querySelector('main')
  const width = () => (main === null ? 0 : contentWidth(main))
  const fits = () => width() >= SPLIT_MIN_WIDTH
  const apply = () => {
    const next = layoutForWidth(chosenDiffLayout(), width())
    if (next !== drawnDiffLayout()) relayout(next)
    paintToggle(root, fits())
  }
  const observer = main === null || typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
  if (main !== null) observer?.observe(main)
  apply()
  return {
    apply,
    fits,
    stop() {
      observer?.disconnect()
    },
  }
}
