// @vitest-environment node
import type { CodeFold, ModelLayer, ModelOutput } from '../contract/review-artifact.js'
import { toFileEntry } from '../git/diff-collector.js'
import { SYNTHETIC_FILES } from '../testing/synthetic.js'
import { validateFolds } from './validate-folds.js'

const files = SYNTHETIC_FILES.map(toFileEntry)
const where = 'layer:run/file:src/app.ts'

function fixture() {
  const fold: CodeFold = { title: 'run()', side: 'new', startLine: 3, endLine: 5 }
  const file: ModelLayer['files'][number] = {
    path: 'src/app.ts',
    hunks: ['src_app_ts#1'],
    annotations: [],
    folds: [fold],
  }
  const layer: ModelLayer = {
    key: 'run',
    kind: 'layer',
    title: 'Run',
    rationale: '',
    tests: [],
    files: [file],
  }
  const output: ModelOutput = { summary: 'Run path', layers: [layer], points: [] }

  return { output, layer, file, fold }
}

describe('validateFolds', () => {
  it('accepts titled ranges and whole-file collapse without requiring a reason', () => {
    const { output, file } = fixture()
    file.collapsed = true

    expect(validateFolds(output, files)).toEqual([])
  })

  it.each([
    { startLine: 5, endLine: 3 },
    { startLine: 3, endLine: 12 },
    { startLine: 50, endLine: 55 },
    { startLine: 11, endLine: 14 },
  ])('rejects a reversed, unassigned, or out-of-hunk range: %o', range => {
    const { output, fold } = fixture()
    Object.assign(fold, range)

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: fold 1 must be an ordered range inside one hunk assigned to this file in this layer`,
      },
    ])
  })

  it('rejects overlapping folds', () => {
    const { output, file } = fixture()
    file.folds?.push({ title: 'return value', side: 'new', startLine: 4, endLine: 5 })

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: fold 2 overlaps an earlier fold or uses another coordinate side in the same hunk`,
      },
    ])
  })

  it('keeps annotated code expanded', () => {
    const { output, file } = fixture()
    file.annotations = [{ side: 'new', startLine: 4, endLine: 4, text: 'A decision here' }]
    file.collapsed = true

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: a file with annotations or attention points must start expanded`,
      },
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an annotation or attention point` },
    ])
  })

  it('keeps attention points visible even when they use the other diff side', () => {
    const { output } = fixture()
    output.points = [
      {
        kind: 'decision',
        level: 'decide',
        title: 'Return value',
        path: 'src/app.ts',
        side: 'old',
        line: 3,
        body: 'Review this choice.',
      },
    ]

    expect(validateFolds(output, files)).toEqual([
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an annotation or attention point` },
    ])
  })

  it('keeps the generated missing-test point visible', () => {
    const { output, file, layer, fold } = fixture()
    layer.tests = [{ behavior: 'handles failure', status: 'missing' }]
    file.collapsed = true
    fold.startLine = 1

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: a file with annotations or attention points must start expanded`,
      },
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an annotation or attention point` },
    ])
  })

  it('allows separate ranges and keeps older output without folds valid', () => {
    const { output, file, fold } = fixture()
    fold.endLine = 3
    file.folds?.push({ title: 'return', side: 'new', startLine: 4, endLine: 5 })
    expect(validateFolds(output, files)).toEqual([])

    file.folds = undefined
    expect(validateFolds(output, files)).toEqual([])
  })
})
