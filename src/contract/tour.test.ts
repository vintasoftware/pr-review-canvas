// @vitest-environment node
import { DEFAULT_SETTINGS, resolveTourSharing } from './settings.js'
import { DEFAULT_PROJECT_CONFIG, mergeProjectConfig } from '../project-config.js'
import { matchesGlob } from '../review/glob.js'
import { syntheticTourModel } from '../testing/synthetic-tour.js'
import {
  blastRadiusOf,
  computeBudget,
  effectiveTourCaps,
  formatTourError,
  stateRequiredFor,
  TOUR_CAPS,
  TourArtifactSchema,
  TourModelSchema,
} from './tour.js'

describe('the tour budget', () => {
  const ceilings = DEFAULT_PROJECT_CONFIG.tour.budget

  it('gives every change three landmarks, one more per 150 lines, and more with a blast radius', () => {
    expect(computeBudget(0, [], ceilings)).toEqual({ landmarks: 3, decisions: 1, quiz: 2 })
    expect(computeBudget(300, [], ceilings)).toEqual({ landmarks: 5, decisions: 2, quiz: 2 })
    expect(computeBudget(300, ['auth'], ceilings)).toEqual({ landmarks: 6, decisions: 3, quiz: 2 })
    expect(computeBudget(5000, ['auth', 'schema'], ceilings)).toEqual({ landmarks: 8, decisions: 5, quiz: 5 })
  })

  it('names the high-risk labels the changed paths touch, once each, in config order', () => {
    const rules = [
      { pattern: '**/migrations/**', label: 'schema' },
      { pattern: '**/*auth*', label: 'auth' },
      { pattern: 'db/**', label: 'schema' },
    ]
    const files = [{ path: 'db/migrations/001.sql' }, { path: 'src/auth.ts' }, { path: 'README.md' }]
    expect(blastRadiusOf(files, rules, matchesGlob)).toEqual(['schema', 'auth'])
    expect(blastRadiusOf([{ path: 'README.md' }], rules, matchesGlob)).toEqual([])
  })

  it('requires a state landmark when a label speaks of stored data', () => {
    expect(stateRequiredFor(['schema'])).toBe(true)
    expect(stateRequiredFor(['Database migrations'])).toBe(true)
    expect(stateRequiredFor(['auth', 'design system'])).toBe(false)
  })
})

describe('the tour schemas', () => {
  it('accept the synthetic tour as a model and as a stored artifact', () => {
    const model = syntheticTourModel()
    expect(TourModelSchema.safeParse(model).success).toBe(true)
    const artifact = TourArtifactSchema.safeParse({
      version: 1,
      pr: {
        number: 42,
        title: 't',
        body: '',
        author: 'octocat',
        url: 'https://github.com/acme/widgets/pull/42',
        state: 'open',
        draft: false,
        baseRef: 'main',
        headRef: 'feat/b',
        headSha: 'a'.repeat(40),
        mergeBaseSha: 'b'.repeat(40),
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        repo: { owner: 'acme', name: 'widgets' },
      },
      repo: { owner: 'acme', name: 'widgets' },
      headSha: 'a'.repeat(40),
      mergeBaseSha: 'b'.repeat(40),
      blastRadius: [],
      budget: { landmarks: 4, decisions: 1, quiz: 1 },
      guide: null,
      ...model,
      generatedAt: '2026-09-10T12:00:00.000Z',
      generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
      source: 'local',
      record: { touredBy: [] },
    })
    expect(artifact.success).toBe(true)
  })

  it('refuses an id that is not a slug, a fourth quiz option, and an over-ceiling text', () => {
    const model = syntheticTourModel()
    expect(
      TourModelSchema.safeParse({
        ...model,
        landmarks: [{ ...model.landmarks[0], id: 'Not A Slug' }, ...model.landmarks.slice(1)],
      }).success
    ).toBe(false)
    expect(
      TourModelSchema.safeParse({ ...model, quiz: [{ ...model.quiz[0], options: ['a', 'b', 'c', 'd'] }] })
        .success
    ).toBe(false)
    expect(
      TourModelSchema.safeParse({
        ...model,
        landmarks: [
          { ...model.landmarks[0], title: 'x'.repeat(TOUR_CAPS.landmarkTitle * 4 + 1) },
          ...model.landmarks.slice(1),
        ],
      }).success
    ).toBe(false)
  })

  it('has caps a project may raise, and formats an error as code then message', () => {
    expect(effectiveTourCaps({ lead: 200 })).toEqual({ ...TOUR_CAPS, lead: 200 })
    expect(formatTourError({ code: 'LANDMARK_ORDER', message: 'landmarks: x' })).toBe(
      'LANDMARK_ORDER landmarks: x'
    )
  })
})

describe('tour settings', () => {
  it('reads the tour block of the project config with defaults for what is left out', () => {
    const { config } = mergeProjectConfig({
      tour: { budget: { landmarks: 4 }, finalQuiz: 'required', categories: ['product'] },
    })
    expect(config.tour).toEqual({
      ...DEFAULT_PROJECT_CONFIG.tour,
      budget: { ...DEFAULT_PROJECT_CONFIG.tour.budget, landmarks: 4 },
      finalQuiz: 'required',
      categories: ['product'],
    })
    expect(mergeProjectConfig({}).config.tour).toEqual(DEFAULT_PROJECT_CONFIG.tour)
  })

  it('shares a tour as the personal file, then tour.share, then canvas sharing say', () => {
    const sharing = { canvasComment: true, mentionCanvas: true }
    expect(resolveTourSharing({ sharing, tourShare: 'auto' }, DEFAULT_SETTINGS)).toBe(true)
    expect(
      resolveTourSharing(
        { sharing: { ...sharing, canvasComment: false }, tourShare: 'auto' },
        DEFAULT_SETTINGS
      )
    ).toBe(false)
    expect(resolveTourSharing({ sharing, tourShare: 'off' }, DEFAULT_SETTINGS)).toBe(false)
    expect(
      resolveTourSharing({ sharing, tourShare: 'off' }, { ...DEFAULT_SETTINGS, tourComment: true })
    ).toBe(true)
    expect(
      resolveTourSharing({ sharing, tourShare: 'on' }, { ...DEFAULT_SETTINGS, tourComment: false })
    ).toBe(false)
  })
})
