import type { CodeFold, FileEntry, Hunk, ModelLayer, ModelOutput } from '../contract/review-artifact.js'
import type { ValidationError } from '../contract/validation.js'
import { hunkForLine } from '../git/patch-lines.js'

type SourceRange = Pick<CodeFold, 'side' | 'startLine' | 'endLine'>
type ModelFile = ModelLayer['files'][number]

function assignedHunk(fold: CodeFold, file: ModelFile, hunks: readonly Hunk[]): Hunk | null {
  if (fold.endLine < fold.startLine) {
    return null
  }

  const start = hunkForLine(hunks, fold.side, fold.startLine)
  const end = hunkForLine(hunks, fold.side, fold.endLine)

  if (start === null || end?.id !== start.id || !file.hunks.includes(start.id)) {
    return null
  }

  return start
}

/** Different coordinate sides in one hunk need the full patch to prove they are separate. */
function rangesOverlap(left: SourceRange, right: SourceRange, hunks: readonly Hunk[]): boolean {
  const leftHunk = hunkForLine(hunks, left.side, left.startLine)
  const rightHunk = hunkForLine(hunks, right.side, right.startLine)

  if (leftHunk === null || leftHunk.id !== rightHunk?.id) {
    return false
  }

  return left.side !== right.side || (left.startLine <= right.endLine && right.startLine <= left.endLine)
}

function protectedRanges(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  hunks: readonly Hunk[]
): SourceRange[] {
  const ranges: SourceRange[] = [...file.annotations]
  const points = output.points.filter(point => point.path === file.path)

  for (const point of points) {
    const side = point.side ?? 'new'
    const hunk = hunkForLine(hunks, side, point.line)

    if (hunk !== null && file.hunks.includes(hunk.id)) {
      ranges.push({ side, startLine: point.line, endLine: point.endLine ?? point.line })
    }
  }

  const needsTestPoint = layer.files[0] === file && layer.tests.some(test => test.status === 'missing')
  const firstHunk = needsTestPoint ? hunks.find(hunk => hunk.id === file.hunks[0]) : undefined

  if (firstHunk !== undefined) {
    const side = firstHunk.newLines === 0 ? 'old' : 'new'
    const line = side === 'new' ? firstHunk.newStart : firstHunk.oldStart
    ranges.push({ side, startLine: line, endLine: line })
  }

  return ranges
}

function validateFileFolds(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  hunks: readonly Hunk[]
): ValidationError[] {
  const errors: ValidationError[] = []
  const where = `layer:${layer.key}/file:${file.path}`
  const protectedCode = protectedRanges(file, layer, output, hunks)
  const folds = file.folds ?? []

  const fail = (message: string): void => {
    errors.push({ code: 'FOLD_INVALID', where, message: `${where}: ${message}` })
  }

  if (file.collapsed && protectedCode.length > 0) {
    fail('a file with annotations or attention points must start expanded')
  }

  for (const [index, fold] of folds.entries()) {
    if (assignedHunk(fold, file, hunks) === null) {
      fail(`fold ${index + 1} must be an ordered range inside one chunk assigned to this file in this layer`)
      continue
    }

    const earlierFolds = folds.slice(0, index)
    if (earlierFolds.some(earlier => rangesOverlap(fold, earlier, hunks))) {
      fail(`fold ${index + 1} overlaps an earlier fold or uses another coordinate side in the same chunk`)
    }

    if (protectedCode.some(range => rangesOverlap(fold, range, hunks))) {
      fail(`fold ${index + 1} would hide an annotation or attention point`)
    }
  }

  return errors
}

/** Checks fold coordinates and keeps attention points and annotations visible. */
export function validateFolds(output: ModelOutput, files: readonly FileEntry[]): ValidationError[] {
  const byPath = new Map(files.map(file => [file.path, file]))

  return output.layers.flatMap(layer =>
    layer.files.flatMap(file => validateFileFolds(file, layer, output, byPath.get(file.path)?.hunks ?? []))
  )
}
