/**
 * Mechanical repairs for folds that break a correctness rule in a way with one right answer.
 *
 * A fold that runs past its chunk, repeats another fold, or covers an attention point is usually a
 * counting slip, and the fix keeps what the writer meant: the part of the range inside the chunk it
 * starts in, the first of two identical folds, the lines around the point. Anything that needs a
 * choice — which of two overlapping folds wins, which half of a split fold to keep — is left to
 * the writer, and so is every rule about how much a canvas must hide.
 */

import type { FileEntry, Hunk, ModelOutput, Side, TextCaps } from '../contract/review-artifact.js'
import { modelOutputSchema } from '../contract/review-artifact.js'
import { hunkForLine } from '../git/patch-lines.js'
import { pinnedRanges, rangesOverlap, type SourceRange } from './validate-folds.js'

/** A fold this pass clipped, shrank, or dropped. `to` is null when the fold is gone. */
export interface FoldFix {
  outcome: 'fixed'
  where: string
  title: string
  from: SourceRange
  to: SourceRange | null
  reason: string
}

type Fold = SourceRange & { title: string }

/** The lines a hunk spans on one side, with the same zero-length anchor rule as `hunkForLine`. */
function hunkSpan(hunk: Hunk, side: Side): { start: number; end: number } {
  const start = side === 'new' ? hunk.newStart : hunk.oldStart
  const count = side === 'new' ? hunk.newLines : hunk.oldLines
  return { start, end: start + Math.max(count, 1) - 1 }
}

function sameRange(a: SourceRange, b: SourceRange): boolean {
  return a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine
}

export function formatRange(range: SourceRange): string {
  return range.startLine === range.endLine
    ? `${range.side} ${range.startLine}`
    : `${range.side} ${range.startLine}-${range.endLine}`
}

/**
 * The fold cut back to the chunk its start line is in, or the reason it cannot be. A fold that
 * starts outside every chunk assigned to this file is dropped rather than moved: the chunk it
 * reaches into may be another layer's, and guessing which one it meant is the writer's call.
 */
function clip(fold: Fold, assigned: readonly string[], hunks: readonly Hunk[]): SourceRange | string {
  const hunk = hunkForLine(hunks, fold.side, fold.startLine)
  if (hunk === null || !assigned.includes(hunk.id)) {
    return 'it starts in no chunk assigned to this file in this layer'
  }
  const { end } = hunkSpan(hunk, fold.side)
  return { side: fold.side, startLine: fold.startLine, endLine: Math.min(fold.endLine, end) }
}

/**
 * What is left of the fold once every pinned range is outside it, when that is one piece. A pin on
 * the other side of the same chunk has no coordinates to cut around, and a pin in the middle
 * leaves two pieces; either way no single fold keeps what the writer meant.
 */
function shrink(fold: SourceRange, pins: readonly SourceRange[]): SourceRange | null {
  if (pins.some(pin => pin.side !== fold.side)) {
    return null
  }
  let piece: SourceRange | null = null
  let line = fold.startLine
  for (const pin of [...pins].sort((a, b) => a.startLine - b.startLine)) {
    if (pin.startLine > line) {
      if (piece !== null) {
        return null
      }
      piece = { side: fold.side, startLine: line, endLine: Math.min(pin.startLine - 1, fold.endLine) }
    }
    line = Math.max(line, pin.endLine + 1)
  }
  if (line <= fold.endLine) {
    if (piece !== null) {
      return null
    }
    piece = { side: fold.side, startLine: line, endLine: fold.endLine }
  }
  return piece
}

/**
 * Repairs the folds of a parsed model in place and reports every change. Only a model that passes
 * the schema is touched, since the rules read its points, tests, and hunk lists; a reversed range
 * and a fold that partly overlaps another are reported by the validator and left alone.
 */
export function applyFoldFixes(output: unknown, files: readonly FileEntry[], caps: TextCaps): FoldFix[] {
  if (!modelOutputSchema(caps).safeParse(output).success) {
    return []
  }
  const model = output as ModelOutput
  const byPath = new Map(files.map(file => [file.path, file.hunks]))
  const fixes: FoldFix[] = []

  model.layers.forEach((layer, i) => {
    layer.files.forEach((file, j) => {
      if (file.folds === undefined) {
        return
      }
      const hunks = byPath.get(file.path) ?? []
      const pinned = pinnedRanges(file, layer, model, hunks)
      const kept: typeof file.folds = []

      file.folds.forEach((fold, k) => {
        const fix = (to: SourceRange | null, reason: string): void => {
          fixes.push({
            outcome: 'fixed',
            where: `layers.${i}.files.${j}.folds.${k}`,
            title: fold.title,
            from: { side: fold.side, startLine: fold.startLine, endLine: fold.endLine },
            to,
            reason,
          })
        }
        if (fold.endLine < fold.startLine) {
          kept.push(fold)
          return
        }

        const clipped = clip(fold, file.hunks, hunks)
        if (typeof clipped === 'string') {
          fix(null, clipped)
          return
        }
        let range = clipped
        let reason = sameRange(range, fold) ? null : 'clipped to the chunk it starts in'

        const pins = pinned.filter(pin => rangesOverlap(range, pin, hunks))
        if (pins.length > 0) {
          const piece = shrink(range, pins)
          const at = pins.map(formatRange).join(', ')
          if (piece === null) {
            fix(null, `no single range around the attention point at ${at} keeps a line`)
            return
          }
          range = piece
          const shrunk = `shrunk to keep the attention point at ${at} visible`
          reason = reason === null ? shrunk : `${reason}, then ${shrunk}`
        }

        const twin = kept.findIndex(earlier => sameRange(earlier, range))
        if (twin !== -1) {
          fix(null, `it repeats the range of "${kept[twin]?.title}"`)
          return
        }

        if (reason !== null) {
          fix(range, reason)
          fold.startLine = range.startLine
          fold.endLine = range.endLine
        }
        kept.push(fold)
      })

      file.folds.splice(0, file.folds.length, ...kept)
    })
  })
  return fixes
}

/** The report line after `fixed <where>: `, the way the writer reads it back. */
export function describeFoldFix(fix: FoldFix): string {
  const name = `fold "${fix.title}"`
  return fix.to === null
    ? `dropped ${name} at ${formatRange(fix.from)}: ${fix.reason}`
    : `${name} ${formatRange(fix.from)} -> ${formatRange(fix.to)}, ${fix.reason}`
}
