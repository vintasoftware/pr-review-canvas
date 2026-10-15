// @vitest-environment node
import { TEXT_CAPS } from '../contract/review-artifact.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import {
  artifactToModelOutput,
  fingerprint,
  layerIdForLine,
  type NormalizeInput,
  normalize,
  normalizeTitle,
} from './normalize.js'

const FILES = SYNTHETIC_FILES.map(toFileEntry)

function input(): NormalizeInput {
  return {
    pr: syntheticArtifact().pr,
    files: FILES,
    patches: toPatchMap(SYNTHETIC_FILES),
    highRisk: [
      { pattern: 'src/new-name.ts', label: 'rename' },
      { pattern: 'src/*.ts', label: 'rename' },
      { pattern: 'src/app.ts', label: 'core' },
    ],
    caps: TEXT_CAPS,
    generatedAt: '2026-09-10T12:00:00.000Z',
    generator: { agent: 'claude', model: 'm', harness: 'claude-code', attempts: 2 },
  }
}

describe('normalize', () => {
  it('preserves fold descriptions when converting between model output and a saved artifact', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    const file = output.layers[0]?.files.find(entry => entry.path === 'src/app.test.ts')
    if (file === undefined) {
      throw new Error('missing test file')
    }

    file.collapsed = 'moderate'
    file.folds = [{ title: 'runs', side: 'new', startLine: 2, endLine: 4, level: 'light' }]
    const saved = normalize(output, input())
    const restored = artifactToModelOutput(saved)

    expect(restored.layers[0]?.files.find(entry => entry.path === 'src/app.test.ts')).toEqual(file)
  })

  it('keeps the levels the model named on folds and on a collapsed file', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    const file = output.layers[0]?.files.find(entry => entry.path === 'src/app.test.ts')
    if (file === undefined) {
      throw new Error('missing test file')
    }

    file.collapsed = 'aggressive'
    file.folds = [{ title: 'runs', side: 'new', startLine: 2, endLine: 4, level: 'moderate' }]
    const saved = normalize(output, input())
    const stored = saved.layers[0]?.files.find(entry => entry.path === 'src/app.test.ts')

    expect(stored?.collapsed).toBe('aggressive')
    expect(stored?.folds?.[0]?.level).toBe('moderate')
  })

  it('assigns ids, marks tests, tags risk from config and model, and adds one point per missing test', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    const first = output.layers[0]
    if (first) {
      first.risk = [{ label: 'perf', reason: 'hot path' }]
    }
    const artifact = normalize(output, input())
    const expectedPoints = [
      {
        id: 'p-1',
        kind: 'decision',
        level: 'decide',
        title: 'Sum instead of product',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        body: 'Look at the operator because the spec is ambiguous; if the spec says sum, this is fine.',
        fingerprint: fingerprint({ kind: 'decision', path: 'src/app.ts', title: 'Sum instead of product' }),
        origin: 'model',
        layerId: 'run-path',
        audience: 'reviewer',
      },
      {
        id: 'p-2',
        kind: 'tests',
        level: 'check',
        title: 'other() returns x',
        path: 'src/app.ts',
        line: 1,
        side: 'new',
        body: 'The layer "Run path" lists this behavior without a test. y is unused',
        fingerprint: fingerprint({ kind: 'tests', path: 'src/app.ts', title: 'other() returns x' }),
        origin: 'tests',
        layerId: 'run-path',
        audience: 'author',
      },
      {
        id: 'p-3',
        kind: 'debt',
        level: 'fyi',
        title: 'Deleted file had no owner',
        path: 'src/gone.ts',
        line: 1,
        side: 'old',
        body: 'Nothing imports it any more.',
        fingerprint: fingerprint({ kind: 'debt', path: 'src/gone.ts', title: 'Deleted file had no owner' }),
        origin: 'model',
        layerId: 'other',
        audience: 'author',
      },
    ]
    expect(artifact).toEqual({
      version: 1,
      pr: syntheticArtifact().pr,
      files: FILES,
      summary: syntheticArtifact().summary,
      risk: [
        { label: 'rename', source: 'config' },
        { label: 'core', source: 'config' },
        { label: 'perf', source: 'model', reason: 'hot path' },
      ],
      layers: [
        {
          ...syntheticArtifact().layers[0],
          risk: [
            { label: 'rename', source: 'config' },
            { label: 'core', source: 'config' },
            { label: 'perf', source: 'model', reason: 'hot path' },
          ],
        },
        {
          ...syntheticArtifact().layers[1],
          risk: [
            { label: 'rename', source: 'config' },
            { label: 'core', source: 'config' },
          ],
        },
      ],
      points: expectedPoints,
      generatedAt: '2026-09-10T12:00:00.000Z',
      generator: { agent: 'claude', model: 'm', harness: 'claude-code', attempts: 2 },
      source: 'local',
    })
  })

  it('sorts points by level then path then line and keeps model tags a config rule already set once', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    output.points = [
      {
        kind: 'risk',
        level: 'fyi',
        audience: 'reviewer',
        title: 'b',
        path: 'src/new.ts',
        line: 2,
        body: 'x',
      },
      {
        kind: 'risk',
        level: 'decide',
        audience: 'reviewer',
        title: 'a',
        path: 'src/new.ts',
        line: 1,
        body: 'x',
      },
      {
        kind: 'risk',
        level: 'fyi',
        audience: 'reviewer',
        title: 'c',
        path: 'src/gone.ts',
        line: 1,
        side: 'old',
        body: 'x',
      },
      {
        kind: 'risk',
        level: 'fyi',
        audience: 'reviewer',
        title: 'd',
        path: 'src/new.ts',
        line: 1,
        body: 'x',
      },
    ]
    const first = output.layers[0]
    if (first) {
      first.risk = [{ label: 'core', reason: 'dup of config' }]
    }
    const artifact = normalize(output, input())
    expect(artifact.points.map(p => [p.id, p.title])).toEqual([
      ['p-1', 'a'],
      ['p-2', 'other() returns x'],
      ['p-3', 'c'],
      ['p-4', 'd'],
      ['p-5', 'b'],
    ])
    expect(artifact.layers[0]?.risk).toEqual([
      { label: 'rename', source: 'config' },
      { label: 'core', source: 'config' },
    ])
  })

  it('anchors a tests point on the old side when the first hunk is a pure deletion, and skips a layer with no hunk', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    const other = output.layers[1]
    if (!other) {
      throw new Error('no other')
    }
    other.files = [other.files[2] as (typeof other.files)[number], ...other.files.slice(0, 2)]
    other.tests = [{ behavior: 'removal is safe', status: 'missing' }]
    const artifact = normalize(output, input())
    const testPoint = artifact.points.find(p => p.title === 'removal is safe')
    expect(testPoint).toMatchObject({ path: 'src/gone.ts', line: 1, side: 'old', layerId: 'other' })
    const orphan = artifactToModelOutput(syntheticArtifact())
    orphan.layers[0]?.tests.push({ behavior: 'z', status: 'missing' })
    const gone = normalize(orphan, { ...input(), files: FILES.filter(f => f.path !== 'src/app.ts') })
    expect(gone.points.filter(p => p.origin === 'tests')).toEqual([
      expect.objectContaining({ title: 'z', path: 'src/new-name.ts' }),
    ])
    expect(gone.points.find(p => p.path === 'src/app.ts')?.layerId).toBeUndefined()
  })

  it('cuts a long behavior to the title cap', () => {
    const output = artifactToModelOutput(syntheticArtifact())
    output.layers[0]?.tests.push({ behavior: 'b'.repeat(120), status: 'missing' })
    const artifact = normalize(output, input())
    const long = artifact.points.find(p => p.title.startsWith('Missing test'))
    expect(long?.title).toBe('Missing test…')
  })

  it('adds one resolved point for each settled decision in the diff, titled by the decision', () => {
    const commit = 'c'.repeat(40)
    const decision = (id: string, text: string, line: number | null) => ({
      id,
      commit,
      date: '2026-10-13T10:00:00-03:00',
      text,
      path: 'src/app.ts',
      side: 'new' as const,
      line,
    })
    const long = `keep the sum ${'because the spec says so '.repeat(5)}`.trim()
    const unbroken = 'x'.repeat(TEXT_CAPS.pointTitle + 5)
    const artifact = normalize(artifactToModelOutput(syntheticArtifact()), {
      ...input(),
      decisions: [
        decision('c-1', long, 2),
        decision('c-2', unbroken, 4),
        decision('c-3', 'not in the diff', null),
      ],
    })
    const points = artifact.points.filter(point => point.origin === 'decision')
    expect(points.map(point => [point.title, point.line, point.layerId])).toEqual([
      [
        `${long
          .slice(0, TEXT_CAPS.pointTitle - 1)
          .replace(/\S*$/, '')
          .trimEnd()}…`,
        2,
        'run-path',
      ],
      ['Settled decision…', 4, 'run-path'],
    ])
    expect(points[0]).toMatchObject({
      kind: 'decision',
      level: 'fyi',
      audience: 'author',
      side: 'new',
      body: 'The author settled this in commit `ccccccc` on 2026-10-13.',
    })
    expect(artifact.settled).toEqual({
      [points[0]!.fingerprint]: { reason: long, at: '2026-10-13T10:00:00-03:00', commit },
      [points[1]!.fingerprint]: { reason: unbroken, at: '2026-10-13T10:00:00-03:00', commit },
    })
    // They are publish's, so a saved canvas hands none of them back to the generator.
    expect(artifactToModelOutput(artifact).points.map(point => point.title)).not.toContain(
      'Settled decision…'
    )
  })

  it('keeps the fingerprint stable across spacing and case, and distinct across kind or path', () => {
    const a = fingerprint({ kind: 'risk', path: 'src/a.ts', title: 'Retry  loop' })
    expect(fingerprint({ kind: 'risk', path: 'src/a.ts', title: '  retry LOOP ' })).toBe(a)
    expect(fingerprint({ kind: 'debt', path: 'src/a.ts', title: 'Retry loop' })).not.toBe(a)
    expect(fingerprint({ kind: 'risk', path: 'src/b.ts', title: 'Retry loop' })).not.toBe(a)
    expect(normalizeTitle('  A\tB  c ')).toBe('a b c')
    expect(a).toMatch(/^[0-9a-f]{40}$/)
  })

  it('finds the layer owning a line, or undefined outside the diff', () => {
    const layers = syntheticArtifact().layers
    expect(layerIdForLine(layers, FILES, 'src/app.ts', 'new', 12)).toBe('other')
    expect(layerIdForLine(layers, FILES, 'src/app.ts', 'new', 99)).toBeUndefined()
    expect(layerIdForLine(layers, FILES, 'nope.ts', 'new', 1)).toBeUndefined()
  })

  it('preserves model risk reasons across a saved-artifact round trip and excludes config tags', () => {
    const saved = syntheticArtifact()
    saved.layers[0]!.risk = [
      { label: 'auth', source: 'config' },
      { label: 'perf', source: 'model', reason: 'hot path' },
      { label: 'data', source: 'model' },
    ]
    const model = artifactToModelOutput(saved)
    expect(model.layers[0]?.risk).toEqual([
      { label: 'perf', reason: 'hot path' },
      { label: 'data', reason: '' },
    ])
    expect(normalize(model, { ...input(), highRisk: [] }).layers[0]?.risk).toEqual([
      { label: 'perf', source: 'model', reason: 'hot path' },
      { label: 'data', source: 'model', reason: '' },
    ])
  })

  it('skips synthetic missing-test points when the layer has no files to anchor them to', () => {
    const model = artifactToModelOutput(syntheticArtifact())
    model.layers[0]!.files = []
    const saved = normalize(model, input())
    expect(saved.points.some(point => point.origin === 'tests')).toBe(false)
  })

  it('round-trips through artifactToModelOutput and normalize', () => {
    const original = syntheticArtifact()
    const model = artifactToModelOutput(original)
    expect(model.layers[0]?.risk).toBeUndefined()
    expect(model.points.map(p => p.title)).toEqual(['Sum instead of product', 'Deleted file had no owner'])
    const again = normalize(model, {
      ...input(),
      highRisk: [{ pattern: 'src/new-name.ts', label: 'schema' }],
    })
    expect(again.layers.map(l => ({ ...l, risk: undefined }))).toEqual(
      original.layers.map(l => ({ ...l, risk: undefined }))
    )
    expect(again.points.map(p => [p.kind, p.path, p.line, p.layerId])).toEqual(
      original.points
        .map(p => [p.kind, p.path, p.line, p.layerId])
        .map(x => (x[0] === 'tests' ? ['tests', 'src/app.ts', 1, 'run-path'] : x))
    )
  })
})
