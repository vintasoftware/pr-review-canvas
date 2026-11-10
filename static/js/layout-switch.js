// @ts-check
// The reader's switch between the unified and split layouts of the diffs. The choice is saved in
// the settings file; the page draws split only while the diff column is wide enough for two sides.
import {
  chosenDiffLayout,
  drawnDiffLayout,
  layoutForWidth,
  nextDiffLayout,
  SPLIT_MIN_WIDTH,
} from './diff-layouts.js'

/** @typedef {import('./diff-layouts.js').DiffLayout} DiffLayout */

/** What the layout button and the `s` key say while the column is too narrow for split. */
export const TOO_NARROW = `split needs a diff column at least ${SPLIT_MIN_WIDTH}px wide`

const TOGGLE_ID = 'diff-layout-toggle'

/** @param {DiffLayout} drawn */
const toggleLabel = drawn => `layout: ${drawn}`

/**
 * The header's layout button, beside skin and theme: it names the layout on screen and switches to
 * the other. `initLayoutSwitch` paints it once the page knows how wide the diff column is.
 */
export function diffLayoutToggleHtml() {
  const drawn = drawnDiffLayout()
  return `<button class="cmd" type="button" id="${TOGGLE_ID}" data-act="diff-layout" data-layout="${drawn}">${toggleLabel(drawn)}</button>`
}

/**
 * @param {ParentNode} root
 * @param {boolean} fits
 */
function paintToggle(root, fits) {
  const button = root.querySelector(`#${TOGGLE_ID}`)
  if (!(button instanceof HTMLButtonElement)) {
    return
  }
  const drawn = drawnDiffLayout()
  button.textContent = toggleLabel(drawn)
  button.setAttribute('data-layout', drawn)
  button.disabled = !fits
  button.title = fits
    ? `Diff layout: ${drawn}. Switch to ${nextDiffLayout(drawn)} (s); the choice is saved`
    : `Diff layout: ${drawn}; ${TOO_NARROW}`
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
