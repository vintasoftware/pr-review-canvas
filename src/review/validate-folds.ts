import type { CodeFold, FileEntry, Chunk, ModelLayer, ModelOutput } from '../contract/review-artifact.js'
import type { ValidationError } from '../contract/validation.js'
import { chunkForLine } from '../git/patch-lines.js'

type SourceRange = Pick<CodeFold, 'side' | 'startLine' | 'endLine'>
type ModelFile = ModelLayer['files'][number]

function assignedChunk(fold: CodeFold, file: ModelFile, chunks: readonly Chunk[]): Chunk | null {
  if (fold.endLine < fold.startLine) {
    return null
  }

  const start = chunkForLine(chunks, fold.side, fold.startLine)
  const end = chunkForLine(chunks, fold.side, fold.endLine)

  if (start === null || end?.id !== start.id || !file.chunks.includes(start.id)) {
    return null
  }

  return start
}

/** Different coordinate sides in one chunk need the full patch to prove they are separate. */
function rangesOverlap(left: SourceRange, right: SourceRange, chunks: readonly Chunk[]): boolean {
  const leftChunk = chunkForLine(chunks, left.side, left.startLine)
  const rightChunk = chunkForLine(chunks, right.side, right.startLine)

  if (leftChunk === null || leftChunk.id !== rightChunk?.id) {
    return false
  }

  return left.side !== right.side || (left.startLine <= right.endLine && right.startLine <= left.endLine)
}

function protectedRanges(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  chunks: readonly Chunk[]
): SourceRange[] {
  const ranges: SourceRange[] = [...file.annotations]
  const points = output.points.filter(point => point.path === file.path)

  for (const point of points) {
    const side = point.side ?? 'new'
    const chunk = chunkForLine(chunks, side, point.line)

    if (chunk !== null && file.chunks.includes(chunk.id)) {
      ranges.push({ side, startLine: point.line, endLine: point.endLine ?? point.line })
    }
  }

  const needsTestPoint = layer.files[0] === file && layer.tests.some(test => test.status === 'missing')
  const firstChunk = needsTestPoint ? chunks.find(chunk => chunk.id === file.chunks[0]) : undefined

  if (firstChunk !== undefined) {
    const side = firstChunk.newLines === 0 ? 'old' : 'new'
    const line = side === 'new' ? firstChunk.newStart : firstChunk.oldStart
    ranges.push({ side, startLine: line, endLine: line })
  }

  return ranges
}

function validateFileFolds(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  chunks: readonly Chunk[]
): ValidationError[] {
  const errors: ValidationError[] = []
  const where = `layer:${layer.key}/file:${file.path}`
  const protectedCode = protectedRanges(file, layer, output, chunks)
  const folds = file.folds ?? []

  const fail = (message: string): void => {
    errors.push({ code: 'FOLD_INVALID', where, message: `${where}: ${message}` })
  }

  if (file.collapsed && protectedCode.length > 0) {
    fail('a file with annotations or attention points must start expanded')
  }

  for (const [index, fold] of folds.entries()) {
    if (assignedChunk(fold, file, chunks) === null) {
      fail(`fold ${index + 1} must be an ordered range inside one chunk assigned to this file in this layer`)
      continue
    }

    const earlierFolds = folds.slice(0, index)
    if (earlierFolds.some(earlier => rangesOverlap(fold, earlier, chunks))) {
      fail(`fold ${index + 1} overlaps an earlier fold or uses another coordinate side in the same chunk`)
    }

    if (protectedCode.some(range => rangesOverlap(fold, range, chunks))) {
      fail(`fold ${index + 1} would hide an annotation or attention point`)
    }
  }

  return errors
}

/** Checks fold coordinates and keeps attention points and annotations visible. */
export function validateFolds(output: ModelOutput, files: readonly FileEntry[]): ValidationError[] {
  const byPath = new Map(files.map(file => [file.path, file]))

  return output.layers.flatMap(layer =>
    layer.files.flatMap(file => validateFileFolds(file, layer, output, byPath.get(file.path)?.chunks ?? []))
  )
}
