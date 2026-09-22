// @ts-check
// The reader's control over how much code the canvas hides: the copy that says what each level
// takes off the screen, the control under the header, and the labels that say how much of the
// diff that is. The level itself, and the counts, belong to layers.js, which owns the file cards
// and the rule for what a card keeps open.
import { esc } from './dom.js'
import { FOLD_LEVELS } from './fold-levels.js'

/** @typedef {import('./contract-types.js').FoldLevel} FoldLevel */
/** @typedef {{ total: number, hidden: number }} HiddenCounts */

export const FOLD_LEVEL_SELECT_ID = 'fold-level'

/** What each level adds to the one below it, said in the reader's terms. */
const FOLD_LEVEL_WHAT = {
  light: 'the diff as always: imports, whitespace, moved blocks, and generated files',
  moderate: 'also test bodies, helpers, wiring, templates, and boilerplate',
  aggressive: 'only the code you have to judge stays open',
}

/**
 * What the counter says, or '' when this level hides nothing.
 * @param {HiddenCounts} counts
 * @returns {string}
 */
export function hiddenLabel(counts) {
  return counts.hidden === 0 ? '' : `${counts.hidden} of ${counts.total} lines hidden`
}

/**
 * The same with the separator the Files heading needs, so an empty counter adds nothing.
 * @param {HiddenCounts} counts
 * @returns {string}
 */
export function foldCountText(counts) {
  const label = hiddenLabel(counts)
  return label === '' ? '' : ` · ${label}`
}

/**
 * The line under the control: what this level hides, and how much of the diff that is. The reader
 * changes one setting, so the page says what it did rather than leaving them to scroll and find out.
 * @param {FoldLevel} level
 * @param {HiddenCounts} counts what the level hides across the canvas
 * @returns {string}
 */
export function foldLevelHint(level, counts) {
  const amount = counts.hidden === 0 ? 'nothing hidden yet' : `${hiddenLabel(counts)} of the diff`
  return `${FOLD_LEVEL_WHAT[level]} · ${amount}`
}

/**
 * The levels as options, with one selected. The control on the page and the default field of the
 * settings dialog are the same list.
 * @param {FoldLevel} level
 * @returns {string}
 */
export function foldLevelOptionsHtml(level) {
  return FOLD_LEVELS.map(
    l => `<option value="${esc(l)}"${l === level ? ' selected' : ''}>${esc(l)}</option>`
  ).join('')
}

/**
 * How much of the diff the page hides. One control for the whole canvas, next to the review
 * progress rather than among the commands, because it changes what the reader sees and does not
 * act on the pull request. The page opens at the level saved in the settings dialog; a change
 * here holds for this page only.
 * @param {FoldLevel} level
 * @param {HiddenCounts} counts what the level hides across the canvas
 * @returns {string}
 */
export function foldLevelControlHtml(level, counts) {
  const options = foldLevelOptionsHtml(level)
  return (
    `<div class="reading"><label for="${FOLD_LEVEL_SELECT_ID}">Hide code</label>` +
    `<select id="${FOLD_LEVEL_SELECT_ID}" title="How much of the diff this page hides. Press f to step through the levels; the settings dialog sets the default.">${options}</select>` +
    `<span class="fold-hint" role="status">${esc(foldLevelHint(level, counts))}</span></div>`
  )
}

/**
 * Points the control and its hint at a level the reader chose elsewhere, such as with the `f` key.
 * @param {ParentNode} root
 * @param {FoldLevel} level
 * @param {HiddenCounts} counts what the level hides across the canvas
 */
export function refreshFoldLevel(root, level, counts) {
  const select = root.querySelector(`#${FOLD_LEVEL_SELECT_ID}`)
  if (select instanceof HTMLSelectElement) {
    select.value = level
  }
  const hint = root.querySelector('.reading .fold-hint')
  if (hint !== null) {
    hint.textContent = foldLevelHint(level, counts)
  }
}
