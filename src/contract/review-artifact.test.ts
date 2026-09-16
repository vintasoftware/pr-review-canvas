// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../server/context.js'
import { syntheticArtifact } from '../testing/synthetic.js'
import {
  ARTIFACT_HARD_CAPS,
  ARTIFACT_MAX_POINTS,
  effectiveCaps,
  HARD_CAP_FACTOR,
  hardCaps,
  LIMITS,
  ModelOutputSchema,
  modelOutputSchema,
  type ReviewArtifact,
  ReviewArtifactSchema,
  TEXT_CAP_KEYS,
  TEXT_CAPS,
} from './review-artifact.js'

async function loadFixture(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(PACKAGE_ROOT, '__fixtures__/pr-278/review.json'), 'utf8'))
}

describe('ReviewArtifactSchema', () => {
  it('accepts the PR #278 fixture unchanged', async () => {
    const raw = await loadFixture()
    const parsed = ReviewArtifactSchema.parse(raw)
    expect(parsed).toEqual(raw)
  })

  it('accepts the synthetic artifact and round-trips it', () => {
    const artifact = syntheticArtifact()
    expect(ReviewArtifactSchema.parse(artifact)).toEqual(artifact)
  })

  it('reads back an artifact written under raised caps, but stops at the hard ceilings', () => {
    const artifact = syntheticArtifact()
    const point = artifact.points[0]
    if (point === undefined) {
      throw new Error('fixture has no points')
    }
    const raised: ReviewArtifact = {
      ...artifact,
      summary: 'x'.repeat(TEXT_CAPS.summary + 1),
      points: Array.from({ length: LIMITS.maxPoints + 1 }, (_, i) => ({ ...point, id: `p-${i}` })),
    }
    expect(ReviewArtifactSchema.parse(raised)).toEqual(raised)
    expect(ARTIFACT_HARD_CAPS.summary).toBe(4800)
    expect(ARTIFACT_MAX_POINTS).toBe(48)
    const unbounded = {
      ...artifact,
      summary: 'x'.repeat(ARTIFACT_HARD_CAPS.summary + 1),
      points: Array.from({ length: ARTIFACT_MAX_POINTS + 1 }, (_, i) => ({ ...point, id: `p-${i}` })),
    }
    const result = ReviewArtifactSchema.safeParse(unbounded)
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.path.join('.')).sort()).toEqual(['points', 'summary'])
  })

  it('rejects a head sha that is not 40 hex chars', () => {
    const artifact = syntheticArtifact()
    const result = ReviewArtifactSchema.safeParse({ ...artifact, pr: { ...artifact.pr, headSha: 'abc' } })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.path.join('.'))).toEqual(['pr.headSha'])
  })
})

describe('ModelOutputSchema', () => {
  const layer = {
    key: 'run-path',
    title: 'Run path',
    rationale: 'ok',
    kind: 'layer',
    tests: [],
    files: [{ path: 'src/app.ts', hunks: ['src_app_ts#1'], annotations: [] }],
  }

  it('accepts a minimal model output', () => {
    const parsed = ModelOutputSchema.parse({ summary: 'x', layers: [layer], points: [] })
    expect(parsed).toEqual({ summary: 'x', layers: [layer], points: [] })
  })

  it('drops layerId from model points: publish assigns it', () => {
    const point = { kind: 'risk', level: 'check', title: 't', path: 'src/app.ts', line: 1, body: 'b' }
    const parsed = ModelOutputSchema.parse({
      summary: 'x',
      layers: [layer],
      points: [{ ...point, layerId: 'l1' }],
    })
    expect(parsed.points).toEqual([point])
  })

  it('reports each capped field by name when it passes the hard limit (four times its cap)', () => {
    const over = (n: number) => n * HARD_CAP_FACTOR + 1
    const result = ModelOutputSchema.safeParse({
      summary: 'x'.repeat(over(TEXT_CAPS.summary)),
      layers: [
        {
          ...layer,
          title: 't'.repeat(over(TEXT_CAPS.layerTitle)),
          rationale: 'r'.repeat(over(TEXT_CAPS.rationale)),
          decisions: 'd'.repeat(over(TEXT_CAPS.decisions)),
          checkByHand: 'c'.repeat(over(TEXT_CAPS.checkByHand)),
          tests: [{ behavior: 'b'.repeat(over(TEXT_CAPS.testBehavior)), status: 'covered' }],
          files: [
            {
              path: 'src/app.ts',
              hunks: ['src_app_ts#1'],
              annotations: [
                { side: 'new', startLine: 1, endLine: 1, text: 'a'.repeat(over(TEXT_CAPS.annotation)) },
              ],
            },
          ],
        },
      ],
      points: [
        {
          kind: 'risk',
          level: 'check',
          title: 'p'.repeat(over(TEXT_CAPS.pointTitle)),
          path: 'src/app.ts',
          line: 1,
          body: 'q'.repeat(over(TEXT_CAPS.pointBody)),
        },
      ],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.path.join('.')).sort()).toEqual(
      [
        'summary',
        'layers.0.title',
        'layers.0.rationale',
        'layers.0.decisions',
        'layers.0.checkByHand',
        'layers.0.tests.0.behavior',
        'layers.0.files.0.annotations.0.text',
        'points.0.title',
        'points.0.body',
      ].sort()
    )
  })

  it('accepts decisions and checkByHand as optional markdown and rejects them empty', () => {
    const withBoth = { ...layer, decisions: 'Sum over product.', checkByHand: 'Open the page.' }
    expect(ModelOutputSchema.parse({ summary: 'x', layers: [withBoth], points: [] }).layers[0]).toEqual(
      withBoth
    )
    const result = ModelOutputSchema.safeParse({
      summary: 'x',
      layers: [{ ...layer, decisions: '' }],
      points: [],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.path.join('.'))).toEqual(['layers.0.decisions'])
  })

  it('applies the caps of the project config through modelOutputSchema and effectiveCaps', () => {
    const caps = effectiveCaps({ summary: 5, rationale: undefined })
    expect(caps).toEqual({ ...TEXT_CAPS, summary: 5 })
    expect(effectiveCaps(undefined)).toEqual(TEXT_CAPS)
    // The schema stops raw text at four times the cap; the validator measures the visible text.
    const schema = modelOutputSchema(caps)
    expect(hardCaps(caps).summary).toBe(20)
    expect(schema.safeParse({ summary: 'x'.repeat(21), layers: [layer], points: [] }).success).toBe(false)
    expect(schema.safeParse({ summary: 'x'.repeat(20), layers: [layer], points: [] }).success).toBe(true)
    // A layer without files and more than the limit of points are for the validator to name.
    const parsed = ModelOutputSchema.safeParse({ summary: '', layers: [{ ...layer, files: [] }], points: [] })
    expect(parsed.success).toBe(true)
  })

  it('rejects a layer key that is not a slug', () => {
    const result = ModelOutputSchema.safeParse({
      summary: '',
      layers: [{ ...layer, key: 'Run Path' }],
      points: [],
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues.map(i => i.path.join('.'))).toEqual(['layers.0.key'])
  })
})

describe('constants', () => {
  it('lists every cap key once', () => {
    expect([...TEXT_CAP_KEYS].sort()).toEqual(Object.keys(TEXT_CAPS).sort())
  })

  it('keeps the caps and limits the plan fixed', () => {
    expect(TEXT_CAPS).toEqual({
      summary: 1200,
      layerTitle: 60,
      rationale: 300,
      decisions: 600,
      checkByHand: 400,
      annotation: 240,
      pointTitle: 90,
      pointBody: 600,
      testBehavior: 120,
      diagram: 1500,
    })
    expect(LIMITS).toEqual({ maxPoints: 12, maxDiagramsPerLayer: 1, maxDiagramLinks: 12 })
  })
})
