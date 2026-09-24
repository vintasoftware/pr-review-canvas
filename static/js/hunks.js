// @ts-check
// Hunk header parsing and the hunk-for-line lookup. One implementation for the browser and the
// server (src/git/patch-lines.ts re-exports it), so both sides agree on which hunk owns a line.
/** @typedef {import('./contract-types.js').Side} Side */
/** @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number }} HunkRange */

export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Line numbers and counts of a unified-diff hunk header; a missing count means 1.
 * @param {string} line
 * @returns {HunkRange | null} null when the line is not a hunk header
 */
export function parseHunkHeader(line) {
  const m = HUNK_HEADER_RE.exec(line)
  if (!m) {
    return null
  }
  return {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  }
}

/**
 * The first and last line a hunk spans on `side`. A zero-length range (pure deletion or pure
 * addition) still anchors on its start line.
 * @param {HunkRange} hunk
 * @param {Side} side
 * @returns {{ start: number, end: number }}
 */
export function hunkSpan(hunk, side) {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart
  const count = side === 'new' ? hunk.newLines : hunk.oldLines
  return { start, end: start + Math.max(count, 1) - 1 }
}

/**
 * The hunk that covers `line` on `side`, or null when the line is outside the diff.
 * @template {HunkRange} H
 * @param {ReadonlyArray<H>} hunks
 * @param {Side} side
 * @param {number} line
 * @returns {H | null}
 */
export function hunkForLine(hunks, side, line) {
  for (const h of hunks) {
    const { start, end } = hunkSpan(h, side)
    if (line >= start && line <= end) {
      return h
    }
  }
  return null
}

/**
 * Valid anchor ranges, using the same zero-length anchor rule as hunkForLine.
 * @param {ReadonlyArray<HunkRange>} hunks
 * @param {Side} side
 * @returns {string}
 */
export function hunkLineRanges(hunks, side) {
  const ranges = hunks.map(h => {
    const { start, end } = hunkSpan(h, side)
    return start === end ? `${start}` : `${start}-${end}`
  })
  return `${side}-side lines ${ranges.length ? ranges.join(', ') : 'none'}`
}
