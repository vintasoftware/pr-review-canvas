// @vitest-environment node
import type { CodeFold, ModelLayer, ModelOutput } from '../contract/review-artifact.js'
import { TEXT_CAPS } from '../contract/review-artifact.js'
import { toFileEntry } from '../git/diff-collector.js'
import { SYNTHETIC_FILES } from '../testing/synthetic.js'
import { applyFoldFixes, describeFoldFix } from './fix-folds.js'
import { validateFolds } from './validate-folds.js'

// src/app.ts has two hunks: #1 spans new 1-5 (old 1-4), #2 spans new 11-14 (old 10-12).
const files = SYNTHETIC_FILES.map(toFileEntry)

function fold(startLine: number, endLine: number, title = `lines ${startLine}-${endLine}`): CodeFold {
  return { title, side: 'new', startLine, endLine, level: 'moderate' }
}

function model(folds: CodeFold[], hunks = ['src_app_ts#1', 'src_app_ts#2']): ModelOutput {
  const layer: ModelLayer = {
    key: 'run',
    kind: 'layer',
    title: 'Run',
    rationale: '',
    tests: [],
    files: [{ path: 'src/app.ts', hunks, annotations: [], folds }],
  }
  return { summary: 'Run path', layers: [layer], points: [] }
}

function point(line: number, endLine?: number, side: 'new' | 'old' = 'new'): ModelOutput['points'][number] {
  return {
    kind: 'decision',
    level: 'decide',
    title: `Point at ${line}`,
    path: 'src/app.ts',
    side,
    line,
    ...(endLine === undefined ? {} : { endLine }),
    body: 'Review this choice.',
  }
}

function foldsOf(output: ModelOutput): Array<[number, number]> {
  return (output.layers[0]?.files[0]?.folds ?? []).map(f => [f.startLine, f.endLine])
}

function invalid(output: ModelOutput): string[] {
  return validateFolds(output, files)
    .filter(error => error.code === 'FOLD_INVALID')
    .map(error => error.message)
}

describe('applyFoldFixes', () => {
  it('clips a fold that crosses into the next chunk, or runs past the end of its own', () => {
    const output = model([fold(3, 12), fold(12, 20)])

    const fixes = applyFoldFixes(output, files, TEXT_CAPS)

    expect(fixes.map(describeFoldFix)).toEqual([
      'fold "lines 3-12" new 3-12 -> new 3-5, clipped to the chunk it starts in',
      'fold "lines 12-20" new 12-20 -> new 12-14, clipped to the chunk it starts in',
    ])
    expect(fixes[0]?.where).toBe('layers.0.files.0.folds.0')
    expect(foldsOf(output)).toEqual([
      [3, 5],
      [12, 14],
    ])
    expect(invalid(output)).toEqual([])
  })

  it('drops a fold whose start is in no assigned chunk, and never moves it into another layer', () => {
    // Line 7 sits between the two hunks; hunk #2 belongs to another layer here.
    const output = model([fold(7, 12), fold(11, 12), fold(1, 2)], ['src_app_ts#1'])

    const fixes = applyFoldFixes(output, files, TEXT_CAPS)

    expect(fixes.map(describeFoldFix)).toEqual([
      'dropped fold "lines 7-12" at new 7-12: it starts in no chunk assigned to this file in this layer',
      'dropped fold "lines 11-12" at new 11-12: it starts in no chunk assigned to this file in this layer',
    ])
    expect(fixes.map(fix => fix.where)).toEqual(['layers.0.files.0.folds.0', 'layers.0.files.0.folds.1'])
    expect(foldsOf(output)).toEqual([[1, 2]])
  })

  it('drops a later fold that repeats an earlier range, including one that only matches once clipped', () => {
    const output = model([fold(3, 5, 'run()'), fold(3, 5, 'run() again'), fold(3, 9, 'run() wide')])

    const fixes = applyFoldFixes(output, files, TEXT_CAPS)

    expect(fixes.map(describeFoldFix)).toEqual([
      'dropped fold "run() again" at new 3-5: it repeats the range of "run()"',
      'dropped fold "run() wide" at new 3-9: it repeats the range of "run()"',
    ])
    expect(foldsOf(output)).toEqual([[3, 5]])
  })

  it('shrinks a fold so an attention point at its edge stays visible', () => {
    const output = model([fold(1, 5)])
    output.points = [point(4, 5)]

    const fixes = applyFoldFixes(output, files, TEXT_CAPS)

    expect(fixes.map(describeFoldFix)).toEqual([
      'fold "lines 1-5" new 1-5 -> new 1-3, shrunk to keep the attention point at new 4-5 visible',
    ])
    expect(invalid(output)).toEqual([])
  })

  it('clips and shrinks in one step, reporting both', () => {
    const output = model([fold(12, 20)])
    output.points = [point(12)]

    expect(applyFoldFixes(output, files, TEXT_CAPS).map(describeFoldFix)).toEqual([
      'fold "lines 12-20" new 12-20 -> new 13-14, clipped to the chunk it starts in, ' +
        'then shrunk to keep the attention point at new 12 visible',
    ])
  })

  it.each([
    { name: 'splits it in two', points: [point(3)] },
    { name: 'covers all of it', points: [point(1, 5)] },
    { name: 'sits on the other side of the chunk', points: [point(3, undefined, 'old')] },
  ])('drops a fold when the attention point $name', ({ points }) => {
    const output = model([fold(1, 5)])
    output.points = points

    const fixes = applyFoldFixes(output, files, TEXT_CAPS)

    expect(fixes).toHaveLength(1)
    expect(fixes[0]?.to).toBeNull()
    expect(describeFoldFix(fixes[0]!)).toMatch(/^dropped fold "lines 1-5" at new 1-5: no single range/)
    expect(foldsOf(output)).toEqual([])
  })

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const output = model([fold(3, 12), fold(3, 5), fold(7, 8), fold(12, 20)])
    output.points = [point(13)]

    expect(applyFoldFixes(output, files, TEXT_CAPS)).toHaveLength(4)
    const once = JSON.stringify(output)
    expect(applyFoldFixes(output, files, TEXT_CAPS)).toEqual([])
    expect(JSON.stringify(output)).toBe(once)
    expect(invalid(output)).toEqual([])
  })

  it('leaves partial overlaps, reversed ranges, and a model that fails the schema to the writer', () => {
    const output = model([fold(1, 4), fold(3, 5), fold(5, 2)])
    const before = JSON.stringify(output)

    expect(applyFoldFixes(output, files, TEXT_CAPS)).toEqual([])
    expect(JSON.stringify(output)).toBe(before)
    expect(applyFoldFixes({ layers: [{ files: [{ folds: [fold(3, 12)] }] }] }, files, TEXT_CAPS)).toEqual([])
  })
})
