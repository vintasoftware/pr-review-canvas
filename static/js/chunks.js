// @ts-check
// Chunk header parsing and the chunk-for-line lookup. One implementation for the browser and the
// server (src/git/patch-lines.ts re-exports it), so both sides agree on which chunk owns a line.
/** @typedef {import('./contract-types.js').Side} Side */
/** @typedef {{ oldStart: number, oldLines: number, newStart: number, newLines: number }} ChunkRange */

export const CHUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Line numbers and counts of a unified-diff chunk header; a missing count means 1.
 * @param {string} line
 * @returns {ChunkRange | null} null when the line is not a chunk header
 */
export function parseChunkHeader(line) {
  const m = CHUNK_HEADER_RE.exec(line)
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
 * The chunk that covers `line` on `side`, or null when the line is outside the diff.
 * @template {ChunkRange} H
 * @param {ReadonlyArray<H>} chunks
 * @param {Side} side
 * @param {number} line
 * @returns {H | null}
 */
export function chunkForLine(chunks, side, line) {
  for (const h of chunks) {
    const start = side === 'new' ? h.newStart : h.oldStart
    const count = side === 'new' ? h.newLines : h.oldLines
    // A zero-length range (pure deletion or pure addition) still anchors on its start line.
    const end = start + Math.max(count, 1) - 1
    if (line >= start && line <= end) {
      return h
    }
  }
  return null
}

/**
 * Valid anchor ranges, using the same zero-length anchor rule as chunkForLine.
 * @param {ReadonlyArray<ChunkRange>} chunks
 * @param {Side} side
 * @returns {string}
 */
export function chunkLineRanges(chunks, side) {
  const ranges = chunks.map(h => {
    const start = side === 'new' ? h.newStart : h.oldStart
    const count = side === 'new' ? h.newLines : h.oldLines
    const end = start + Math.max(count, 1) - 1
    return start === end ? `${start}` : `${start}-${end}`
  })
  return `${side}-side lines ${ranges.length ? ranges.join(', ') : 'none'}`
}
