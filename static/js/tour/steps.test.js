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
  plural,
  positionLabel,
  reachable,
  settled,
  stepFromHash,
  stepHash,
  stepIndexOf,
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
    expect(settled(steps[5] ?? { kind: 'cover' }, reader)).toBe(false)
    reader.picks['sum-over-product'] = { pick: 'change', approved: true }
    expect(reachable(steps, 6, reader)).toBe(false)
    reader.picks['sum-over-product'] = {
      pick: 'change',
      approved: true,
      restatement: { what: 'w', where: ['x'], unchanged: 'u' },
    }
    expect(reachable(steps, 6, reader)).toBe(true)
    expect(reachable(steps, 7, reader)).toBe(false)
    reader.quiz['q-run'] = { answered: 0, right: false }
    expect(reachable(steps, 7, reader)).toBe(false)
    reader.quiz['q-run'] = { answered: 1, right: true }
    expect(reachable(steps, 7, reader)).toBe(true)
    expect(pickSettled({ pick: 'keep', approved: true })).toBe(true)
    expect(pickSettled(undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('says where the reader is and what comes next', () => {
    const steps = buildSteps(tour, ON)
    expect(positionLabel(steps, 0)).toBe('')
    expect(positionLabel(steps, 2)).toBe('2 of 4 landmarks')
    expect(positionLabel(steps, 5)).toBe('1 of 1 decision')
    expect(positionLabel(steps, 6)).toBe('1 of 1 question')
    expect(positionLabel(steps, 7)).toBe('the plan')
    expect(positionLabel(steps, 9)).toBe('')
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
