// Attention points carried line by line. A file the new commits changed may still hold a point's
// own lines exactly as they were, only further up or down: an edit above them shifts their numbers
// and nothing else. This module proves that from the two versions of the file and the two diffs,
// and names the lines the point sits on in the head, so the generator moves it instead of judging
// the same code twice. The proof is exact: the same text, the same diff marker on every line, and
// one unbroken block in the line-by-line match of the two versions. No language is parsed.
import type { BasisPointLines, FileDelta } from '../contract/generation-context.js'
import type { Point, Side } from '../contract/review-artifact.js'
import type { Derived } from '../store/derived-store.js'
import { hunkForLine, splitHunks } from '../git/patch-lines.js'

/** One side of one file: its text, and the patch whose rows say how the diff shows each line. */
export interface SideText {
  lines: readonly string[]
  patch: string
}

/**
 * Past this many inserted and deleted lines between the two versions of a file, the match is not
 * computed and the file's points are re-judged. The match costs the square of this in memory, and
 * a file rewritten this much has little left to carry.
 */
export const MAX_LINE_EDITS = 2000

/** The diff row (marker and text) that shows each line of `side`, keyed by line number. */
function rowsOnSide(patch: string, side: Side): Map<number, string> {
  const rows = new Map<number, string>()
  for (const hunk of splitHunks(patch)) {
    let line = side === 'new' ? hunk.newStart : hunk.oldStart
    for (const row of hunk.lines) {
      const marker = row.charAt(0)
      if (marker === ' ' || marker === (side === 'new' ? '+' : '-')) {
        rows.set(line, row)
        line += 1
      }
    }
  }
  return rows
}

/**
 * The pairs of equal lines in a shortest edit script from `a` to `b` (Myers), as a map from each
 * matched line of `a` to its line in `b`, both 1-based. Null past `MAX_LINE_EDITS`. The common
 * head and tail are matched first, which is where most of a lightly edited file sits.
 */
export function matchLines(a: readonly string[], b: readonly string[]): Map<number, number> | null {
  const matches = new Map<number, number>()
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) {
    matches.set(head + 1, head + 1)
    head += 1
  }
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    matches.set(a.length - tail, b.length - tail)
    tail += 1
  }
  const x0 = a.slice(head, a.length - tail)
  const y0 = b.slice(head, b.length - tail)
  const middle = myers(x0, y0)
  if (middle === null) {
    return null
  }
  for (const [x, y] of middle) {
    matches.set(head + x + 1, head + y + 1)
  }
  return matches
}

/** The 0-based index pairs of equal lines along one shortest edit path, or null past the limit. */
function myers(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  // Before round d, the furthest x on each diagonal k in -d-1..d+1, which is all the walk back reads.
  const trace: Int32Array[] = []
  for (let d = 0; d <= Math.min(max, MAX_LINE_EDITS); d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        return walkBack(trace, n, m)
      }
    }
  }
  return null
}

function walkBack(trace: readonly Int32Array[], n: number, m: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const before = trace[d] as Int32Array
    const at = (k: number): number => before[k + d + 1] ?? 0
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      pairs.push([x, y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    pairs.push([x, y])
  }
  return pairs
}

/**
 * Where the point's lines sit in the head, when they are carried at line level: every line of the
 * point is matched to a line of the head's version of the file, the matches form one block, the
 * head's diff shows each of them with the same row the basis diff did, and the block sits in one
 * hunk. Null means the code under the point changed, and the point is re-judged.
 */
export function pointLinesInHead(
  point: Pick<Point, 'side' | 'line' | 'endLine'>,
  basis: SideText,
  head: SideText
): BasisPointLines | null {
  const side = point.side ?? 'new'
  const end = point.endLine ?? point.line
  const matches = matchLines(basis.lines, head.lines)
  const to = matches?.get(point.line)
  if (matches === null || to === undefined) {
    return null
  }
  const basisRows = rowsOnSide(basis.patch, side)
  const headRows = rowsOnSide(head.patch, side)
  for (let line = point.line; line <= end; line += 1) {
    const row = basisRows.get(line)
    const moved = to + (line - point.line)
    if (row === undefined || matches.get(line) !== moved || headRows.get(moved) !== row) {
      return null
    }
  }
  const hunks = splitHunks(head.patch)
  const toEnd = to + (end - point.line)
  const first = hunkForLine(hunks, side, to)
  if (first === null || hunkForLine(hunks, side, toEnd) !== first) {
    return null
  }
  return { side, line: to, endLine: toEnd }
}

/** Reads one side of one file of a commit's diff, as `DerivedStore.readLines` materialized it. */
export type ReadSide = (sha: string, side: 'head' | 'base', path: string) => Promise<string[] | null>

interface DiffOf {
  sha: string
  derived: Derived
}

async function sideText(diff: DiffOf, path: string, side: Side, read: ReadSide): Promise<SideText | null> {
  const file = diff.derived.files.find(f => f.path === path)
  const patch = file === undefined ? undefined : diff.derived.patches[file.key]
  if (file === undefined || patch === undefined) {
    return null
  }
  const lines =
    side === 'new'
      ? await read(diff.sha, 'head', file.path)
      : await read(diff.sha, 'base', file.oldPath ?? file.path)
  return lines === null ? null : { lines, patch }
}

/**
 * The points of changed files whose own lines the head keeps, with where they now sit. A point in
 * an untouched file is carried by the file rule and is not looked at here; a file this machine did
 * not materialize (binary, too large, or an imported canvas without its files) carries nothing.
 */
export async function carriedPointLines(
  points: readonly Point[],
  delta: FileDelta,
  basis: DiffOf,
  head: DiffOf,
  read: ReadSide
): Promise<Map<Point, BasisPointLines>> {
  const changed = new Set(delta.changed)
  const carried = new Map<Point, BasisPointLines>()
  for (const point of points) {
    if (!changed.has(point.path)) {
      continue
    }
    const side = point.side ?? 'new'
    const [before, after] = await Promise.all([
      sideText(basis, point.path, side, read),
      sideText(head, point.path, side, read),
    ])
    const lines = before === null || after === null ? null : pointLinesInHead(point, before, after)
    if (lines !== null) {
      carried.set(point, lines)
    }
  }
  return carried
}
