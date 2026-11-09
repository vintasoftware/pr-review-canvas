// @ts-check
// The reader's switch between the unified and split layouts of the diffs. The choice is saved in
// the settings file; the page draws split only while the diff column is wide enough for two sides.
import {
  chosenDiffLayout,
  DIFF_LAYOUTS,
  drawnDiffLayout,
  layoutForWidth,
  SPLIT_MIN_WIDTH,
} from './diff-layouts.js'

/** @typedef {import('./diff-layouts.js').DiffLayout} DiffLayout */

/** What the switch and the `s` key say while the column is too narrow for split. */
export const TOO_NARROW = `split needs a diff column at least ${SPLIT_MIN_WIDTH}px wide`

/**
 * The Unified | Split switch beside Hide code. The pressed button is the layout on screen.
 * @param {DiffLayout} layout
 */
export function diffLayoutControlHtml(layout) {
  const buttons = DIFF_LAYOUTS.map(
    l =>
      `<button type="button" data-act="diff-layout" data-layout="${l}" aria-pressed="${l === layout}">${l}</button>`
  ).join('')
  return `<div class="diff-layout" role="group" aria-label="Diff layout" title="Read the diff in one column or side by side. Press s to switch; the choice is saved.">${buttons}</div>`
}

/**
 * Points the switch at the layout on screen, and disables split while the column is too narrow.
 * @param {ParentNode} root
 * @param {boolean} fits
 */
function paintControl(root, fits) {
  for (const button of root.querySelectorAll('.diff-layout button')) {
    const layout = button.getAttribute('data-layout')
    button.setAttribute('aria-pressed', String(layout === drawnDiffLayout()))
    if (layout === 'split') {
      button.toggleAttribute('disabled', !fits)
      button.setAttribute('title', fits ? '' : TOO_NARROW)
    }
  }
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
    paintControl(root, fits())
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
