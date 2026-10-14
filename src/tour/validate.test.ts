// @vitest-environment node
import { toFileEntry } from '../git/diff-collector.js'
import { TOUR_CAPS, type TourModel } from '../contract/tour.js'
import { SYNTHETIC_FILES } from '../testing/synthetic.js'
import { syntheticTourModel } from '../testing/synthetic-tour.js'
import { type TourValidationInput, validateTourModel } from './validate.js'

const files = SYNTHETIC_FILES.map(toFileEntry)

function input(over: Partial<TourValidationInput> = {}): TourValidationInput {
  return {
    files,
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

  it('requires a state landmark for stored data, with or without a decision on it', () => {
    const model = syntheticTourModel()
    expect(codes(model, { stateRequired: true })).toEqual(['STATE_LANDMARK_MISSING'])
    const state = withLandmark(model, 2, { state: true })
    expect(codes(state, { stateRequired: true })).toEqual([])
    // A change that undoes cleanly spends no decision on reversibility.
    const noTradeOff = { ...state, decisions: [{ ...state.decisions[0]!, category: 'product' as const }] }
    expect(codes(noTradeOff, { stateRequired: true })).toEqual([])
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
    // Backticks in a plain-text field show as written, so they are refused there.
    const ticked = validateTourModel(
      withLandmark(model, 2, { title: 'Sum, not `a() * b()`' }),
      input()
    ).errors
    expect(ticked.map(e => [e.code, e.where])).toEqual([['MARKUP_IN_PLAIN_TEXT', 'landmarks.2.title']])
    const decision = { ...model.decisions[0]!, title: '`sum` over product?' }
    expect(codes({ ...model, decisions: [decision] })).toEqual(['MARKUP_IN_PLAIN_TEXT'])
    // A body has at most two paragraphs: the picture carries the rest.
    const three = validateTourModel(withLandmark(model, 2, { body: ['one', 'two', 'three'] }), input()).errors
    expect(three.map(e => [e.code, e.where])).toEqual([['TEXT_TOO_LONG', 'landmarks.2.body']])
  })

  it('checks every reference into the diff: code paths, chunks, anchors, landmarks', () => {
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

  it('gives every landmark a picture: a scene, or a micro-world standing in for it past the background', () => {
    const model = syntheticTourModel()
    const bare = (i: number) => withLandmark(model, i, { scene: undefined, micro: undefined })
    expect(codes(bare(2))).toEqual(['PICTURE_MISSING'])
    expect(validateTourModel(bare(2), input()).errors[0]?.message).toMatch(
      /<scenes>\/sum\.micro\.html to stand in/
    )
    const micro = '<div class="scene"><label><input type="radio" name="a"> a</label><p>t</p></div>'
    expect(codes(withLandmark(model, 2, { scene: undefined, micro }))).toEqual([])
    expect(codes(withLandmark(model, 0, { scene: undefined, micro }))).toEqual(['PICTURE_MISSING'])
    expect(validateTourModel(bare(0), input()).errors[0]?.message).toMatch(/the background has no scene/)
  })

  it('checks scenes and micro-worlds against the frame, and allows two micro-worlds', () => {
    const model = syntheticTourModel()
    expect(
      codes(
        withLandmark(model, 0, {
          scene: '<div class="scene" data-technique="screen"><img src="x.png"><p>t</p></div>',
        })
      )
    ).toEqual(['SCENE_INVALID', 'SCENE_INVALID'])
    const micro = '<div class="scene"><label><input type="radio" name="a"> a</label><p>t</p></div>'
    expect(codes(withLandmark(model, 1, { micro }))).toEqual([])
    const two = withLandmark(withLandmark(model, 1, { micro }), 2, { micro })
    expect(codes(two)).toEqual([])
    expect(codes(withLandmark(two, 3, { micro }))).toEqual(['MICRO_LIMIT'])
    expect(
      codes(withLandmark(model, 1, { micro }), {
        options: { microWorld: false, tryIt: true, finalQuiz: 'on' },
      })
    ).toEqual(['MICRO_LIMIT'])
    expect(codes(withLandmark(model, 1, { micro: '<div class="scene"><form><input></form></div>' }))).toEqual(
      ['MICRO_INVALID', 'MICRO_INVALID']
    )
  })

  it('names each scene technique, and refuses a third scene of one technique', () => {
    const model = syntheticTourModel()
    expect(codes(withLandmark(model, 0, { scene: '<div class="scene"><p>no technique</p></div>' }))).toEqual([
      'SCENE_INVALID',
    ])
    const sequence = '<div class="scene" data-technique="sequence"><p>a then b</p></div>'
    const twice = withLandmark(withLandmark(model, 0, { scene: sequence }), 1, { scene: sequence })
    expect(codes(twice)).toEqual([])
    const thrice = validateTourModel(withLandmark(twice, 2, { scene: sequence }), input())
    expect(thrice.errors.map(e => e.code)).toEqual(['SCENE_REPEATED'])
    expect(thrice.errors[0]?.message).toMatch(
      /^landmarks\.0, landmarks\.1, landmarks\.2: 3 scenes draw "sequence"/
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
})
