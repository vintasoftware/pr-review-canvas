import type {
  CodeFold,
  FileEntry,
  FoldLevel,
  Hunk,
  ModelLayer,
  ModelOutput,
} from '../contract/review-artifact.js'
import {
  contains,
  coveredRows,
  DEFAULT_FOLD_LEVEL,
  fileRows,
  foldLevelOf,
  foldLevelRank,
  hiddenLines,
} from '../contract/review-artifact.js'
import type { ValidationError } from '../contract/validation.js'
import { hunkForLine } from '../git/patch-lines.js'
import { DEFAULT_TEST_PATTERNS, isTestPath } from './test-paths.js'

/**
 * Rows a reviewer reads without help. Above this many diff rows outside its annotations, a file
 * with no attention point must hide something at some level: the reading-level control exists to
 * take routine code off the screen, and a routine file left fully open at every level defeats it.
 * An annotation marks the lines to read; it does not make the rows around it any less routine.
 * The same count decides when a layer has enough left open at `moderate` for `aggressive` to owe
 * a difference.
 */
export const ROUTINE_ROWS = 20

/**
 * At or below this many diff rows, a layer reads whole and the levels have little to add, so the
 * layer rule about `aggressive` hiding more than `moderate` does not apply. The file rules still
 * do: a routine file hides something, and a core file folds half, whatever the layer's size.
 */
export const SMALL_LAYER_ROWS = 100

/**
 * The most a `light` fold may cover. Light is the diff as it always looked, plus wholly generated
 * blocks; a wider range is hand-written code dressed as generated, and hiding it by default is
 * what the higher levels are for.
 */
export const LIGHT_FOLD_MAX_ROWS = 40

/**
 * Above this many rows, a file that stays open is a core file the reviewer reads, and by
 * `aggressive` it must fold at least `AGGRESSIVE_MIN_HIDDEN` of the rows outside its attention
 * points. Annotated rows count: an aggressive fold may hide them, and leaving them out would let a
 * generator lower the bar by annotating more. Otherwise aggressive shows the same core as moderate.
 */
export const CORE_FILE_ROWS = 60
export const AGGRESSIVE_MIN_HIDDEN = 0.5

type SourceRange = Pick<CodeFold, 'side' | 'startLine' | 'endLine'>
type LeveledRange = SourceRange & { level: FoldLevel }
type ModelFile = ModelLayer['files'][number]

/** One file's folds as the rules read them: every level filled in, and the ranges a fold may not cover. */
interface FileFolds {
  file: ModelFile
  hunks: readonly Hunk[]
  where: string
  /** Attention points and the marker a missing test adds: no fold ever hides these. */
  pinned: SourceRange[]
  /** Only an aggressive fold may hide these, and the file they are in never collapses. */
  annotations: SourceRange[]
  folds: LeveledRange[]
  collapsed: FoldLevel | null
  /** Diff rows the file draws, the longer side of each of its hunks. */
  rows: number
  /**
   * Rows outside the attention points: what a fold may be asked to hide. Annotated rows are among
   * them, because an aggressive fold may hide them, and leaving them out would let a generator
   * lower the bar by annotating more.
   */
  judged: number
}

function assignedHunk(fold: SourceRange, file: ModelFile, hunks: readonly Hunk[]): Hunk | null {
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

/**
 * How two folds of one file sit together. Levels nest, so a fold may sit inside a fold of a higher
 * level: at the lower level the reader opens the outer one and still finds the inner one folded.
 * Anything else leaves the page unable to say which summary owns a row.
 */
function foldRelation(
  left: LeveledRange,
  right: LeveledRange,
  hunks: readonly Hunk[]
): 'separate' | 'nested' | 'partial' | 'same-range' {
  if (!rangesOverlap(left, right, hunks)) {
    return 'separate'
  }

  if (left.side !== right.side) {
    return 'partial'
  }

  if (left.startLine === right.startLine && left.endLine === right.endLine) {
    return 'same-range'
  }

  if (contains(left, right)) {
    return foldLevelRank(right.level) < foldLevelRank(left.level) ? 'nested' : 'partial'
  }

  if (contains(right, left)) {
    return foldLevelRank(left.level) < foldLevelRank(right.level) ? 'nested' : 'partial'
  }

  return 'partial'
}

/** Ranges no fold may ever hide: attention points, and the marker a missing test adds. */
function pinnedRanges(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  hunks: readonly Hunk[]
): SourceRange[] {
  const ranges: SourceRange[] = []
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

function fileFolds(
  file: ModelFile,
  layer: ModelLayer,
  output: ModelOutput,
  hunks: readonly Hunk[]
): FileFolds {
  const pinned = pinnedRanges(file, layer, output, hunks)
  const rows = fileRows(file, hunks)
  return {
    file,
    hunks,
    where: `layer:${layer.key}/file:${file.path}`,
    pinned,
    annotations: [...file.annotations],
    folds: (file.folds ?? []).map(fold => ({ ...fold, level: fold.level ?? DEFAULT_FOLD_LEVEL })),
    collapsed: foldLevelOf(file.collapsed),
    rows,
    judged: Math.max(rows - coveredRows(pinned), 0),
  }
}

function error(code: ValidationError['code'], where: string, message: string): ValidationError {
  return { code, where, message: `${where}: ${message}` }
}

/**
 * The rules every canvas meets, whenever it was written: fold coordinates fit the assigned hunks,
 * folds nest or stay apart, attention points stay visible at every level, and an annotation is
 * hidden only by an aggressive fold and never by a collapse of its file.
 */
function correctnessErrors({
  file,
  hunks,
  where,
  pinned,
  annotations,
  folds,
  collapsed,
}: FileFolds): ValidationError[] {
  const errors: ValidationError[] = []
  const fail = (message: string): void => {
    errors.push(error('FOLD_INVALID', where, message))
  }

  // A fold that covers an annotation shows the annotation's text as its title; a collapsed file
  // shows nothing but its path. So an annotated file never collapses, at any level, and hides
  // its routine parts with folds instead.
  if (collapsed !== null) {
    if (pinned.length > 0) {
      fail('a file with attention points must start expanded')
    } else if (annotations.length > 0) {
      fail('a file with annotations never collapses; fold the ranges around them instead')
    }
  }

  for (const [index, fold] of folds.entries()) {
    if (assignedHunk(fold, file, hunks) === null) {
      fail(`fold ${index + 1} must be an ordered range inside one chunk assigned to this file in this layer`)
      continue
    }

    for (const earlier of folds.slice(0, index)) {
      const relation = foldRelation(fold, earlier, hunks)
      if (relation === 'same-range') {
        fail(`fold ${index + 1} repeats the range of an earlier fold`)
      } else if (relation === 'partial') {
        fail(
          `fold ${index + 1} partly overlaps an earlier fold, uses another coordinate side in the same chunk, ` +
            'or nests inside a fold of the same or a lower level'
        )
      }
    }

    if (pinned.some(range => rangesOverlap(fold, range, hunks))) {
      fail(`fold ${index + 1} would hide an attention point`)
    }

    if (fold.level !== 'aggressive' && annotations.some(range => rangesOverlap(fold, range, hunks))) {
      fail(`fold ${index + 1} would hide an annotation, which only an aggressive fold may do`)
    }
  }

  return errors
}

/**
 * The rules a fresh generation meets for one file, about what the reading levels must be given to
 * hide: a test file keeps its titles at light, a light fold is one generated block, a file with
 * over `ROUTINE_ROWS` unannotated rows and no attention point hides something somewhere, and an
 * open core file folds half of what the reviewer need not judge by aggressive. A stored canvas
 * may predate them.
 */
function generationErrors(
  { file, hunks, where, pinned, annotations, folds, collapsed, rows, judged }: FileFolds,
  isTest: boolean
): ValidationError[] {
  const errors: ValidationError[] = []

  // Light leaves tests exactly as the diff shows them; the bodies fold from moderate.
  if (isTest && collapsed === 'light') {
    errors.push(
      error(
        'FOLD_INVALID',
        where,
        'a test file never collapses at light; fold each test body under its title, or collapse the file at moderate'
      )
    )
  }

  for (const [index, fold] of folds.entries()) {
    if (isTest && fold.level === 'light') {
      errors.push(
        error(
          'FOLD_INVALID',
          where,
          `fold ${index + 1} is light in a test file; light leaves tests as the diff shows them — ` +
            'fold each test body under its title at moderate'
        )
      )
    }

    const span = fold.endLine - fold.startLine + 1
    if (fold.level === 'light' && span > LIGHT_FOLD_MAX_ROWS) {
      errors.push(
        error(
          'FOLD_INVALID',
          where,
          `fold ${index + 1} at light covers ${span} rows; a light fold is one test body or one generated ` +
            'block — fold each test under its own title, or give the range moderate'
        )
      )
    }
  }

  if (collapsed !== null) {
    return errors
  }

  // An attention point is budgeted and always visible, so a file that carries one may stay open
  // for it. An annotation is not a licence: it marks the lines to read, and the rows around it are
  // as routine as in any other file.
  const unannotated = Math.max(rows - coveredRows(annotations), 0)
  if (pinned.length === 0 && unannotated > ROUTINE_ROWS && folds.length === 0) {
    errors.push(
      error(
        'FOLD_MISSING',
        where,
        annotations.length === 0
          ? `${rows} changed lines with no attention point or annotation, and nothing hidden at ` +
              'any level; collapse the file or fold its routine ranges'
          : `${rows} changed lines, ${unannotated} of them outside its annotations, and nothing hidden ` +
              'at any level; an annotation marks what to read — fold the routine ranges around it'
      )
    )
  } else if (rows > CORE_FILE_ROWS) {
    // Every fold hides at aggressive, whatever its own level, so what the reader is left with
    // there is the page's own count.
    const { hidden } = hiddenLines(file, hunks, 'aggressive')
    if (hidden < Math.ceil(judged * AGGRESSIVE_MIN_HIDDEN)) {
      errors.push(
        error(
          'FOLD_MISSING',
          where,
          `${hidden} of ${rows} changed lines hide at aggressive; a core file keeps its defining ` +
            `lines and folds the rest, at least half of the ${judged} lines outside its attention points`
        )
      )
    }
  }

  return errors
}

/**
 * The rule a fresh generation meets for a layer as a whole, once the layer is bigger than
 * `SMALL_LAYER_ROWS`: where `moderate` leaves more than `ROUTINE_ROWS` rows open outside the
 * attention points, `aggressive` hides some of them. The prompt asks the generator to check this
 * itself, and a layer with the same count at both levels is the one that has not. A file that
 * fails its own rule may fail this one too; both name a fix, and the file's is the smaller one.
 */
function layerErrors(layer: ModelLayer, files: readonly FileFolds[]): ValidationError[] {
  let rows = 0
  let judged = 0
  let hiddenAtModerate = 0
  let hiddenAtAggressive = 0

  for (const folds of files) {
    rows += folds.rows
    judged += folds.judged
    hiddenAtModerate += hiddenLines(folds.file, folds.hunks, 'moderate').hidden
    hiddenAtAggressive += hiddenLines(folds.file, folds.hunks, 'aggressive').hidden
  }

  const open = Math.max(judged - hiddenAtModerate, 0)
  if (rows <= SMALL_LAYER_ROWS || open <= ROUTINE_ROWS || hiddenAtAggressive > hiddenAtModerate) {
    return []
  }

  return [
    error(
      'FOLD_MISSING',
      `layer:${layer.key}`,
      `${open} changed lines stay open at moderate outside the attention points, and aggressive hides ` +
        'none of them; aggressive leaves only the core on screen — collapse the files outside it, ' +
        'fold the routine ranges inside it'
    ),
  ]
}

/**
 * Checks fold coordinates and keeps attention points visible at every level. An annotation stays
 * visible below aggressive, and its file never collapses. A fresh generation is also held to what
 * the reading levels must be given to hide; a stored artifact is not, because its generator may
 * predate those rules.
 */
export function validateFolds(
  output: ModelOutput,
  files: readonly FileEntry[],
  options: FoldValidationOptions = {}
): ValidationError[] {
  const byPath = new Map(files.map(file => [file.path, file]))
  const testPatterns = options.testPatterns ?? DEFAULT_TEST_PATTERNS

  return output.layers.flatMap(layer => {
    const layerFiles = layer.files.map(file =>
      fileFolds(file, layer, output, byPath.get(file.path)?.hunks ?? [])
    )
    if (options.storedArtifact === true) {
      return layerFiles.flatMap(correctnessErrors)
    }
    return [
      ...layerFiles.flatMap(folds => [
        ...correctnessErrors(folds),
        ...generationErrors(folds, isTestPath(folds.file.path, testPatterns)),
      ]),
      ...layerErrors(layer, layerFiles),
    ]
  })
}

export interface FoldValidationOptions {
  /** The globs that make a file a test; the built-in list when omitted. */
  testPatterns?: readonly string[] | undefined
  /**
   * The output was read back from a stored `review.json`, whose generator may predate the rules
   * about what a canvas must hide. Only the correctness rules apply then.
   */
  storedArtifact?: boolean | undefined
}
