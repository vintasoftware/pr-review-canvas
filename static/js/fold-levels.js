// @ts-check
// How aggressively the canvas hides code. One implementation for the server (re-exported by
// src/contract/review-artifact.ts) and the browser, so the validator and the page agree on what
// a level hides.

/**
 * The levels, from the least hiding to the most. They nest: a fold hides at its own level and at
 * every level above it, so `light` folds are hidden in all three modes. The page opens at the
 * level saved in the settings file, `light` until the reader picks another, and a change from
 * the control holds for the session only.
 */
export const FOLD_LEVELS = /** @type {const} */ (['light', 'moderate', 'aggressive'])

/** @typedef {(typeof FOLD_LEVELS)[number]} FoldLevel */

/** The level a fold or a collapsed file falls back to when the model named none. */
export const DEFAULT_FOLD_LEVEL = 'light'

/**
 * @param {unknown} value
 * @returns {value is FoldLevel}
 */
export function isFoldLevel(value) {
  return FOLD_LEVELS.some(level => level === value)
}

/**
 * Where a level sits in the order, so two levels can be compared.
 * @param {FoldLevel} level
 * @returns {number}
 */
export function foldLevelRank(level) {
  return FOLD_LEVELS.indexOf(level)
}

/**
 * Whether code marked with `level` is hidden while the reader is at `current`.
 * @param {FoldLevel} level
 * @param {FoldLevel} current
 * @returns {boolean}
 */
export function hidesAt(level, current) {
  return foldLevelRank(level) <= foldLevelRank(current)
}

/**
 * The level of a fold or of a file's `collapsed` field. A legacy `collapsed: true` and a fold
 * written before levels existed both read as `light`, so an older canvas hides exactly what it
 * hid before.
 * @param {FoldLevel | boolean | undefined} value
 * @returns {FoldLevel | null} null when the value does not hide anything
 */
export function foldLevelOf(value) {
  if (value === undefined || value === false) {
    return null
  }
  return value === true ? DEFAULT_FOLD_LEVEL : value
}

/**
 * The level after `level`, back to the first after the last, so one key can step through them.
 * @param {FoldLevel} level
 * @returns {FoldLevel}
 */
export function nextFoldLevel(level) {
  return FOLD_LEVELS[(foldLevelRank(level) + 1) % FOLD_LEVELS.length] ?? DEFAULT_FOLD_LEVEL
}

/**
 * @typedef {{ side: 'new' | 'old', startLine: number, endLine: number, level?: FoldLevel | undefined }} Range
 * @typedef {{
 *   collapsed?: FoldLevel | boolean | undefined,
 *   annotations: readonly Range[],
 *   folds?: readonly Range[] | undefined,
 *   hunks: readonly string[],
 * }} FoldedFile
 */

/**
 * Whether `inner` sits wholly inside `outer` without being the same range. The validator allows
 * this only when the inner fold has the lower level; the page then draws the outer one alone.
 * @param {Range} outer
 * @param {Range} inner
 */
export function contains(outer, inner) {
  return (
    outer !== inner &&
    outer.side === inner.side &&
    outer.startLine <= inner.startLine &&
    inner.endLine <= outer.endLine &&
    (outer.startLine < inner.startLine || inner.endLine < outer.endLine)
  )
}

/**
 * The folds that hide at `level`, with every fold nested inside another kept fold dropped. Only
 * the outermost fold is drawn, so raising the level replaces a set of small titles with one.
 * @template {Range} T
 * @param {readonly T[]} folds
 * @param {FoldLevel} level
 * @returns {T[]}
 */
export function foldsForLevel(folds, level) {
  const applicable = folds.filter(fold => hidesAt(fold.level ?? DEFAULT_FOLD_LEVEL, level))
  return applicable.filter(fold => !applicable.some(other => contains(other, fold)))
}

/**
 * Whether a file's whole body starts hidden at this level. An annotated file never collapses: a
 * fold over an annotation still shows the annotation's text, a collapsed file shows only its path.
 * @param {FoldedFile} file
 * @param {FoldLevel} level
 * @returns {boolean}
 */
export function collapsesAt(file, level) {
  const collapseLevel = foldLevelOf(file.collapsed)
  return collapseLevel !== null && hidesAt(collapseLevel, level) && file.annotations.length === 0
}

/**
 * Rows a set of ranges covers, each row counted once where ranges nest or touch. The one count
 * the page's counters and the validator's thresholds share.
 * @param {ReadonlyArray<Pick<Range, 'side' | 'startLine' | 'endLine'>>} ranges
 * @returns {number}
 */
export function coveredRows(ranges) {
  let total = 0
  for (const side of /** @type {const} */ (['new', 'old'])) {
    const sorted = ranges
      .filter(range => range.side === side)
      .map(range => ({ start: range.startLine, end: range.endLine }))
      .sort((a, b) => a.start - b.start)
    /** @type {{ start: number, end: number } | null} */
    let current = null
    for (const range of sorted) {
      if (current !== null && range.start <= current.end + 1) {
        current.end = Math.max(current.end, range.end)
        continue
      }
      total += current === null ? 0 : current.end - current.start + 1
      current = { ...range }
    }
    total += current === null ? 0 : current.end - current.start + 1
  }
  return total
}

/**
 * Rows a file's hunks draw, near enough for a counter: context lines are shared by both sides,
 * so the longer side is the row count when nothing else is known about the patch.
 * @param {FoldedFile} file
 * @param {ReadonlyArray<{ id: string, oldLines: number, newLines: number }>} hunks every hunk of the file
 * @returns {number}
 */
export function fileRows(file, hunks) {
  return hunks
    .filter(hunk => file.hunks.includes(hunk.id))
    .reduce((sum, hunk) => sum + Math.max(hunk.oldLines, hunk.newLines), 0)
}

/**
 * How many diff lines a file shows, and how many of them `level` hides. Measured from the model,
 * so the counter reads the same before and after a card draws its diff.
 * @param {FoldedFile} file
 * @param {ReadonlyArray<{ id: string, oldLines: number, newLines: number }>} hunks every hunk of the file
 * @param {FoldLevel} level
 * @returns {{ total: number, hidden: number }}
 */
export function hiddenLines(file, hunks, level) {
  const total = fileRows(file, hunks)
  if (collapsesAt(file, level)) {
    return { total, hidden: total }
  }
  return { total, hidden: coveredRows(foldsForLevel(file.folds ?? [], level)) }
}
