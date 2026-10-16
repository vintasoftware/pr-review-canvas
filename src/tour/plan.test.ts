// @vitest-environment node
import { freshReaderState, type TourReaderState } from '../contract/tour-api.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import {
  buildTourPrompt,
  pickSettled,
  planOf,
  unansweredQuiz,
  unsettledDecisions,
  worldLandmark,
} from './plan.js'

function reader(over: Partial<TourReaderState> = {}): TourReaderState {
  return { ...freshReaderState(), ...over }
}

describe('pickSettled', () => {
  it('needs an approved side, or something else with its restatement', () => {
    expect(pickSettled(undefined)).toBe(false)
    expect(pickSettled({ pick: 'keep', approved: false })).toBe(false)
    expect(pickSettled({ pick: 'keep', approved: true })).toBe(true)
    expect(pickSettled({ pick: 'change', approved: true })).toBe(true)
    expect(pickSettled({ pick: 'other', approved: true })).toBe(false)
    expect(
      pickSettled({
        pick: 'other',
        approved: true,
        restatement: { what: 'w', where: ['x'], unchanged: 'u' },
      })
    ).toBe(true)
  })
})

describe('planOf', () => {
  it('splits settled picks into changes and keeps, and lists the notes with text', () => {
    const tour = syntheticTour()
    const plan = planOf(
      tour,
      reader({
        picks: { 'sum-over-product': { pick: 'keep', approved: true } },
        notes: { world: '  a thought ', sum: '   ' },
      })
    )
    expect(plan.kept.map(e => e.decision.key)).toEqual(['sum-over-product'])
    expect(plan.changes).toEqual([])
    expect(plan.notes).toEqual([{ landmark: tour.landmarks[1], text: 'a thought' }])
    expect(unsettledDecisions(tour, reader())).toEqual(['Sum over product?'])
    expect(unansweredQuiz(tour, reader())).toBe(1)
    expect(unansweredQuiz(tour, reader({ quiz: { 'q-run': { answered: 1, right: true } } }))).toBe(0)
  })

  it('leads with the world landmark, or the first one without it', () => {
    const tour = syntheticTour()
    expect(worldLandmark(tour).id).toBe('world')
    const [first] = tour.landmarks
    expect(worldLandmark({ landmarks: [{ ...first!, stage: 'why' }] }).id).toBe('before')
    expect(() => worldLandmark({ landmarks: [] })).toThrow('a tour has landmarks')
  })

  it('ends with the last landmark when none is the respect one', () => {
    const tour = syntheticTour()
    const landmarks = tour.landmarks.map(l => (l.stage === 'respect' ? { ...l, stage: 'why' as const } : l))
    const prompt = buildTourPrompt({ ...tour, landmarks }, reader(), '42')
    expect(prompt).toContain(
      '## What a change must respect\nA later change adds to the sum, never replaces it.'
    )
    expect(() => buildTourPrompt({ ...tour, landmarks: [] }, reader(), '42')).toThrow('a tour has landmarks')
  })
})

describe('buildTourPrompt', () => {
  it('writes the intent, what to respect, the kept decisions, and what to do after', () => {
    const prompt = buildTourPrompt(
      syntheticTour(),
      reader({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } }),
      '42'
    )
    expect(prompt).toContain('# Keep PR #42 as the tour settled it')
    expect(prompt).toContain('Change: feat: add b (acme/widgets, head aaaaaaa).')
    expect(prompt).toContain('## Intent\nA caller of run() gets a() plus b(); the test expects 3.')
    expect(prompt).toContain(
      '## What a change must respect\nA later change adds to the sum, never replaces it.'
    )
    expect(prompt).toContain('- sum-over-product: Sum\n')
    expect(prompt).not.toContain('## Changes to make')
    expect(prompt).toContain('- Run /pr-tour 42 again; picks carry by decision key.')
  })

  it('lists approved changes with their restatement, and the notes', () => {
    const tour = syntheticTour({
      decisions: [
        ...syntheticTour().decisions,
        {
          ...syntheticTour().decisions[0]!,
          key: 'second',
          title: 'Second?',
        },
      ],
    })
    const prompt = buildTourPrompt(
      tour,
      reader({
        picks: {
          'sum-over-product': {
            pick: 'other',
            approved: true,
            restatement: { what: 'Multiply.', where: ['src/app.ts'], unchanged: 'The callers.' },
          },
          second: { pick: 'keep', approved: true },
        },
        notes: { world: 'Rename b later.' },
      }),
      '42'
    )
    expect(prompt).toContain('# Re-implement PR #42 as the tour settled it')
    expect(prompt).toContain('- second: Sum')
    expect(prompt).toContain(
      '## Changes to make, as approved in the tour\n1. Sum over product?\n   What: Multiply.\n   Where: src/app.ts\n   Stays the same: The callers.'
    )
    expect(prompt).toContain(
      '## Notes the reader left while reading\n- On "run() now adds b()": Rename b later.'
    )
  })

  it('names a local change by its key', () => {
    const tour = syntheticTour({ pr: { ...syntheticTour().pr, number: null } })
    const prompt = buildTourPrompt(
      tour,
      reader({ picks: { 'sum-over-product': { pick: 'keep', approved: true } } }),
      'branch'
    )
    expect(prompt).toContain('# Keep the branch change as the tour settled it')
  })

  it("lists the tour's alternative as a change on the decision's line, with nothing said to stay", () => {
    const prompt = buildTourPrompt(
      syntheticTour(),
      reader({ picks: { 'sum-over-product': { pick: 'change', approved: true } } }),
      '42'
    )
    expect(prompt).toContain(
      '1. Sum over product?\n   What: Product. Grows faster; the spec would have to change.\n   Where: src/app.ts:4\n'
    )
    expect(prompt).not.toContain('Stays the same')
  })

  it('says none when nothing was kept', () => {
    const prompt = buildTourPrompt(
      syntheticTour(),
      reader({
        picks: {
          'sum-over-product': {
            pick: 'other',
            approved: true,
            restatement: { what: 'w', where: ['x'], unchanged: 'u' },
          },
        },
      }),
      '42'
    )
    expect(prompt).toContain('## Decisions kept by the author (do not reopen)\n- none')
  })
})
