// @vitest-environment node
import { toFileEntry } from '../git/diff-collector.js'
import { TOUR_CAPS, type TourModel } from '../contract/tour.js'
import { SYNTHETIC_FILES } from '../testing/synthetic.js'
import { syntheticTourModel } from '../testing/synthetic-tour.js'
import { guardPaths, type TourValidationInput, validateTourModel } from './validate.js'

const files = SYNTHETIC_FILES.map(toFileEntry)

function input(over: Partial<TourValidationInput> = {}): TourValidationInput {
  return {
    files,
    headPaths: new Set(),
    caps: { ...TOUR_CAPS },
    budget: { landmarks: 4, decisions: 2, quiz: 2 },
    categories: ['trade-off', 'architecture', 'product', 'pokayoke', 'nfr', 'spec'],
    stateRequired: false,
    options: { microWorld: true, tryIt: true, finalQuiz: 'on' },
    ...over,
  }
}

function codes(model: unknown, over: Partial<TourValidationInput> = {}): string[] {
  return validateTourModel(model, input(over)).errors.map(e => e.code)
}

function withLandmark(
  model: TourModel,
  index: number,
  patch: Partial<TourModel['landmarks'][number]>
): TourModel {
  const landmarks = model.landmarks.map((l, i) => (i === index ? { ...l, ...patch } : l))
  return { ...model, landmarks }
}

describe('validateTourModel', () => {
  it('passes the synthetic tour and returns it as the output', () => {
    const result = validateTourModel(syntheticTourModel(), input())
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.output?.landmarks.map(l => l.id)).toEqual(['before', 'world', 'sum', 'respect'])
  })

  it('reports a schema problem with its path and returns no output', () => {
    const result = validateTourModel({ landmarks: 'no' }, input())
    expect(result.ok).toBe(false)
    expect(result.output).toBeNull()
    expect(result.errors[0]?.code).toBe('SCHEMA')
    expect(result.errors[0]?.where).toBe('landmarks')
  })

  it('holds the landmarks to the background, world, whys, respect order', () => {
    const model = syntheticTourModel()
    expect(
      codes({
        ...model,
        landmarks: [model.landmarks[1], model.landmarks[0], model.landmarks[2], model.landmarks[3]],
      })
    ).toContain('LANDMARK_ORDER')
    expect(codes(withLandmark(model, 2, { stage: 'background' }))).toContain('LANDMARK_ORDER')
    expect(codes(withLandmark(model, 3, { stage: 'why' }))).toContain('LANDMARK_ORDER')
  })

  it('holds the tour to its budget, and lets a state landmark through it', () => {
    const model = syntheticTourModel()
    expect(codes(model, { budget: { landmarks: 3, decisions: 2, quiz: 2 } })).toEqual(['LANDMARK_BUDGET'])
    const state = withLandmark(model, 2, { state: true })
    expect(codes(state, { budget: { landmarks: 3, decisions: 2, quiz: 2 } })).toEqual([])
    expect(codes(model, { budget: { landmarks: 4, decisions: 0, quiz: 0 } })).toEqual([
      'DECISION_BUDGET',
      'QUIZ_BUDGET',
    ])
  })

  it('requires a state landmark for stored data, with a reversibility trade-off on it', () => {
    const model = syntheticTourModel()
    expect(codes(model, { stateRequired: true })).toEqual(['STATE_LANDMARK_MISSING'])
    const state = withLandmark(model, 2, { state: true })
    expect(codes(state, { stateRequired: true })).toEqual([])
    const noTradeOff = { ...state, decisions: [{ ...state.decisions[0]!, category: 'product' as const }] }
    expect(codes(noTradeOff, { stateRequired: true })).toEqual(['STATE_LANDMARK_MISSING'])
  })

  it('measures every text a reader sees against its cap', () => {
    const model = syntheticTourModel()
    const long = 'x'.repeat(TOUR_CAPS.lead + 1)
    expect(codes(withLandmark(model, 0, { lead: long }))).toEqual(['TEXT_TOO_LONG'])
    // Backticks do not count.
    const fenced = `\`${'x'.repeat(TOUR_CAPS.lead - 2)}\``
    expect(codes(withLandmark(model, 0, { lead: fenced }))).toEqual([])
    const errors = validateTourModel(
      withLandmark(model, 1, { literate: ['y'.repeat(TOUR_CAPS.paragraph + 1), { chunk: 0 }] }),
      input()
    ).errors
    expect(errors.map(e => e.where)).toEqual(['landmarks.1.literate.0'])
  })

  it('checks every reference into the diff: code paths, chunks, anchors, guards, landmarks', () => {
    const model = syntheticTourModel()
    expect(
      codes(withLandmark(model, 1, { code: [{ path: 'src/nope.ts', diff: '@@ -1 +1 @@\n+x' }] }))
    ).toEqual(['PATH_UNKNOWN'])
    expect(codes(withLandmark(model, 1, { code: [{ path: 'src/app.ts', diff: 'not a hunk' }] }))).toEqual([
      'CHUNK_UNKNOWN',
    ])
    expect(codes(withLandmark(model, 1, { literate: [{ chunk: 3 }] }))).toEqual(['CHUNK_UNKNOWN'])
    expect(
      codes(withLandmark(model, 1, { literate: [{ path: 'src/nope.ts', diff: '@@ -1 +1 @@\n+x' }] }))
    ).toEqual(['PATH_UNKNOWN'])
    expect(
      codes(withLandmark(model, 1, { guards: [{ testPath: 'src/other.test.ts', behavior: 'x' }] }))
    ).toEqual(['GUARD_PATH_UNKNOWN'])
    expect(
      codes(withLandmark(model, 1, { guards: [{ testPath: 'src/other.test.ts', behavior: 'x' }] }), {
        headPaths: new Set(['src/other.test.ts']),
      })
    ).toEqual([])
    const decision = model.decisions[0]!
    expect(
      codes({ ...model, decisions: [{ ...decision, anchor: { path: 'src/app.ts', line: 40 } }] })
    ).toEqual(['ANCHOR_OUTSIDE_DIFF'])
    expect(
      codes({ ...model, decisions: [{ ...decision, anchor: { path: 'src/nope.ts', line: 1 } }] })
    ).toEqual(['ANCHOR_OUTSIDE_DIFF'])
    expect(codes({ ...model, decisions: [{ ...decision, landmark: 'before' }] })).toEqual([
      'LANDMARK_UNKNOWN',
    ])
    expect(codes({ ...model, decisions: [{ ...decision, landmark: 'nope' }] })).toEqual(['LANDMARK_UNKNOWN'])
    expect(codes({ ...model, quiz: [{ ...model.quiz[0]!, landmark: 'nope' }] })).toEqual(['LANDMARK_UNKNOWN'])
  })

  it('refuses duplicate ids and keys', () => {
    const model = syntheticTourModel()
    expect(codes(withLandmark(model, 2, { id: 'world' }))).toContain('ID_DUPLICATE')
    expect(codes({ ...model, decisions: [model.decisions[0]!, { ...model.decisions[0]! }] })).toEqual([
      'ID_DUPLICATE',
    ])
  })

  it('checks scenes and micro-worlds against the frame, and allows one micro-world', () => {
    const model = syntheticTourModel()
    expect(
      codes(withLandmark(model, 0, { scene: '<div class="scene"><img src="x.png"><p>t</p></div>' }))
    ).toEqual(['SCENE_INVALID', 'SCENE_INVALID'])
    const micro = '<div class="scene"><label><input type="radio" name="a"> a</label><p>t</p></div>'
    expect(codes(withLandmark(model, 1, { micro }))).toEqual([])
    expect(codes(withLandmark(withLandmark(model, 1, { micro }), 2, { micro }))).toEqual(['MICRO_LIMIT'])
    expect(
      codes(withLandmark(model, 1, { micro }), {
        options: { microWorld: false, tryIt: true, finalQuiz: 'on' },
      })
    ).toEqual(['MICRO_LIMIT'])
    expect(codes(withLandmark(model, 1, { micro: '<div class="scene"><form><input></form></div>' }))).toEqual(
      ['MICRO_INVALID', 'MICRO_INVALID']
    )
  })

  it('refuses a category the project turned off and an unverified try-it', () => {
    const model = syntheticTourModel()
    expect(codes(model, { categories: ['product'] })).toEqual(['CATEGORY_OFF'])
    const tryIt = { steps: ['pnpm start'], look: ['the total'], verified: false }
    expect(codes({ ...model, decisions: [{ ...model.decisions[0]!, tryIt }] })).toEqual(['TRY_IT_UNVERIFIED'])
    expect(
      codes({ ...model, decisions: [{ ...model.decisions[0]!, tryIt: { ...tryIt, verified: true } }] })
    ).toEqual([])
    expect(
      codes(
        { ...model, decisions: [{ ...model.decisions[0]!, tryIt: { ...tryIt, verified: true } }] },
        { options: { microWorld: true, tryIt: false, finalQuiz: 'on' } }
      )
    ).toEqual(['TRY_IT_UNVERIFIED'])
  })

  it('lists the guard paths of a raw model, for the head lookup', () => {
    expect(guardPaths(syntheticTourModel())).toEqual(['src/app.test.ts'])
    expect(
      guardPaths({ landmarks: [{ guards: 'no' }, { guards: [{ testPath: '' }, { testPath: 'a' }] }] })
    ).toEqual(['a'])
    expect(guardPaths(null)).toEqual([])
  })
})
