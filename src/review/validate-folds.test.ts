// @vitest-environment node
import type { CodeFold, FileEntry, ModelLayer, ModelOutput } from '../contract/review-artifact.js'
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
    file.collapsed = 'light'

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
        message: `${where}: fold 1 must be an ordered range inside one chunk assigned to this file in this layer`,
      },
    ])
  })

  it('rejects folds that partly overlap', () => {
    const { output, file } = fixture()
    file.folds?.push({ title: 'return value', side: 'new', startLine: 2, endLine: 4 })

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message:
          `${where}: fold 2 partly overlaps an earlier fold, uses another coordinate side in the same ` +
          'chunk, or nests inside a fold of the same or a lower level',
      },
    ])
  })

  it('rejects two folds over the same range', () => {
    const { output, file } = fixture()
    file.folds?.push({ title: 'run() again', side: 'new', startLine: 3, endLine: 5, level: 'moderate' })

    expect(validateFolds(output, files)).toEqual([
      { code: 'FOLD_INVALID', where, message: `${where}: fold 2 repeats the range of an earlier fold` },
    ])
  })

  it('accepts a lower-level fold nested in a higher-level one', () => {
    const { output, file, fold } = fixture()
    fold.level = 'moderate'
    file.folds?.push({ title: 'the body', side: 'new', startLine: 4, endLine: 5, level: 'light' })

    expect(validateFolds(output, files)).toEqual([])
  })

  it('rejects a nested fold that does not lower the level', () => {
    const { output, file, fold } = fixture()
    fold.level = 'light'
    file.folds?.push({ title: 'the body', side: 'new', startLine: 4, endLine: 5, level: 'moderate' })

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message:
          `${where}: fold 2 partly overlaps an earlier fold, uses another coordinate side in the same ` +
          'chunk, or nests inside a fold of the same or a lower level',
      },
    ])
  })

  it('keeps annotated code expanded below the aggressive level', () => {
    const { output, file } = fixture()
    file.annotations = [{ side: 'new', startLine: 4, endLine: 4, text: 'A decision here' }]
    file.collapsed = 'light'

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: a file with annotations never collapses; fold the ranges around them instead`,
      },
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: fold 1 would hide an annotation, which only an aggressive fold may do`,
      },
    ])
  })

  it('lets an aggressive fold hide an annotation, but never a collapse of its file', () => {
    const { output, file, fold } = fixture()
    file.annotations = [{ side: 'new', startLine: 4, endLine: 4, text: 'A decision here' }]
    fold.level = 'aggressive'
    expect(validateFolds(output, files)).toEqual([])

    // The fold shows the annotation's text as its title; a collapsed file would show only its path.
    file.collapsed = 'aggressive'
    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: a file with annotations never collapses; fold the ranges around them instead`,
      },
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
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an attention point` },
    ])
  })

  it('keeps an attention point visible even at the aggressive level', () => {
    const { output, fold } = fixture()
    fold.level = 'aggressive'
    output.points = [
      {
        kind: 'decision',
        level: 'decide',
        title: 'Return value',
        path: 'src/app.ts',
        side: 'new',
        line: 4,
        body: 'Review this choice.',
      },
    ]

    expect(validateFolds(output, files)).toEqual([
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an attention point` },
    ])
  })

  it('keeps the generated missing-test point visible', () => {
    const { output, file, layer, fold } = fixture()
    layer.tests = [{ behavior: 'handles failure', status: 'missing' }]
    file.collapsed = 'light'
    fold.startLine = 1

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where,
        message: `${where}: a file with attention points must start expanded`,
      },
      { code: 'FOLD_INVALID', where, message: `${where}: fold 1 would hide an attention point` },
    ])
  })

  it('keeps a test file open at light, so its titles read as the spec', () => {
    const { output, layer } = fixture()
    const tests: ModelLayer['files'][number] = {
      path: 'src/app.test.ts',
      hunks: ['src_app_test_ts#1'],
      annotations: [],
      collapsed: 'light',
    }
    layer.files.push(tests)
    const testWhere = 'layer:run/file:src/app.test.ts'

    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where: testWhere,
        message: `${testWhere}: a test file never collapses at light; fold each test body under its title, or collapse the file at moderate`,
      },
    ])

    tests.collapsed = 'moderate'
    expect(validateFolds(output, files)).toEqual([])

    // The same for a fold: a test body folds from moderate, never at light.
    delete tests.collapsed
    tests.folds = [{ title: 'runs', side: 'new', startLine: 3, endLine: 4, level: 'light' }]
    expect(validateFolds(output, files)).toEqual([
      {
        code: 'FOLD_INVALID',
        where: testWhere,
        message: `${testWhere}: fold 1 is light in a test file; light leaves tests as the diff shows them — fold each test body under its title at moderate`,
      },
    ])
    tests.folds[0]!.level = 'moderate'
    expect(validateFolds(output, files)).toEqual([])
  })

  /** A sixty-line added file with no point and no annotation: the reading levels have nothing to do. */
  const big: FileEntry = {
    path: 'src/big.ts',
    key: 'src_big_ts',
    status: 'added',
    additions: 60,
    deletions: 0,
    hunks: [
      {
        id: 'src_big_ts#1',
        header: '@@ -0,0 +1,60 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 60,
      },
    ],
  }
  const bigWhere = 'layer:run/file:src/big.ts'

  function withBig(over: Partial<ModelLayer['files'][number]> = {}) {
    const { output, layer } = fixture()
    layer.files = [{ path: 'src/big.ts', hunks: ['src_big_ts#1'], annotations: [], ...over }]
    return { output, layer }
  }

  describe('a routine file that hides nothing', () => {
    it('is refused', () => {
      const { output } = withBig()
      expect(validateFolds(output, [...files, big])).toEqual([
        {
          code: 'FOLD_MISSING',
          where: bigWhere,
          message: `${bigWhere}: 60 changed lines with no attention point or annotation, and nothing hidden at any level; collapse the file or fold its routine ranges`,
        },
      ])
    })

    it('passes once it collapses or folds a range', () => {
      expect(validateFolds(withBig({ collapsed: 'aggressive' }).output, [...files, big])).toEqual([])
      expect(
        validateFolds(
          withBig({
            folds: [{ title: 'wiring', side: 'new', startLine: 10, endLine: 40, level: 'aggressive' }],
          }).output,
          [...files, big]
        )
      ).toEqual([])
    })

    it('is not excused by an annotation, which marks what to read and leaves the rest routine', () => {
      const annotation = { side: 'new' as const, startLine: 5, endLine: 5, text: 'Read this.' }
      expect(validateFolds(withBig({ annotations: [annotation] }).output, [...files, big])).toEqual([
        {
          code: 'FOLD_MISSING',
          where: bigWhere,
          message: `${bigWhere}: 60 changed lines, 59 of them outside its annotations, and nothing hidden at any level; an annotation marks what to read — fold the routine ranges around it`,
        },
      ])

      // Once the routine ranges fold, the annotation stays open below aggressive as before.
      const fold: CodeFold = { title: 'wiring', side: 'new', startLine: 10, endLine: 40, level: 'aggressive' }
      expect(
        validateFolds(withBig({ annotations: [annotation], folds: [fold] }).output, [...files, big])
      ).toEqual([])

      // A file whose annotations leave few rows uncovered has nothing routine left to fold.
      const wide = { side: 'new' as const, startLine: 1, endLine: 40, text: 'All of this is the rule.' }
      expect(validateFolds(withBig({ annotations: [wide] }).output, [...files, big])).toEqual([])
    })

    it('may stay open for an attention point', () => {
      const { output } = withBig()
      output.points = [
        { kind: 'decision', level: 'fyi', title: 'Why', path: 'src/big.ts', line: 3, body: 'Because.' },
      ]
      expect(validateFolds(output, [...files, big])).toEqual([])
    })

    it('is accepted from a stored artifact, whose generator may predate the rule', () => {
      const { output } = withBig()
      expect(validateFolds(output, [...files, big], { storedArtifact: true })).toEqual([])
    })

    it('rejects a light fold wide enough to be a group of tests, at any file', () => {
      const wide = {
        title: 'all the invite tests',
        side: 'new' as const,
        startLine: 1,
        endLine: 50,
        level: 'light' as const,
      }
      const { output } = withBig({ folds: [wide] })
      expect(validateFolds(output, [...files, big])).toEqual([
        {
          code: 'FOLD_INVALID',
          where: bigWhere,
          message: `${bigWhere}: fold 1 at light covers 50 rows; a light fold is one test body or one generated block — fold each test under its own title, or give the range moderate`,
        },
      ])

      expect(
        validateFolds(withBig({ folds: [{ ...wide, level: 'moderate' }] }).output, [...files, big])
      ).toEqual([])
      expect(validateFolds(withBig({ folds: [{ ...wide, endLine: 40 }] }).output, [...files, big])).toEqual(
        []
      )
    })

    it('is accepted from a stored artifact, whose generator may predate the rule', () => {
      const wide = { title: 'all', side: 'new' as const, startLine: 1, endLine: 50, level: 'light' as const }
      expect(
        validateFolds(withBig({ folds: [wide] }).output, [...files, big], { storedArtifact: true })
      ).toEqual([])
    })

    it('leaves a small file alone', () => {
      const { output } = withBig()
      const small = { ...big, hunks: [{ ...big.hunks[0]!, newLines: 20 }] }
      expect(validateFolds(output, [...files, small])).toEqual([])
    })
  })

  describe('a core file that stays mostly open at aggressive', () => {
    /** A 200-line file the layer keeps open, with one annotation: the reviewer must judge some of it, not all. */
    const core: FileEntry = {
      path: 'src/core.ts',
      key: 'src_core_ts',
      status: 'added',
      additions: 200,
      deletions: 0,
      hunks: [
        {
          id: 'src_core_ts#1',
          header: '@@ -0,0 +1,200 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 200,
        },
      ],
    }
    const coreWhere = 'layer:run/file:src/core.ts'
    const annotation = { side: 'new' as const, startLine: 10, endLine: 19, text: 'The rule.' }

    function withCore(folds: CodeFold[]) {
      const { output, layer } = fixture()
      layer.files = [{ path: 'src/core.ts', hunks: ['src_core_ts#1'], annotations: [annotation], folds }]
      return output
    }

    it('is refused when less than half of its rows outside attention points fold', () => {
      const output = withCore([
        { title: 'ceremony', side: 'new', startLine: 150, endLine: 189, level: 'aggressive' },
      ])
      expect(validateFolds(output, [...files, core])).toEqual([
        {
          code: 'FOLD_MISSING',
          where: coreWhere,
          message: `${coreWhere}: 40 of 200 changed lines hide at aggressive; a core file keeps its defining lines and folds the rest, at least half of the 200 lines outside its attention points`,
        },
      ])
    })

    it('passes once folds cover half of it, at any mix of levels', () => {
      const output = withCore([
        { title: 'accessors', side: 'new', startLine: 30, endLine: 79, level: 'moderate' },
        { title: 'formatting', side: 'new', startLine: 120, endLine: 169, level: 'aggressive' },
      ])
      expect(validateFolds(output, [...files, core])).toEqual([])
    })

    it('counts annotated rows as rows to fold, so annotating more does not lower the bar', () => {
      // Ninety rows hide; the annotation adds nothing to that, even though it covers ten rows.
      const short = withCore([
        { title: 'ceremony', side: 'new', startLine: 100, endLine: 189, level: 'aggressive' },
      ])
      expect(validateFolds(short, [...files, core])).toHaveLength(1)

      // An aggressive fold over the annotated rows is allowed and counts towards the half.
      const overAnnotation = withCore([
        { title: 'the rule, then ceremony', side: 'new', startLine: 10, endLine: 19, level: 'aggressive' },
        { title: 'ceremony', side: 'new', startLine: 100, endLine: 189, level: 'aggressive' },
      ])
      expect(validateFolds(overAnnotation, [...files, core])).toEqual([])
    })

    it('does not ask a stored artifact or a small file for it', () => {
      const output = withCore([
        { title: 'one accessor', side: 'new', startLine: 30, endLine: 34, level: 'aggressive' },
      ])
      expect(validateFolds(output, [...files, core])).toHaveLength(1)
      expect(validateFolds(output, [...files, core], { storedArtifact: true })).toEqual([])
      const small = { ...core, hunks: [{ ...core.hunks[0]!, newLines: 60 }] }
      expect(validateFolds(output, [...files, small])).toEqual([])
    })
  })

  describe('a layer that hides the same at moderate and aggressive', () => {
    const layerWhere = 'layer:run'

    /** A 120-line added file: on its own it makes a layer bigger than the small-layer floor. */
    const wide: FileEntry = {
      path: 'src/wide.ts',
      key: 'src_wide_ts',
      status: 'added',
      additions: 120,
      deletions: 0,
      hunks: [
        {
          id: 'src_wide_ts#1',
          header: '@@ -0,0 +1,120 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 120,
        },
      ],
    }

    /** Seventy rows fold at moderate, so the file passes its own core rule and fifty rows stay open. */
    const moderate: CodeFold = { title: 'wiring', side: 'new', startLine: 1, endLine: 70, level: 'moderate' }

    function withWide(over: Partial<ModelLayer['files'][number]> = {}) {
      const { output, layer } = fixture()
      layer.files = [{ path: 'src/wide.ts', hunks: ['src_wide_ts#1'], annotations: [], ...over }]
      return { output, layer }
    }

    it('is refused while moderate leaves more than a routine file open', () => {
      expect(validateFolds(withWide({ folds: [moderate] }).output, [...files, wide])).toEqual([
        {
          code: 'FOLD_MISSING',
          where: layerWhere,
          message: `${layerWhere}: 50 changed lines stay open at moderate outside the attention points, and aggressive hides none of them; aggressive leaves only the core on screen — collapse the files outside it, fold the routine ranges inside it`,
        },
      ])
    })

    it('passes once aggressive hides anything more, in any file of the layer', () => {
      const more: CodeFold = {
        title: 'formatting',
        side: 'new',
        startLine: 80,
        endLine: 82,
        level: 'aggressive',
      }
      expect(validateFolds(withWide({ folds: [moderate, more] }).output, [...files, wide])).toEqual([])

      const { output, layer } = withWide({ folds: [moderate] })
      layer.files.push({
        path: 'src/app.ts',
        hunks: ['src_app_ts#1'],
        annotations: [],
        collapsed: 'aggressive',
      })
      expect(validateFolds(output, files.concat(wide))).toEqual([])
    })

    it('leaves the layer alone when moderate already shows only a routine file or less', () => {
      expect(
        validateFolds(withWide({ folds: [{ ...moderate, endLine: 100 }] }).output, [...files, wide])
      ).toEqual([])

      // Attention points are never hidden, so their rows are not open rows aggressive could take.
      const { output } = withWide({ folds: [{ ...moderate, endLine: 99 }] })
      expect(validateFolds(output, [...files, wide])).toHaveLength(1)
      output.points = [
        { kind: 'decision', level: 'fyi', title: 'Why', path: 'src/wide.ts', line: 110, body: 'Because.' },
      ]
      expect(validateFolds(output, [...files, wide])).toEqual([])
    })

    it('leaves a small layer alone: it reads whole, and only the file rules apply', () => {
      // Sixty rows, thirty-one of them folded at moderate and nothing more at aggressive.
      const small: CodeFold = { title: 'wiring', side: 'new', startLine: 10, endLine: 40, level: 'moderate' }
      expect(validateFolds(withBig({ folds: [small] }).output, [...files, big])).toEqual([])

      // The same shape in a layer over the floor is refused.
      const { output, layer } = withBig({ folds: [small] })
      layer.files.push({
        path: 'src/wide.ts',
        hunks: ['src_wide_ts#1'],
        annotations: [],
        collapsed: 'moderate',
      })
      expect(validateFolds(output, [...files, big, wide])).toHaveLength(1)
    })

    it('speaks beside a file rule, since each names its own fix', () => {
      const { output } = withWide()
      expect(validateFolds(output, [...files, wide]).map(e => e.where)).toEqual([
        'layer:run/file:src/wide.ts',
        layerWhere,
      ])
    })

    it('is accepted from a stored artifact, whose generator may predate the rule', () => {
      expect(
        validateFolds(withWide({ folds: [moderate] }).output, [...files, wide], { storedArtifact: true })
      ).toEqual([])
    })
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
