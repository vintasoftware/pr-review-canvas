// Checks a tour model against the context it was prepared with: the schema, the caps measured on
// the text a reader sees, the landmark order, the budget, and every reference into the diff.
import type { FileEntry } from '../contract/review-artifact.js'
import {
  type TourBudget,
  type TourCaps,
  type TourContext,
  type TourModel,
  TOUR_LIMITS,
  type TourValidationError,
  type TourValidationReport,
  tourModelSchema,
} from '../contract/tour.js'
import { hunkForLine } from '../git/patch-lines.js'
import { visibleLength } from '../review/text-length.js'
import { sceneProblems } from './validate-scene.js'

export interface TourValidationInput {
  files: readonly FileEntry[]
  /** Test paths that exist at the head outside the diff, looked up by the caller. */
  headPaths: ReadonlySet<string>
  caps: TourCaps
  budget: TourBudget
  categories: TourContext['categories']
  stateRequired: boolean
  options: TourContext['options']
}

export type TourValidationResult = TourValidationReport & { output: TourModel | null }

/** The test paths a model names as guards, for the caller to look up at the head. */
export function guardPaths(raw: unknown): string[] {
  const out = new Set<string>()
  const landmarks = (raw as { landmarks?: unknown })?.landmarks
  if (!Array.isArray(landmarks)) return []
  for (const l of landmarks) {
    const guards = (l as { guards?: unknown })?.guards
    if (!Array.isArray(guards)) continue
    for (const g of guards) {
      const p = (g as { testPath?: unknown })?.testPath
      if (typeof p === 'string' && p !== '') out.add(p)
    }
  }
  return [...out]
}

function formatIssuePath(segments: PropertyKey[]): string {
  return segments.length === 0 ? '(root)' : segments.map(String).join('.')
}

export function validateTourModel(raw: unknown, input: TourValidationInput): TourValidationResult {
  const errors: TourValidationError[] = []
  const parsed = tourModelSchema(input.caps).safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        code: 'SCHEMA',
        where: formatIssuePath(issue.path),
        message: `${formatIssuePath(issue.path)}: ${issue.message}`,
      })
    }
    return { ok: false, errors, output: null }
  }
  const model = parsed.data
  const caps = input.caps
  const tooLong = (where: string, text: string, cap: number) => {
    const n = visibleLength(text)
    if (n > cap)
      errors.push({ code: 'TEXT_TOO_LONG', where, message: `${where}: ${n} visible chars, cap ${cap}` })
  }
  const byPath = new Map(input.files.map(f => [f.path, f]))
  const ids = new Set<string>()
  const dup = (kind: string, id: string, where: string) => {
    const key = `${kind}:${id}`
    if (ids.has(key))
      errors.push({ code: 'ID_DUPLICATE', where, message: `${where}: ${kind} "${id}" appears twice` })
    ids.add(key)
  }

  // Landmarks: order, texts, code, literate, guards, scenes.
  const stages = model.landmarks.map(l => l.stage)
  const last = stages.length - 1
  if (stages[0] !== 'background' || stages[1] !== 'world' || stages[last] !== 'respect') {
    errors.push({
      code: 'LANDMARK_ORDER',
      where: 'landmarks',
      message: 'landmarks: the first is the background, the second the world, the last what to respect',
    })
  }
  if (
    stages.slice(2, last).some(s => s !== 'why') ||
    stages.filter(s => s === 'background').length > 1 ||
    stages.filter(s => s === 'world').length > 1 ||
    stages.filter(s => s === 'respect').length > 1
  ) {
    errors.push({
      code: 'LANDMARK_ORDER',
      where: 'landmarks',
      message:
        'landmarks: between the world and the respect landmark every landmark is a why, and each of the other three appears once',
    })
  }
  const counted = model.landmarks.filter(l => l.state !== true).length
  if (counted > input.budget.landmarks) {
    errors.push({
      code: 'LANDMARK_BUDGET',
      where: 'landmarks',
      message: `landmarks: ${counted} landmarks, budget ${input.budget.landmarks} (a state landmark does not count)`,
    })
  }
  if (input.stateRequired && !model.landmarks.some(l => l.state === true)) {
    errors.push({
      code: 'STATE_LANDMARK_MISSING',
      where: 'landmarks',
      message:
        'landmarks: the change touches stored data, so one landmark is the state landmark ("state": true)',
    })
  }
  let micros = 0
  model.landmarks.forEach((l, i) => {
    const where = `landmarks.${i}`
    dup('landmark', l.id, where)
    tooLong(`${where}.title`, l.title, caps.landmarkTitle)
    tooLong(`${where}.lead`, l.lead, caps.lead)
    l.body.forEach((p, j) => tooLong(`${where}.body.${j}`, p, caps.paragraph))
    l.code.forEach((c, j) => {
      if (!byPath.has(c.path))
        errors.push({
          code: 'PATH_UNKNOWN',
          where: `${where}.code.${j}`,
          message: `${where}.code.${j}: ${c.path} is not in the diff`,
        })
      if (!/^@@ /.test(c.diff))
        errors.push({
          code: 'CHUNK_UNKNOWN',
          where: `${where}.code.${j}`,
          message: `${where}.code.${j}: a code chunk starts with its @@ header`,
        })
    })
    l.literate.forEach((b, j) => {
      if (typeof b === 'string') tooLong(`${where}.literate.${j}`, b, caps.paragraph)
      else if ('chunk' in b) {
        if (b.chunk >= l.code.length)
          errors.push({
            code: 'CHUNK_UNKNOWN',
            where: `${where}.literate.${j}`,
            message: `${where}.literate.${j}: chunk ${b.chunk} but the landmark has ${l.code.length} code chunks`,
          })
      } else if (!byPath.has(b.path)) {
        errors.push({
          code: 'PATH_UNKNOWN',
          where: `${where}.literate.${j}`,
          message: `${where}.literate.${j}: ${b.path} is not in the diff`,
        })
      }
    })
    l.guards.forEach((g, j) => {
      tooLong(`${where}.guards.${j}.behavior`, g.behavior, caps.guardBehavior)
      if (!byPath.has(g.testPath) && !input.headPaths.has(g.testPath)) {
        errors.push({
          code: 'GUARD_PATH_UNKNOWN',
          where: `${where}.guards.${j}`,
          message: `${where}.guards.${j}: ${g.testPath} is neither in the diff nor at the head`,
        })
      }
    })
    if (typeof l.scene === 'string') {
      for (const problem of sceneProblems(l.scene)) {
        errors.push({ code: 'SCENE_INVALID', where: `${where}.scene`, message: `${where}.scene: ${problem}` })
      }
    }
    if (typeof l.micro === 'string') {
      micros += 1
      if (!input.options.microWorld) {
        errors.push({
          code: 'MICRO_LIMIT',
          where: `${where}.micro`,
          message: `${where}.micro: micro-worlds are off for this project`,
        })
      }
      for (const problem of sceneProblems(l.micro, { interactive: true })) {
        errors.push({ code: 'MICRO_INVALID', where: `${where}.micro`, message: `${where}.micro: ${problem}` })
      }
    }
  })
  if (micros > 1)
    errors.push({
      code: 'MICRO_LIMIT',
      where: 'landmarks',
      message: `landmarks: ${micros} micro-worlds; a tour has at most one`,
    })

  // Decisions.
  if (model.decisions.length > input.budget.decisions) {
    errors.push({
      code: 'DECISION_BUDGET',
      where: 'decisions',
      message: `decisions: ${model.decisions.length} decisions, budget ${input.budget.decisions}`,
    })
  }
  const landmarkOf = new Map(model.landmarks.map(l => [l.id, l]))
  const stateLandmarks = new Set(model.landmarks.filter(l => l.state === true).map(l => l.id))
  let reversibility = 0
  model.decisions.forEach((d, i) => {
    const where = `decisions.${i}`
    dup('decision', d.key, where)
    tooLong(`${where}.title`, d.title, caps.decisionTitle)
    tooLong(`${where}.context`, d.context, caps.context)
    for (const side of ['keep', 'change'] as const) {
      tooLong(`${where}.${side}.label`, d[side].label, caps.sideLabel)
      tooLong(`${where}.${side}.consequence`, d[side].consequence, caps.consequence)
    }
    tooLong(`${where}.reason.text`, d.reason.text, caps.reason)
    const landmark = landmarkOf.get(d.landmark)
    if (landmark === undefined || (landmark.stage !== 'why' && landmark.stage !== 'respect')) {
      errors.push({
        code: 'LANDMARK_UNKNOWN',
        where,
        message: `${where}: landmark "${d.landmark}" is not a why or respect landmark of this tour`,
      })
    }
    if (stateLandmarks.has(d.landmark) && d.category === 'trade-off') reversibility += 1
    if (!input.categories.includes(d.category)) {
      errors.push({
        code: 'CATEGORY_OFF',
        where,
        message: `${where}: category "${d.category}" is off for this project`,
      })
    }
    const file = byPath.get(d.anchor.path)
    if (file === undefined) {
      errors.push({
        code: 'ANCHOR_OUTSIDE_DIFF',
        where,
        message: `${where}: anchor ${d.anchor.path} is not in the diff`,
      })
    } else if (hunkForLine(file.hunks, 'new', d.anchor.line) === null) {
      errors.push({
        code: 'ANCHOR_OUTSIDE_DIFF',
        where,
        message: `${where}: anchor ${d.anchor.path}:${d.anchor.line} is outside every hunk of the file`,
      })
    }
    if (d.tryIt !== undefined) {
      d.tryIt.steps.forEach((s, j) => tooLong(`${where}.tryIt.steps.${j}`, s, caps.tryItLine))
      d.tryIt.look.forEach((s, j) => tooLong(`${where}.tryIt.look.${j}`, s, caps.tryItLine))
      if (!input.options.tryIt) {
        errors.push({
          code: 'TRY_IT_UNVERIFIED',
          where: `${where}.tryIt`,
          message: `${where}.tryIt: try-it recipes are off for this project`,
        })
      } else if (!d.tryIt.verified) {
        errors.push({
          code: 'TRY_IT_UNVERIFIED',
          where: `${where}.tryIt`,
          message: `${where}.tryIt: run the recipe and set verified to true, or leave the recipe out`,
        })
      }
    }
  })
  if (stateLandmarks.size > 0 && reversibility === 0) {
    errors.push({
      code: 'STATE_LANDMARK_MISSING',
      where: 'decisions',
      message: 'decisions: the state landmark carries a trade-off decision on reversibility',
    })
  }

  // Quiz.
  if (model.quiz.length > input.budget.quiz) {
    errors.push({
      code: 'QUIZ_BUDGET',
      where: 'quiz',
      message: `quiz: ${model.quiz.length} questions, budget ${input.budget.quiz}`,
    })
  }
  model.quiz.forEach((q, i) => {
    const where = `quiz.${i}`
    dup('question', q.id, where)
    tooLong(`${where}.question`, q.question, caps.question)
    q.options.forEach((o, j) => tooLong(`${where}.options.${j}`, o, caps.option))
    tooLong(`${where}.why`, q.why, caps.why)
    if (!landmarkOf.has(q.landmark)) {
      errors.push({
        code: 'LANDMARK_UNKNOWN',
        where,
        message: `${where}: landmark "${q.landmark}" is not in this tour`,
      })
    }
  })
  model.notToured.forEach((n, i) => tooLong(`notToured.${i}.title`, n.title, caps.notToured))

  return { ok: errors.length === 0, errors, output: errors.length === 0 ? model : null }
}

export { TOUR_LIMITS }
