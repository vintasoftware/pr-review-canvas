// Attention points carried line by line. A file the new commits changed may still hold a point's
// own lines exactly as they were, only further up or down: an edit above them shifts their numbers
// and nothing else. This module proves that from the two versions of the file and the two diffs,
// and names the lines the point sits on in the head, so the generator moves it instead of judging
// the same code twice. The proof is exact: the same text, the same diff row on every line, and one
// unbroken block in a shortest edit script between the two versions. No language is parsed.
import { diffArrays } from 'diff'
import type { BasisPointLines, FileDelta } from '../contract/generation-context.js'
import type { Point, Side } from '../contract/review-artifact.js'
import { hunkForLine, splitHunks } from '../git/patch-lines.js'
import type { Derived, DerivedStore } from '../store/derived-store.js'

/** One side of one file: its text, and the patch whose rows say how the diff shows each line. */
export interface SideText {
  lines: readonly string[]
  patch: string
}

/**
 * Past this many inserted and deleted lines between the two versions of a file, the edit script is
 * not computed and the file's points are re-judged. A file rewritten this much has little left to
 * carry, and the script's cost grows with the edit count.
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
 * The lines of the basis diff that the head keeps as they were, mapped to their line in the head:
 * the edit script from the basis version to the head version leaves the line in place, and the
 * head diff shows it with the same row the basis diff did. Null past `MAX_LINE_EDITS`.
 */
export function stableLines(basis: SideText, head: SideText, side: Side): Map<number, number> | null {
  const changes = diffArrays([...basis.lines], [...head.lines], { maxEditLength: MAX_LINE_EDITS })
  if (changes === undefined) {
    return null
  }
  const basisRows = rowsOnSide(basis.patch, side)
  const headRows = rowsOnSide(head.patch, side)
  const stable = new Map<number, number>()
  let from = 1
  let to = 1
  for (const change of changes) {
    if (!change.added && !change.removed) {
      for (let i = 0; i < change.count; i += 1) {
        const row = basisRows.get(from + i)
        if (row !== undefined && headRows.get(to + i) === row) {
          stable.set(from + i, to + i)
        }
      }
    }
    from += change.added ? 0 : change.count
    to += change.removed ? 0 : change.count
  }
  return stable
}

/**
 * Where the point's lines sit in the head, when every one of them is stable, they stay one block,
 * and the block is inside one hunk of the head diff. Null means the code under the point changed,
 * and the point is re-judged.
 */
export function pointLinesInHead(
  point: Pick<Point, 'line' | 'endLine'>,
  side: Side,
  stable: ReadonlyMap<number, number>,
  headPatch: string
): BasisPointLines | null {
  const end = point.endLine ?? point.line
  const to = stable.get(point.line)
  if (to === undefined) {
    return null
  }
  for (let line = point.line; line <= end; line += 1) {
    if (stable.get(line) !== to + (line - point.line)) {
      return null
    }
  }
  const hunks = splitHunks(headPatch)
  const toEnd = to + (end - point.line)
  const first = hunkForLine(hunks, side, to)
  if (first === null || hunkForLine(hunks, side, toEnd) !== first) {
    return null
  }
  return { side, line: to, endLine: toEnd }
}

export interface DiffOf {
  sha: string
  derived: Derived
}

/** One side of one file of a commit's diff, as the derived store materialized it. */
export async function sideText(
  store: Pick<DerivedStore, 'readLines'>,
  diff: DiffOf,
  path: string,
  side: Side
): Promise<SideText | null> {
  const file = diff.derived.files.find(f => f.path === path)
  const patch = file === undefined ? undefined : diff.derived.patches[file.key]
  if (file === undefined || patch === undefined) {
    return null
  }
  const lines =
    side === 'new'
      ? await store.readLines(diff.sha, 'head', file.path, 1, Number.MAX_SAFE_INTEGER)
      : await store.readLines(diff.sha, 'base', file.oldPath ?? file.path, 1, Number.MAX_SAFE_INTEGER)
  return lines === null ? null : { lines, patch }
}

/**
 * The points of changed files whose own lines the head keeps, with where they now sit. Each file
 * side is compared once, whatever the number of points on it. A point in an untouched file is
 * carried by the file rule and is not looked at here; a file this machine did not materialize
 * (binary, too large, or an imported canvas without its files) carries nothing.
 */
export async function carriedPointLines(
  store: Pick<DerivedStore, 'readLines'>,
  points: readonly Point[],
  delta: FileDelta,
  basis: DiffOf,
  head: DiffOf
): Promise<Map<Point, BasisPointLines>> {
  const changed = new Set(delta.changed)
  const groups = new Map<string, { path: string; side: Side; points: Point[] }>()
  for (const point of points.filter(p => changed.has(p.path))) {
    const side = point.side ?? 'new'
    const key = `${side}:${point.path}`
    const group = groups.get(key) ?? { path: point.path, side, points: [] }
    group.points.push(point)
    groups.set(key, group)
  }

  const carried = new Map<Point, BasisPointLines>()
  for (const { path, side, points: onSide } of groups.values()) {
    const [before, after] = await Promise.all([
      sideText(store, basis, path, side),
      sideText(store, head, path, side),
    ])
    const stable = before === null || after === null ? null : stableLines(before, after, side)
    if (stable === null || after === null) {
      continue
    }
    for (const point of onSide) {
      const lines = pointLinesInHead(point, side, stable, after.patch)
      if (lines !== null) {
        carried.set(point, lines)
      }
    }
  }
  return carried
}

/**
 * Where one line of `basis` sits in `head`, by the same proof points are carried by: the line is
 * stable between the two versions of its file and lands inside a hunk of the head diff. Null when
 * the code under it changed, or either side of the file is not materialized.
 */
export async function lineInHead(
  store: Pick<DerivedStore, 'readLines'>,
  at: { path: string; side: Side; line: number },
  basis: DiffOf,
  head: DiffOf
): Promise<number | null> {
  const [before, after] = await Promise.all([
    sideText(store, basis, at.path, at.side),
    sideText(store, head, at.path, at.side),
  ])
  const stable = before === null || after === null ? null : stableLines(before, after, at.side)
  if (stable === null || after === null) {
    return null
  }
  return pointLinesInHead({ line: at.line }, at.side, stable, after.patch)?.line ?? null
}
