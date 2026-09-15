// @vitest-environment node
// One case per error code, each on a clean output with exactly one thing wrong, plus the clean
// output itself and the committed PR #278 canvas.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { LIMITS, type ModelOutput, ReviewArtifactSchema, TEXT_CAPS } from '../contract/review-artifact.js'
import { formatValidationError, VALIDATION_CODES, type ValidationError } from '../contract/validation.js'
import { toFileEntry } from '../git/diff-collector.js'
import { PACKAGE_ROOT } from '../server/context.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import { artifactToModelOutput } from './normalize.js'
import { visibleLength } from './text-length.js'
import { coveredTestPaths, type ValidationInput, validateModelOutput } from './validate.js'

const FILES = SYNTHETIC_FILES.map(toFileEntry)

function input(over: Partial<ValidationInput> = {}): ValidationInput {
  return {
    files: FILES,
    caps: TEXT_CAPS,
    limits: LIMITS,
    highRisk: [{ pattern: 'src/new-name.ts', label: 'rename' }],
    ...over,
  }
}

/** The synthetic artifact as the model would have written it: two layers, tests last, Other last. */
function clean(): ModelOutput {
  return artifactToModelOutput(syntheticArtifact())
}

function layer(output: ModelOutput, index: number) {
  const l = output.layers[index]
  if (l === undefined) {
    throw new Error(`no layer ${index}`)
  }
  return l
}

function errorsOf(output: unknown, over: Partial<ValidationInput> = {}): ValidationError[] {
  return validateModelOutput(output, input(over)).errors
}

describe('validateModelOutput', () => {
  it('caps file notes by visible text while allowing long link targets', () => {
    const output = clean()
    const file = output.layers[0]!.files[0]!
    file.note = 'x'.repeat(TEXT_CAPS.annotation + 1)
    expect(errorsOf(output)).toEqual([
      expect.objectContaining({ code: 'TEXT_TOO_LONG', where: 'layers.0.files.0.note' }),
    ])
    file.note = `[short](https://example.com/${'x'.repeat(TEXT_CAPS.annotation)})`
    expect(errorsOf(output)).toEqual([])
  })

  it('keeps descriptive fold fields in the validated JSON', () => {
    const output = clean()
    const file = output.layers.flatMap(layer => layer.files).find(file => file.path === 'src/app.test.ts')
    if (file === undefined) {
      throw new Error('missing test file')
    }

    file.collapsed = true
    file.folds = [{ title: 'runs', side: 'new', startLine: 2, endLine: 4 }]

    expect(validateModelOutput(output, input())).toEqual({ ok: true, errors: [], output })

    file.folds[0] = { title: 'runs', side: 'new', startLine: 2, endLine: 400 }
    const invalid = validateModelOutput(output, input())

    expect(invalid.output).toBeNull()
    expect(invalid.errors).toEqual([
      {
        code: 'FOLD_INVALID',
        where: 'layer:run-path/file:src/app.test.ts',
        message:
          'layer:run-path/file:src/app.test.ts: fold 1 must be an ordered range inside one hunk assigned to this file in this layer',
      },
    ])
  })

  it.each([
    { title: '', side: 'new', startLine: 2, endLine: 4 },
    { title: '   ', side: 'new', startLine: 2, endLine: 4 },
    { title: 'runs', side: 'head', startLine: 2, endLine: 4 },
    { title: 'runs', side: 'new', startLine: 0, endLine: 4 },
    { title: 'runs', side: 'new', startLine: 2.5, endLine: 4 },
    { title: 'runs', side: 'new', startLine: 2 },
  ])('rejects malformed fold JSON: %o', fold => {
    const output = clean()
    const file = output.layers[0]?.files[0]
    if (file === undefined) {
      throw new Error('missing file')
    }

    Reflect.set(file, 'folds', [fold])
    const result = validateModelOutput(output, input())

    expect(result.output).toBeNull()
    expect(result.errors).toEqual([expect.objectContaining({ code: 'SCHEMA' })])
  })

  it.each(['x'.repeat(TEXT_CAPS.pointTitle + 1), `[run](https://example.com/${'x'.repeat(TEXT_CAPS.pointTitle)})`])(
    'counts the whole plain-text fold title toward its cap: %s',
    title => {
      const output = clean()
      const file = output.layers[0]?.files.find(file => file.path === 'src/app.test.ts')
      if (file === undefined) {
        throw new Error('missing test file')
      }

      file.folds = [{ title, side: 'new', startLine: 2, endLine: 4 }]
      expect(errorsOf(output)).toEqual([expect.objectContaining({ code: 'TEXT_TOO_LONG' })])
    }
  )

  it('passes the clean synthetic output and returns the parsed output', () => {
    const result = validateModelOutput(clean(), input())
    expect(result).toEqual({ ok: true, errors: [], output: clean() })
  })

  it('SCHEMA: names the field and stops before the semantic rules', () => {
    expect(errorsOf({ summary: 1, layers: [], points: 'x' })).toEqual([
      { code: 'SCHEMA', where: 'summary', message: 'summary: Invalid input: expected string, received number' },
      { code: 'SCHEMA', where: 'layers', message: 'layers: Too small: expected array to have >=1 items' },
      { code: 'SCHEMA', where: 'points', message: 'points: Invalid input: expected array, received string' },
    ])
    expect(validateModelOutput(undefined, input()).output).toBeNull()
    expect(errorsOf(null)).toEqual([
      { code: 'SCHEMA', where: '(root)', message: '(root): Invalid input: expected object, received null' },
    ])
  })

  it('TEXT_TOO_LONG: measures the visible text, names the cap in force, and still runs the layering rules', () => {
    const output = clean()
    layer(output, 0).rationale = 'r'.repeat(301)
    expect(errorsOf(output).map(e => [e.code, e.where])).toEqual([['TEXT_TOO_LONG', 'layers.0.rationale']])
    // The message names the overage and where the cap falls in the author's own words.
    expect(errorsOf(output)[0]?.message).toContain('layers.0.rationale: 301 visible chars, cap 300;')
    expect(errorsOf(output)[0]?.message).toContain('what fits ends at "...rrrr')
    layer(output, 1).files.pop()
    expect(errorsOf(output).map(e => e.code)).toEqual(['TEXT_TOO_LONG', 'HUNK_UNASSIGNED'])
    expect(validateModelOutput(output, input()).output).toBeNull()
    const capped = errorsOf(clean(), { caps: { ...TEXT_CAPS, summary: 50 } })
    expect(capped.map(e => [e.code, e.where])).toEqual([['TEXT_TOO_LONG', 'summary']])
    expect(capped[0]?.message).toContain(`summary: ${visibleLength(clean().summary)} visible chars, cap 50;`)
    // A long link target and backticks do not count; only the text a reader sees does.
    const linked = clean()
    layer(linked, 0).rationale = `${'r'.repeat(280)} [see](#hunk:${'p'.repeat(200)}/x.ts#1) \`code\``
    // 484 raw characters, 291 visible: only the unknown link target is reported.
    expect(errorsOf(linked).map(e => e.code)).toEqual(['LINK_UNRESOLVED'])
    layer(linked, 0).rationale = `${'r'.repeat(297)} [see](#hunk:src/app.ts#1)`
    expect(errorsOf(linked).map(formatValidationError)[0]).toContain(
      'TEXT_TOO_LONG layers.0.rationale: 301 visible chars, cap 300;'
    )
    // Raw text past four times the cap is refused by the schema before anything else runs.
    const raw = clean()
    raw.summary = 'x'.repeat(TEXT_CAPS.summary * 4 + 1)
    layer(raw, 1).files.pop()
    expect(errorsOf(raw)).toEqual([
      {
        code: 'TEXT_TOO_LONG',
        where: 'summary',
        message: `summary: ${TEXT_CAPS.summary * 4 + 1} raw chars, hard limit ${TEXT_CAPS.summary * 4}`,
      },
    ])
  })

  it('TEXT_TOO_LONG: one per capped field, each naming its path and cap', () => {
    const cases: Array<[keyof typeof TEXT_CAPS, string, (o: ModelOutput, v: string) => void]> = [
      [
        'summary',
        'summary',
        (o, v) => {
          o.summary = v
        },
      ],
      [
        'layerTitle',
        'layers.0.title',
        (o, v) => {
          layer(o, 0).title = v
        },
      ],
      [
        'rationale',
        'layers.0.rationale',
        (o, v) => {
          layer(o, 0).rationale = v
        },
      ],
      [
        'decisions',
        'layers.0.decisions',
        (o, v) => {
          layer(o, 0).decisions = v
        },
      ],
      [
        'checkByHand',
        'layers.0.checkByHand',
        (o, v) => {
          layer(o, 0).checkByHand = v
        },
      ],
      [
        'annotation',
        'layers.0.files.0.annotations.0.text',
        (o, v) => {
          const a = layer(o, 0).files[0]?.annotations[0]
          if (a) {
            a.text = v
          }
        },
      ],
      [
        'pointTitle',
        'points.0.title',
        (o, v) => {
          const p = o.points[0]
          if (p) {
            p.title = v
          }
        },
      ],
      [
        'pointBody',
        'points.0.body',
        (o, v) => {
          const p = o.points[0]
          if (p) {
            p.body = v
          }
        },
      ],
      [
        'testBehavior',
        'layers.0.tests.0.behavior',
        (o, v) => {
          const t = layer(o, 0).tests[0]
          if (t) {
            t.behavior = v
          }
        },
      ],
    ]
    for (const [key, where, set] of cases) {
      const output = clean()
      set(output, 'x'.repeat(TEXT_CAPS[key] + 1))
      expect(
        errorsOf(output).map(e => [e.code, e.where]),
        key
      ).toEqual([['TEXT_TOO_LONG', where]])
      expect(errorsOf(output)[0]?.message, key).toContain(
        `${where}: ${TEXT_CAPS[key] + 1} visible chars, cap ${TEXT_CAPS[key]};`
      )
    }
  })

  it('DIAGRAM_LIMIT: one diagram per layer and one in the summary, counting the field and a rationale fence', () => {
    const twice = clean()
    const l = layer(twice, 0)
    l.diagram = { mermaid: 'flowchart LR\n  A --> B', links: {} }
    l.rationale = 'Read the swap.\n\n```mermaid\nflowchart LR\n  C --> D\n```'
    expect(errorsOf(twice).map(formatValidationError)).toEqual(['DIAGRAM_LIMIT layer run-path: 2 diagrams, at most 1'])
    // One of the two on its own passes, wherever it sits.
    const field = clean()
    layer(field, 0).diagram = { mermaid: 'flowchart LR\n  A --> B', links: {} }
    expect(errorsOf(field)).toEqual([])
    const fence = clean()
    layer(fence, 0).rationale = 'Read the swap.\n\n```mermaid\nflowchart LR\n  C --> D\n```'
    expect(errorsOf(fence)).toEqual([])
    const summary = clean()
    summary.summary = '```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  C --> D\n```'
    expect(errorsOf(summary).map(formatValidationError)).toEqual(['DIAGRAM_LIMIT summary: 2 diagrams, at most 1'])
    // The Other layer has a bucket of its own.
    const spread = clean()
    layer(spread, 1).rationale = '```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart LR\n  C --> D\n```'
    expect(errorsOf(spread).map(formatValidationError)).toEqual(['DIAGRAM_LIMIT other: 2 diagrams, at most 1'])
    expect(errorsOf(clean(), { limits: { ...LIMITS, maxDiagramsPerLayer: 2 } })).toEqual([])
  })

  it('a fence in a field the page does not draw is prose: it counts against that field, not the layer', () => {
    // Only the summary and a layer rationale render a diagram, so a fence elsewhere stays a code
    // block and answers to its own cap like the rest of the text.
    const output = clean()
    const l = layer(output, 0)
    l.diagram = { mermaid: 'flowchart LR\n  A --> B', links: {} }
    l.decisions = 'We kept the swap.\n\n```mermaid\nflowchart LR\n  C --> D\n```'
    const point = output.points[0]
    if (!point) {
      throw new Error('no point')
    }
    point.body = 'Look at it.\n\n```mermaid\nflowchart LR\n  E --> F\n```'
    expect(errorsOf(output)).toEqual([])
    const long = clean()
    layer(long, 0).decisions = `\`\`\`mermaid\n${'X'.repeat(TEXT_CAPS.decisions)}\n\`\`\``
    expect(errorsOf(long).map(e => e.code)).toEqual(['TEXT_TOO_LONG'])
  })

  it('TEXT_TOO_LONG: the diagram source is measured raw, and never against its field cap', () => {
    const output = clean()
    const long = `flowchart LR\n${'  A --> B\n'.repeat(200)}`
    layer(output, 0).diagram = { mermaid: long, links: {} }
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      `TEXT_TOO_LONG layers.0.diagram.mermaid: ${long.length} raw chars, cap ${TEXT_CAPS.diagram}`,
    ])
    // A diagram in the summary does not eat the summary's budget; it answers to the diagram cap.
    const inSummary = clean()
    inSummary.summary = `Short.\n\n\`\`\`mermaid\n${long}\n\`\`\``
    expect(errorsOf(inSummary).map(formatValidationError)).toEqual([
      `TEXT_TOO_LONG summary.diagram: ${long.length} raw chars, cap ${TEXT_CAPS.diagram}`,
    ])
    const fits = clean()
    fits.summary = `${'s'.repeat(TEXT_CAPS.summary - 10)}\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\``
    expect(errorsOf(fits)).toEqual([])
    // A layer title never draws, so its fence counts against the title cap.
    const title = clean()
    layer(title, 0).title = `\`\`\`mermaid\n${'X'.repeat(80)}\n\`\`\``
    expect(errorsOf(title).map(e => e.code)).toEqual(['TEXT_TOO_LONG'])
  })

  it('HUNK_UNASSIGNED: names the hunk, its file, and its header', () => {
    const output = clean()
    layer(output, 1).files = layer(output, 1).files.filter(f => f.path !== 'src/new.ts')
    expect(errorsOf(output)).toEqual([
      {
        code: 'HUNK_UNASSIGNED',
        where: 'hunk:src_new_ts#1',
        message: 'src_new_ts#1 in src/new.ts (@@ -0,0 +1,2 @@) is in no layer',
      },
    ])
  })

  it('HUNK_DUPLICATE: names both layers', () => {
    const output = clean()
    layer(output, 1).files[0]?.hunks.push('src_app_ts#1')
    expect(errorsOf(output)).toEqual([
      {
        code: 'HUNK_DUPLICATE',
        where: 'layer:other',
        message: 'src_app_ts#1 (@@ -1,4 +1,5 @@) is in layer run-path and other',
      },
    ])
  })

  it('HUNK_UNKNOWN: a hunk number past the file, and a hunk id filed under another path', () => {
    const output = clean()
    layer(output, 0).files[0]?.hunks.push('src_app_ts#9')
    expect(errorsOf(output)).toEqual([
      {
        code: 'HUNK_UNKNOWN',
        where: 'layer:run-path',
        message: 'layer run-path: src_app_ts#9 does not exist (src/app.ts has 2 hunks)',
      },
    ])
    const wrongFile = clean()
    const first = layer(wrongFile, 0).files[0]
    const second = layer(wrongFile, 0).files[1]
    if (first && second) {
      second.hunks = ['src_new_name_ts#1', 'src_app_ts#2']
      first.hunks = ['src_app_ts#1']
    }
    layer(wrongFile, 1).files[0] = { path: 'src/app.ts', hunks: ['src_app_ts#2'], annotations: [] }
    expect(errorsOf(wrongFile).map(e => e.code)).toEqual(['HUNK_UNKNOWN'])
    expect(errorsOf(wrongFile)[0]?.message).toBe(
      'layer run-path: src_app_ts#2 belongs to src/app.ts, not src/new-name.ts'
    )
  })

  it('PATH_UNKNOWN: a file that is not in the diff', () => {
    const output = clean()
    layer(output, 1).files.push({ path: 'src/elsewhere.ts', hunks: ['src_elsewhere_ts#1'], annotations: [] })
    expect(errorsOf(output)).toEqual([
      { code: 'PATH_UNKNOWN', where: 'layer:other', message: 'other: src/elsewhere.ts is not in the diff' },
      { code: 'HUNK_UNKNOWN', where: 'layer:other', message: 'other: src_elsewhere_ts#1 does not exist' },
    ])
  })

  it('LAYER_EMPTY: a layer with no files', () => {
    const output = clean()
    output.layers.splice(1, 0, { key: 'empty', title: 'Empty', rationale: '', kind: 'layer', tests: [], files: [] })
    expect(errorsOf(output)).toEqual([
      { code: 'LAYER_EMPTY', where: 'layer:empty', message: 'layer empty has no hunks' },
    ])
  })

  it('LAYER_KEY_DUPLICATE: the second use names the first', () => {
    const output = clean()
    layer(output, 1).key = 'run-path'
    expect(errorsOf(output)).toEqual([
      {
        code: 'LAYER_KEY_DUPLICATE',
        where: 'layer:run-path',
        message: 'layer 2: key "run-path" is also used by layer 1',
      },
    ])
  })

  it('accepts a canvas without an Other layer', () => {
    const output = clean()
    layer(output, 1).kind = 'layer'
    expect(errorsOf(output)).toEqual([])
  })

  it('OTHER_DUPLICATE: a second Other layer names the first', () => {
    const two = clean()
    layer(two, 0).kind = 'other'
    expect(errorsOf(two, { highRisk: [] })).toEqual([
      {
        code: 'OTHER_DUPLICATE',
        where: 'layer:other',
        message: 'layer other is a second Other layer; layer run-path already is one',
      },
      {
        code: 'OTHER_NOT_LAST',
        where: 'layer:run-path',
        message: 'layer run-path (kind other) must be the last layer',
      },
    ])
  })

  it('OTHER_NOT_LAST: Other before a real layer', () => {
    const output = clean()
    output.layers.reverse()
    expect(errorsOf(output)).toEqual([
      { code: 'OTHER_NOT_LAST', where: 'layer:other', message: 'layer other (kind other) must be the last layer' },
    ])
  })

  it('accepts annotation and point anchors on unchanged context lines inside a hunk', () => {
    const output = clean()
    // src_app_ts#1 is @@ -1,4 +1,5 @@; line 1 (`import { a }`) and line 5 (`}`) are context lines.
    const file = layer(output, 0).files[0]
    if (file) {
      file.annotations = [{ side: 'new', startLine: 1, endLine: 1, text: 'context line' }]
    }
    output.points = [{ kind: 'question', level: 'fyi', title: 'Context', path: 'src/app.ts', line: 5, body: 'b' }]
    expect(errorsOf(output)).toEqual([])
  })

  it('TEST_NOT_LAST: a test file before the code of its layer', () => {
    const output = clean()
    const files = layer(output, 0).files
    files.unshift(files.pop() as (typeof files)[number])
    expect(errorsOf(output)).toEqual([
      {
        code: 'TEST_NOT_LAST',
        where: 'layer:run-path',
        message: 'layer run-path: src/app.test.ts precedes src/app.ts',
      },
    ])
  })

  it('TEST_IN_OTHER: a test in Other whose source sits in a real layer', () => {
    const output = clean()
    const test = layer(output, 0).files.pop()
    if (test) {
      layer(output, 1).files.push(test)
    }
    expect(errorsOf(output)).toEqual([
      {
        code: 'TEST_IN_OTHER',
        where: 'layer:other',
        message: 'other: src/app.test.ts covers src/app.ts, which is in layer run-path',
      },
    ])
    // A test whose source is in Other too may stay in Other (after the source).
    const together = clean()
    const other = layer(together, 1)
    const run = layer(together, 0)
    other.files = [
      { path: 'src/app.ts', hunks: ['src_app_ts#1', 'src_app_ts#2'], annotations: [] },
      ...other.files.filter(f => f.path !== 'src/app.ts'),
      { path: 'src/app.test.ts', hunks: ['src_app_test_ts#1'], annotations: [] },
    ]
    run.files = run.files.filter(f => f.path === 'src/new-name.ts')
    run.tests = []
    expect(errorsOf(together)).toEqual([])
  })

  it('RISK_IN_OTHER: a model tag on Other, and a highRisk path in Other', () => {
    const output = clean()
    layer(output, 1).risk = [{ label: 'schema', reason: 'why' }]
    expect(errorsOf(output)).toEqual([
      {
        code: 'RISK_IN_OTHER',
        where: 'layer:other',
        message: 'other: carries the risk tag "schema"; move the hunks to a real layer',
      },
    ])
    expect(errorsOf(clean(), { highRisk: [{ pattern: 'src/gone*', label: 'legacy' }] })).toEqual([
      {
        code: 'RISK_IN_OTHER',
        where: 'layer:other',
        message: 'other: src/gone.ts matches highRisk "src/gone*" (legacy)',
      },
    ])
  })

  it('ANNOTATION_OUTSIDE_HUNK: outside the diff, across hunks, reversed, and in a hunk of another layer', () => {
    const output = clean()
    const file = layer(output, 0).files[0]
    if (!file) {
      throw new Error('no file')
    }
    file.annotations = [
      { side: 'new', startLine: 40, endLine: 41, text: 'far away' },
      { side: 'new', startLine: 4, endLine: 12, text: 'spans two hunks' },
      { side: 'new', startLine: 4, endLine: 3, text: 'reversed' },
      { side: 'new', startLine: 12, endLine: 12, text: 'other layer hunk' },
    ]
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      'ANNOTATION_OUTSIDE_HUNK layer run-path src/app.ts:40-41 (new) is not inside one hunk of the diff (new-side lines 1-5, 11-14)',
      'ANNOTATION_OUTSIDE_HUNK layer run-path src/app.ts:4-12 (new) is not inside one hunk of the diff (new-side lines 1-5, 11-14)',
      'ANNOTATION_OUTSIDE_HUNK layer run-path src/app.ts:4-3 (new): endLine is before startLine',
      'ANNOTATION_OUTSIDE_HUNK layer run-path src/app.ts:12 (new) is in src_app_ts#2, which this layer does not list',
    ])
  })

  it('reports old-side ranges for an annotation on deleted code', () => {
    const output = clean()
    layer(output, 0).files[0]!.annotations = [{ side: 'old', startLine: 99, endLine: 100, text: 'outside' }]
    expect(errorsOf(output)).toEqual([expect.objectContaining({
      code: 'ANNOTATION_OUTSIDE_HUNK',
      message: expect.stringContaining('(old-side lines 1-4, 10-12)'),
    })])
  })

  it('POINT_OUTSIDE_DIFF: unknown path, a line outside every hunk, and a range that leaves its hunk', () => {
    const output = clean()
    output.points = [
      { kind: 'risk', level: 'check', title: 'Nowhere', path: 'src/nope.ts', line: 1, body: 'b' },
      { kind: 'risk', level: 'check', title: 'Far', path: 'src/app.ts', line: 99, side: 'old', body: 'b' },
      { kind: 'risk', level: 'check', title: 'Wide', path: 'src/app.ts', line: 4, endLine: 12, body: 'b' },
      { kind: 'risk', level: 'check', title: 'Back', path: 'src/app.ts', line: 4, endLine: 3, body: 'b' },
    ]
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      'POINT_OUTSIDE_DIFF point 1 "Nowhere": src/nope.ts is not in the diff',
      'POINT_OUTSIDE_DIFF point 2 "Far": src/app.ts:99 (old) is not in the diff (old-side lines 1-4, 10-12)',
      'POINT_OUTSIDE_DIFF point 3 "Wide": src/app.ts:4-12 (new) crosses out of src_app_ts#1 (new-side lines 1-5, 11-14)',
      'POINT_OUTSIDE_DIFF point 4 "Back": endLine is before line',
    ])
  })

  it('TOO_MANY_POINTS: counts the written points plus the missing test entries', () => {
    const output = clean()
    const p = output.points[0]
    if (!p) {
      throw new Error('no point')
    }
    output.points = Array.from({ length: 12 }, (_, i) => ({ ...p, title: `Point ${i}` }))
    expect(errorsOf(output)).toEqual([
      {
        code: 'TOO_MANY_POINTS',
        where: 'points',
        message: '13 attention points (12 written + 1 from missing tests), cap 12',
      },
    ])
  })

  it('TEST_PATH_UNKNOWN: covered without a path, and with a path outside the PR head', () => {
    const output = clean()
    layer(output, 0).tests = [
      { behavior: 'a', status: 'covered' },
      { behavior: 'b', status: 'covered', testPath: 'src/other.test.ts' },
      { behavior: 'c', status: 'not-needed' },
    ]
    expect(errorsOf(output)).toEqual([
      {
        code: 'TEST_PATH_UNKNOWN',
        where: 'layer:run-path',
        message: 'layer run-path: "a" is covered but names no testPath',
      },
      {
        code: 'TEST_PATH_UNKNOWN',
        where: 'layer:run-path',
        message: 'layer run-path: src/other.test.ts is not in the PR head',
      },
    ])
    // A test file that exists at the head without being in the diff is accepted.
    expect(errorsOf(output, { headPaths: new Set(['src/other.test.ts']) })).toEqual([
      {
        code: 'TEST_PATH_UNKNOWN',
        where: 'layer:run-path',
        message: 'layer run-path: "a" is covered but names no testPath',
      },
    ])
    expect(coveredTestPaths(output)).toEqual(['src/other.test.ts'])
    expect(coveredTestPaths({ layers: [{ tests: 'x' }, 7, { tests: [{ status: 'covered' }] }] })).toEqual([])
    expect(coveredTestPaths(null)).toEqual([])
  })

  it('LINK_UNRESOLVED: every markdown field, every link form, and a malformed link', () => {
    const output = clean()
    output.summary = 'See [x](#layer:nope).'
    const l = layer(output, 0)
    l.rationale = 'See #file:src/nope.ts.'
    l.decisions = 'See [h](#hunk:src/app.ts#9).'
    l.checkByHand = 'See [l](#line:src/nope.ts:4) and [m](#line:src/app.ts:400-410) and [o](#line:src/app.ts:8:old).'
    l.tests[0] = {
      behavior: 'run() adds b()',
      status: 'covered',
      testPath: 'src/app.test.ts',
      note: '[t](#hunk:src/app.ts#3)',
    }
    const file = l.files[0]
    if (file) {
      file.note = '[n](#layer:zzz)'
      file.annotations[0] = { side: 'new', startLine: 3, endLine: 4, text: '[a](#hunk:nope)' }
    }
    const p = output.points[0]
    if (p) {
      p.body = 'Bad [b](#file:src/zzz.ts).'
    }
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      'LINK_UNRESOLVED summary: #layer:nope layer nope does not exist',
      'LINK_UNRESOLVED layer run-path rationale: #file:src/nope.ts src/nope.ts is not in the diff',
      'LINK_UNRESOLVED layer run-path decisions: #hunk:src/app.ts#9 src/app.ts#9 does not exist (file has 2 hunks)',
      'LINK_UNRESOLVED layer run-path checkByHand: #line:src/nope.ts:4 src/nope.ts is not in the diff',
      'LINK_UNRESOLVED layer run-path checkByHand: #line:src/app.ts:400-410 src/app.ts:400-410 (new) is not inside one hunk of the diff (new-side lines 1-5, 11-14)',
      'LINK_UNRESOLVED layer run-path checkByHand: #line:src/app.ts:8:old src/app.ts:8 (old) is not inside one hunk of the diff (old-side lines 1-4, 10-12)',
      'LINK_UNRESOLVED layer run-path test "run() adds b()": #hunk:src/app.ts#3 src/app.ts#3 does not exist (file has 2 hunks)',
      'LINK_UNRESOLVED layer run-path src/app.ts note: #layer:zzz layer zzz does not exist',
      'LINK_UNRESOLVED layer run-path src/app.ts annotation 1: #hunk:nope is not one of the four link forms',
      'LINK_UNRESOLVED point 1 "Sum instead of product": #file:src/zzz.ts src/zzz.ts is not in the diff',
    ])
  })

  it('DIAGRAM_NODE_UNKNOWN: a sidecar key names a node the source does not draw', () => {
    const output = clean()
    layer(output, 0).diagram = {
      mermaid: 'stateDiagram-v2\n  [*] --> active\n  active --> purged: blobs deleted',
      links: { active: '#file:src/app.ts', missing: '#file:src/app.ts' },
    }
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      'DIAGRAM_NODE_UNKNOWN layer run-path diagram: "missing" is not a node of the stateDiagram source',
    ])
  })

  it('LINK_UNRESOLVED: a sidecar value is checked like any other link', () => {
    const output = clean()
    layer(output, 0).diagram = {
      mermaid: 'flowchart LR\n  store --> serve',
      links: { store: '#hunk:src/app.ts#9', serve: '#layer:nope' },
    }
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      'LINK_UNRESOLVED layer run-path diagram node "store": #hunk:src/app.ts#9 src/app.ts#9 does not exist (file has 2 hunks)',
      'LINK_UNRESOLVED layer run-path diagram node "serve": #layer:nope layer nope does not exist',
    ])
    // A value that is not a canvas link at all fails the schema, so nothing else runs.
    const external = clean()
    layer(external, 0).diagram = { mermaid: 'flowchart LR\n  store --> serve', links: { store: 'https://x.test' } }
    expect(errorsOf(external).map(e => e.code)).toEqual(['SCHEMA'])
  })

  it('a diagram with resolving links on real nodes passes', () => {
    const output = clean()
    layer(output, 0).diagram = {
      mermaid: 'flowchart LR\n  store[The store] --> serve{Serve}\n  serve --> app',
      links: { store: '#file:src/app.ts', serve: '#hunk:src/app.ts#1', app: '#line:src/app.ts:3-4' },
    }
    expect(errorsOf(output)).toEqual([])
  })

  it('DIAGRAM_LIMIT: at most maxDiagramLinks node links on one diagram', () => {
    const output = clean()
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.maxDiagramLinks + 1 }, (_, i) => [`n${i}`, '#file:src/app.ts'])
    )
    const nodes = Object.keys(many).join(' --> ')
    layer(output, 0).diagram = { mermaid: `flowchart LR\n  ${nodes}`, links: many }
    expect(errorsOf(output).map(formatValidationError)).toEqual([
      `DIAGRAM_LIMIT layer run-path diagram: ${LIMITS.maxDiagramLinks + 1} node links, at most ${LIMITS.maxDiagramLinks}`,
    ])
    expect(errorsOf(output, { limits: { ...LIMITS, maxDiagramLinks: LIMITS.maxDiagramLinks + 1 } })).toEqual([])
  })

  it('names every code once', () => {
    expect(new Set(VALIDATION_CODES).size).toBe(VALIDATION_CODES.length)
  })

  it('accepts the committed PR #278 canvas against its own hunk index', async () => {
    const artifact = ReviewArtifactSchema.parse(
      JSON.parse(await readFile(path.join(PACKAGE_ROOT, '__fixtures__/pr-278/review.json'), 'utf8'))
    )
    const { config } = await import('../project-config.js').then(m =>
      m.loadProjectConfig(PACKAGE_ROOT)
    )
    const result = validateModelOutput(artifactToModelOutput(artifact), {
      files: artifact.files,
      caps: TEXT_CAPS,
      limits: LIMITS,
      highRisk: config.highRisk,
    })
    expect(result.errors.map(formatValidationError)).toEqual([])
    expect(result.ok).toBe(true)
  })
})
