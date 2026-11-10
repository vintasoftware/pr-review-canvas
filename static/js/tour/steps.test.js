// @ts-check
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { freshReaderState } from '../../../src/contract/tour-api.js'
import { syntheticPageTour } from '../../../src/testing/tour-page.js'
import {
  buildSteps,
  minutesOf,
  nextLabel,
  pickSettled,
  planBasis,
  plural,
  blockedBy,
  reachable,
  settled,
  stepFromHash,
  stepHash,
  stepIndexOf,
  stepName,
  stepTitle,
} from './steps.js'

const tour = syntheticPageTour()
const ON = /** @type {const} */ ({ finalQuiz: 'on' })

describe('buildSteps', () => {
  it('lays out the cover, the landmarks, the decisions, the quiz, and the plan', () => {
    const steps = buildSteps(tour, ON)
    expect(steps.map(s => s.kind)).toEqual([
      'cover',
      'landmark',
      'landmark',
      'landmark',
      'landmark',
      'decision',
      'quiz',
      'plan',
    ])
    expect(buildSteps(tour, { finalQuiz: 'off' }).map(s => s.kind)).not.toContain('quiz')
    expect(steps.map(stepTitle)).toEqual([
      'Cover',
      'run() returned a() alone',
      'run() now adds b()',
      'Sum, not product',
      'Keep run() total',
      'Sum over product?',
      'What does run() return now?',
      'The plan',
    ])
  })

  it('names each step in the URL and finds it back', () => {
    const steps = buildSteps(tour, ON)
    expect(steps.map(stepHash)).toEqual([
      '#cover',
      '#landmark-before',
      '#landmark-world',
      '#landmark-sum',
      '#landmark-respect',
      '#decision-sum-over-product',
      '#quiz-q-run',
      '#plan',
    ])
    expect(stepFromHash(steps, '#quiz-q-run')).toBe(6)
    expect(stepFromHash(steps, '')).toBe(-1)
    expect(stepFromHash(steps, '#nope')).toBe(-1)
    expect(stepIndexOf(steps, 'landmark', 'sum')).toBe(3)
    expect(stepIndexOf(steps, 'decision', 'sum-over-product')).toBe(5)
    expect(stepIndexOf(steps, 'quiz', 'q-run')).toBe(6)
    expect(stepIndexOf(steps, 'quiz', 'nope')).toBe(-1)
    expect(stepIndexOf(steps, 'plan', 'x')).toBe(-1)
  })
})

describe('reachability', () => {
  it('closes the steps after an open decision or an unanswered question', () => {
    const steps = buildSteps(tour, ON)
    const reader = freshReaderState()
    expect(reachable(steps, 5, reader)).toBe(true)
    expect(reachable(steps, 6, reader)).toBe(false)
    expect(blockedBy(steps, 7, reader)).toBe(5)
    expect(blockedBy(steps, 5, reader)).toBe(-1)
    expect(settled(steps[5] ?? { kind: 'cover' }, reader)).toBe(false)
    reader.picks['sum-over-product'] = { pick: 'other', approved: true }
    expect(reachable(steps, 6, reader)).toBe(false)
    reader.picks['sum-over-product'] = { pick: 'change', approved: true }
    expect(reachable(steps, 6, reader)).toBe(true)
    reader.picks['sum-over-product'] = {
      pick: 'other',
      approved: true,
      restatement: { what: 'w', where: ['x'], unchanged: 'u' },
    }
    expect(reachable(steps, 6, reader)).toBe(true)
    // A quiz the project does not require leaves the plan open; a required one closes it until
    // every question is answered right.
    expect(reachable(steps, 7, reader)).toBe(true)
    const required = buildSteps(tour, { finalQuiz: 'required' })
    expect(reachable(required, 7, reader)).toBe(false)
    reader.quiz['q-run'] = { answered: 0, right: false }
    expect(reachable(required, 7, reader)).toBe(false)
    reader.quiz['q-run'] = { answered: 1, right: true }
    expect(reachable(required, 7, reader)).toBe(true)
    expect(pickSettled({ pick: 'keep', approved: true })).toBe(true)
    expect(pickSettled(undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('says where the reader is and what comes next', () => {
    const steps = buildSteps(tour, ON)
    expect(stepName(steps, 0)).toBe('the cover')
    expect(stepName(steps, 2)).toBe('landmark 2')
    expect(stepName(steps, 5)).toBe('decision 1')
    expect(stepName(steps, 6)).toBe('question 1')
    expect(stepName(steps, 7)).toBe('the plan')
    expect(stepName(steps, 9)).toBe('')
    expect(nextLabel(steps, 0)).toBe('start')
    expect(nextLabel(steps, 1)).toBe('next')
    expect(nextLabel(steps, 4)).toBe('decide')
    expect(nextLabel(steps, 5)).toBe('quiz')
    expect(nextLabel(steps, 6)).toBe('plan')
    expect(nextLabel(steps, 7)).toBe('done')
    expect(plural(1, 'landmark')).toBe('1 landmark')
    expect(plural(2, 'landmark')).toBe('2 landmarks')
    expect(minutesOf(tour)).toBe(6)
  })
})

describe('planBasis', () => {
  it('sums up the settled picks with their restatements and the notes, so a later change shows', () => {
    const reader = freshReaderState()
    reader.notes = { world: '  rename b ', sum: '   ' }
    reader.picks['sum-over-product'] = { pick: 'other', approved: false }
    // A pick still being talked through and a blank note are not part of the plan.
    expect(JSON.parse(planBasis(tour, reader))).toEqual({ picks: [], notes: [['world', 'rename b']] })
    reader.picks['sum-over-product'] = {
      pick: 'other',
      approved: true,
      restatement: { what: 'Multiply.', where: ['src/run.ts'], unchanged: 'The callers.' },
    }
    const basis = planBasis(tour, reader)
    expect(JSON.parse(basis).picks).toEqual([
      ['sum-over-product', 'other', ['Multiply.', ['src/run.ts'], 'The callers.']],
    ])
    // Another restatement of the same pick is another plan.
    reader.picks['sum-over-product'] = {
      pick: 'other',
      approved: true,
      restatement: { what: 'Multiply.', where: ['src/run.ts'], unchanged: 'Nothing else.' },
    }
    expect(planBasis(tour, reader)).not.toBe(basis)
  })
})
