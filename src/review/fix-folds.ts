/**
 * Mechanical repairs for folds that break a correctness rule in a way with one right answer.
 *
 * A fold that runs past its chunk, repeats another fold, or covers an attention point is usually a
 * counting slip, and the fix keeps what the writer meant: the part of the range inside the chunk it
 * starts in, the first of two identical folds, the lines around the point. Anything that needs a
 * choice — which of two overlapping folds wins, which half of a split fold to keep — is left to
 * the writer, and so is every rule about how much a canvas must hide.
 */

import { z } from 'zod'
import type { FileEntry, Hunk } from '../contract/review-artifact.js'
import { SideSchema, TEST_STATUSES } from '../contract/review-artifact.js'
import { hunkForLine, hunkSpan } from '../git/patch-lines.js'
import { pinnedRanges, rangesOverlap, type SourceRange } from './validate-folds.js'

/**
 * A fold this pass clipped, shrank, or dropped. `where` is a path into the file as written back: a
 * kept fold's own path, or the file a dropped fold was in, since it has no index any more. `to` is
 * null when the fold is gone.
 */
export interface FoldFix {
  outcome: 'fixed'
  where: string
  title: string
  from: SourceRange
  to: SourceRange | null
  reason: string
}

type Fold = SourceRange & { title: string }

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

const line = z.number().int().positive()

/**
 * The parts of a model the fold rules read, and nothing else. Text length has no bearing on where
 * a fold sits, so an over-cap title elsewhere never keeps a fold from being fixed in the same run.
 */
const FoldGeometrySchema = z.object({
  layers: z.array(
    z.object({
      tests: z.array(z.object({ status: z.enum(TEST_STATUSES) })),
      files: z.array(
        z.object({
          path: z.string(),
          hunks: z.array(z.string()),
          folds: z
            .array(z.object({ title: z.string(), side: SideSchema, startLine: line, endLine: line }))
            .optional(),
        })
      ),
    })
  ),
  points: z.array(
    z.object({ path: z.string(), side: SideSchema.optional(), line, endLine: line.optional() })
  ),
})

/**
 * Repairs the folds of a parsed model in place and reports every change. Only a model whose layers,
 * files, folds, tests, and points have the shape the rules read is touched; a reversed range and a
 * fold that partly overlaps another are reported by the validator and left alone.
 */
export function applyFoldFixes(output: unknown, files: readonly FileEntry[]): FoldFix[] {
  if (!FoldGeometrySchema.safeParse(output).success) {
    return []
  }
  // Checked above, and edited in place so the fields the schema does not name are written back.
  const model = output as z.infer<typeof FoldGeometrySchema>
  const byPath = new Map(files.map(file => [file.path, file.hunks]))
  const fixes: FoldFix[] = []

  model.layers.forEach((layer, i) => {
    layer.files.forEach((file, j) => {
      if (file.folds === undefined) {
        return
      }
      const hunks = byPath.get(file.path) ?? []
      const pinned = pinnedRanges(file, layer, model.points, hunks)
      const kept: typeof file.folds = []

      for (const fold of file.folds) {
        const from = { side: fold.side, startLine: fold.startLine, endLine: fold.endLine }
        const drop = (reason: string): void => {
          fixes.push({
            outcome: 'fixed',
            where: `layers.${i}.files.${j}`,
            title: fold.title,
            from,
            to: null,
            reason,
          })
        }
        if (fold.endLine < fold.startLine) {
          kept.push(fold)
          continue
        }

        const clipped = clip(fold, file.hunks, hunks)
        if (typeof clipped === 'string') {
          drop(clipped)
          continue
        }
        let range = clipped
        const steps = sameRange(range, fold) ? [] : ['clipped to the chunk it starts in']

        const pins = pinned.filter(pin => rangesOverlap(range, pin, hunks))
        if (pins.length > 0) {
          const piece = shrink(range, pins)
          const at = pins.map(formatRange).join(', ')
          if (piece === null) {
            drop(`no single range around the attention point at ${at} keeps a line`)
            continue
          }
          range = piece
          steps.push(`shrunk to keep the attention point at ${at} visible`)
        }

        const twin = kept.find(earlier => sameRange(earlier, range))
        if (twin !== undefined) {
          const once = steps.length === 0 ? '' : `once ${steps.join(' and ')} (${formatRange(range)}), `
          drop(`${once}it repeats the range of "${twin.title}"`)
          continue
        }

        if (steps.length > 0) {
          const where = `layers.${i}.files.${j}.folds.${kept.length}`
          fixes.push({
            outcome: 'fixed',
            where,
            title: fold.title,
            from,
            to: range,
            reason: steps.join(', then '),
          })
          fold.startLine = range.startLine
          fold.endLine = range.endLine
        }
        kept.push(fold)
      }

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
