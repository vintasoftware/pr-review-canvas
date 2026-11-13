// @ts-check
// The values of the `diffLayout` setting, and the layout the page draws its diffs in. The values
// live apart from the renderer because the server validates the settings file against this list.

export const DIFF_LAYOUTS = /** @type {const} */ (['unified', 'split'])
/** @typedef {(typeof DIFF_LAYOUTS)[number]} DiffLayout */

export const DEFAULT_DIFF_LAYOUT = /** @type {DiffLayout} */ ('unified')

/** What the settings dialog calls each layout. */
export const DIFF_LAYOUT_LABELS = /** @type {Readonly<Record<DiffLayout, string>>} */ ({
  unified: 'unified: one column',
  split: 'split: old and new side by side',
})

/** The narrowest diff column, in CSS pixels, that draws split; a narrower one draws unified. */
export const SPLIT_MIN_WIDTH = 900

/**
 * @param {unknown} value
 * @returns {value is DiffLayout}
 */
export function isDiffLayout(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (DIFF_LAYOUTS).includes(value)
}

/**
 * @param {DiffLayout} layout
 * @returns {DiffLayout}
 */
export function nextDiffLayout(layout) {
  return layout === 'split' ? 'unified' : 'split'
}

/** The layout the reader chose, from the settings file until they switch. */
let chosen = /** @type {DiffLayout} */ (DEFAULT_DIFF_LAYOUT)

export function chosenDiffLayout() {
  return chosen
}

/** @param {DiffLayout} layout */
export function setChosenDiffLayout(layout) {
  chosen = layout
}

/** The layout every diff on the page is drawn in: the chosen one, or unified where split does not fit. */
let drawn = /** @type {DiffLayout} */ (DEFAULT_DIFF_LAYOUT)

export function drawnDiffLayout() {
  return drawn
}

/** @param {DiffLayout} layout */
export function setDrawnDiffLayout(layout) {
  drawn = layout
}

/** How many columns a diff table of the drawn layout has. */
export function diffColumns() {
  return drawn === 'split' ? 6 : 4
}

/**
 * The cells of a row whose content spans the code columns, after the line numbers and the comment
 * column: a hunk header, a fold summary, the selection's bar.
 * @param {string} html
 * @param {string} [cls] the spanning cell's classes
 */
export function codeSpanCellsHtml(html, cls = 'code') {
  return drawn === 'split'
    ? `<td class="ln"></td><td class="gut"></td><td class="${cls}" colspan="4">${html}</td>`
    : `<td class="ln" colspan="2"></td><td class="gut"></td><td class="${cls}">${html}</td>`
}
