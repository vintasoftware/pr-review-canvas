// @ts-check
// The reader's control over how much code the canvas hides: the copy that says what each level
// takes off the screen, the control under the header, and the counters that say how much of the
// diff that is. The level itself is page state that layers.js holds, because changing it redraws
// the file cards.
import { esc } from './dom.js'
import { FOLD_LEVELS, hiddenLines } from './fold-levels.js'

/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').FoldLevel} FoldLevel */
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {{ total: number, hidden: number }} HiddenCounts */

export const FOLD_LEVEL_SELECT_ID = 'fold-level'

/** What each level adds to the one below it, said in the reader's terms. */
const FOLD_LEVEL_WHAT = {
  light: 'the diff as always: imports, whitespace, moved blocks, and generated files',
  moderate: 'also test bodies, helpers, wiring, templates, and boilerplate',
  aggressive: 'only the code you have to judge stays open',
}

/**
 * How many diff lines a level hides in one layer, against what the layer shows in all. Counted
 * from the model, so a card that has not drawn its diff yet still counts.
 * @param {Layer} layer
 * @param {ReadonlyArray<FileEntry>} files
 * @param {FoldLevel} level
 * @returns {HiddenCounts}
 */
export function layerHiddenLines(layer, files, level) {
  let total = 0
  let hidden = 0
  for (const lf of layer.files) {
    const counts = hiddenLines(lf, files.find(f => f.path === lf.path)?.hunks ?? [], level)
    total += counts.total
    hidden += counts.hidden
  }
  return { total, hidden }
}

/**
 * The same over every layer, for the hint under the control and the sign-off note.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<FileEntry>} files
 * @param {FoldLevel} level
 * @returns {HiddenCounts}
 */
export function canvasHiddenLines(artifact, files, level) {
  return artifact.layers.reduce(
    (sum, layer) => {
      const counts = layerHiddenLines(layer, files, level)
      return { total: sum.total + counts.total, hidden: sum.hidden + counts.hidden }
    },
    { total: 0, hidden: 0 }
  )
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
 * @param {ReviewArtifact} artifact
 * @param {FoldLevel} level
 * @returns {string}
 */
export function foldLevelHint(artifact, level) {
  const counts = canvasHiddenLines(artifact, artifact.files, level)
  const amount = counts.hidden === 0 ? 'nothing hidden yet' : `${hiddenLabel(counts)} of the diff`
  return `${FOLD_LEVEL_WHAT[level]} · ${amount}`
}

/**
 * How much of the diff the page hides. One control for the whole canvas, next to the review
 * progress rather than among the commands, because it changes what the reader sees and does not
 * act on the pull request. The page opens at light every time; the choice is not saved.
 * @param {ReviewArtifact} artifact
 * @param {FoldLevel} level
 * @returns {string}
 */
export function foldLevelControlHtml(artifact, level) {
  const options = FOLD_LEVELS.map(
    l => `<option value="${esc(l)}"${l === level ? ' selected' : ''}>${esc(l)}</option>`
  ).join('')
  return (
    `<div class="reading"><label for="${FOLD_LEVEL_SELECT_ID}">Hide code</label>` +
    `<select id="${FOLD_LEVEL_SELECT_ID}" title="How much of the diff the page hides. Press f to step through the levels.">${options}</select>` +
    `<span class="fold-hint" role="status">${esc(foldLevelHint(artifact, level))}</span></div>`
  )
}

/**
 * Points the control and its hint at a level the reader chose elsewhere, such as with the `f` key.
 * @param {ParentNode} root
 * @param {ReviewArtifact} artifact
 * @param {FoldLevel} level
 */
export function refreshFoldLevel(root, artifact, level) {
  const select = root.querySelector(`#${FOLD_LEVEL_SELECT_ID}`)
  if (select instanceof HTMLSelectElement) {
    select.value = level
  }
  const hint = root.querySelector('.reading .fold-hint')
  if (hint !== null) {
    hint.textContent = foldLevelHint(artifact, level)
  }
}
