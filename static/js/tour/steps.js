// @ts-check
// The steps of a tour and what may be reached: the cover, one step per landmark, one per decision,
// one per quiz question, and the plan. A decision has to be settled and a question answered right
// before the step after it opens, so the plan is never reached with a decision still open.
/** @typedef {import('../contract-types.js').TourPageTour} TourPageTour */
/** @typedef {import('../contract-types.js').TourPageLandmark} TourPageLandmark */
/** @typedef {import('../contract-types.js').Decision} Decision */
/** @typedef {import('../contract-types.js').QuizQuestion} QuizQuestion */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */
/** @typedef {import('../contract-types.js').ReaderPick} ReaderPick */

/**
 * @typedef {{ kind: 'cover' } | { kind: 'landmark', landmark: TourPageLandmark }
 *   | { kind: 'decision', decision: Decision } | { kind: 'quiz', q: QuizQuestion } | { kind: 'plan' }} Step
 */

/**
 * @param {TourPageTour} tour
 * @param {{ finalQuiz: 'on' | 'off' | 'required' }} options
 * @returns {Step[]}
 */
export function buildSteps(tour, options) {
  return [
    { kind: 'cover' },
    ...tour.landmarks.map(landmark => /** @type {Step} */ ({ kind: 'landmark', landmark })),
    ...tour.decisions.map(decision => /** @type {Step} */ ({ kind: 'decision', decision })),
    ...(options.finalQuiz === 'off' ? [] : tour.quiz.map(q => /** @type {Step} */ ({ kind: 'quiz', q }))),
    { kind: 'plan' },
  ]
}

/**
 * A keep is settled once approved; a change once its restatement was approved.
 * @param {ReaderPick | undefined} pick
 */
export function pickSettled(pick) {
  if (pick === undefined || !pick.approved) {
    return false
  }
  return pick.pick === 'keep' || pick.restatement !== undefined
}

/**
 * @param {Step} step
 * @param {TourReaderState} reader
 */
export function settled(step, reader) {
  if (step.kind === 'decision') {
    return pickSettled(reader.picks[step.decision.key])
  }
  if (step.kind === 'quiz') {
    return reader.quiz[step.q.id]?.right === true
  }
  return true
}

/**
 * @param {Step[]} steps
 * @param {number} i
 * @param {TourReaderState} reader
 */
export function reachable(steps, i, reader) {
  for (let k = 0; k < i; k++) {
    const step = steps[k]
    if (step !== undefined && !settled(step, reader)) {
      return false
    }
  }
  return true
}

/** @param {Step} step */
export function stepTitle(step) {
  if (step.kind === 'cover') {
    return 'Cover'
  }
  if (step.kind === 'landmark') {
    return step.landmark.title
  }
  if (step.kind === 'decision') {
    return step.decision.title
  }
  if (step.kind === 'quiz') {
    return step.q.question
  }
  return 'The plan'
}

/** The part of the URL that names a step, so a step can be shared and a reload lands on it. */
/** @param {Step} step */
export function stepHash(step) {
  if (step.kind === 'cover') {
    return '#cover'
  }
  if (step.kind === 'landmark') {
    return `#landmark-${step.landmark.id}`
  }
  if (step.kind === 'decision') {
    return `#decision-${step.decision.key}`
  }
  if (step.kind === 'quiz') {
    return `#quiz-${step.q.id}`
  }
  return '#plan'
}

/**
 * The step a hash names, or -1.
 * @param {Step[]} steps
 * @param {string} hash
 */
export function stepFromHash(steps, hash) {
  return hash === '' ? -1 : steps.findIndex(step => stepHash(step) === hash)
}

/**
 * @param {Step[]} steps
 * @param {Step['kind']} kind
 * @param {string} id a landmark id, a decision key, or a question id
 */
export function stepIndexOf(steps, kind, id) {
  return steps.findIndex(step => {
    if (step.kind !== kind) {
      return false
    }
    if (step.kind === 'landmark') {
      return step.landmark.id === id
    }
    if (step.kind === 'decision') {
      return step.decision.key === id
    }
    return step.kind === 'quiz' && step.q.id === id
  })
}

/**
 * `2 of 6 landmarks`, `the plan`, or nothing on the cover.
 * @param {Step[]} steps
 * @param {number} i
 */
export function positionLabel(steps, i) {
  const step = steps[i]
  if (step === undefined || step.kind === 'cover') {
    return ''
  }
  if (step.kind === 'plan') {
    return 'the plan'
  }
  const same = steps.filter(s => s.kind === step.kind)
  const noun = step.kind === 'quiz' ? 'question' : step.kind
  return `${same.indexOf(step) + 1} of ${plural(same.length, noun)}`
}

/**
 * The word on the next button: what the step after this one is.
 * @param {Step[]} steps
 * @param {number} i
 */
export function nextLabel(steps, i) {
  const step = steps[i]
  const next = steps[i + 1]
  if (step === undefined || next === undefined) {
    return 'done'
  }
  if (step.kind === 'cover') {
    return 'start'
  }
  if (next.kind === 'decision' && step.kind !== 'decision') {
    return 'decide'
  }
  if (next.kind === 'quiz' && step.kind !== 'quiz') {
    return 'quiz'
  }
  if (next.kind === 'plan') {
    return 'plan'
  }
  return 'next'
}

/**
 * @param {number} n
 * @param {string} word
 */
export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * About how long the tour takes, from its size.
 * @param {TourPageTour} tour
 */
export function minutesOf(tour) {
  return Math.max(
    3,
    Math.round(tour.landmarks.length * 1.2 + tour.decisions.length * 0.8 + tour.quiz.length * 0.4)
  )
}
