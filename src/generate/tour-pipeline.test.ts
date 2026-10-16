import { describe, expect, it, vi } from 'vitest'
import type { ReviewCheckouts } from '../chat/checkouts.js'
import type { GenerationJob } from '../contract/generation.js'
import type { ReviewKey } from '../contract/review-key.js'
import { DEFAULT_SETTINGS } from '../contract/settings.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import type { TourPrepareResult } from '../tour/prepare.js'
import { TourInvalidError, type TourPublishResult } from '../tour/publish.js'
import {
  canvasPipeline,
  createGenerationLane,
  createGenerationManager,
  GenerationBusyError,
  type GenerationLane,
  type GenerationManager,
  type GenerationPipeline,
} from './generation-manager.js'
import type { LoadedSkill } from './skill.js'
import {
  type TourGenerationSteps,
  tourGenerationPrompt,
  tourPipeline,
  tourRepairPrompt,
} from './tour-pipeline.js'

const HEAD = 'a'.repeat(40)
const TOUR_SKILL: LoadedSkill = {
  info: { source: 'project', path: '.claude/skills/pr-tour/SKILL.md', state: 'edited' },
  body: '\n# pr-tour\n\nDraw the landmarks.\n',
}
const CLI = {
  command: '/usr/bin/node /pkg/bin/pr-review.mjs',
  dataDirFlag: "--data-dir '/my data/.pr-review'",
}

function prepared(over: Partial<TourPrepareResult> = {}): TourPrepareResult {
  return {
    tourDir: '/data/tours/aaa',
    headSha: HEAD,
    mergeBaseSha: 'b'.repeat(40),
    promptPath: '/data/tours/aaa/prompt.md',
    contextPath: '/data/tours/aaa/context.json',
    scenesDir: '/data/tours/aaa/scenes',
    sceneGuidePath: '/pkg/skills/pr-tour/scenes.md',
    status: 'prepared',
    sharing: 'shared',
    models: { claude: 'opus' },
    blastRadius: [],
    budget: { why: 2, whyMax: 4, decisions: 3, quiz: 3 },
    guide: null,
    ...over,
  }
}

const PUBLISHED: TourPublishResult = {
  status: 'published',
  headSha: HEAD,
  tourJsonPath: '/data/tours/aaa/tour.json',
  attempts: 1,
  sharing: { status: 'shared', url: 'https://github.com/o/r/pull/7#t' },
}

const NO_CHECKOUTS: ReviewCheckouts = {
  root: '/data/checkouts',
  lease: async () => {
    throw new Error('the tour job leases no checkout')
  },
  list: async () => [],
  sweep: async () => ({ removed: [], skipped: [] }),
  size: async () => 0,
  remove: async () => false,
}

function manager(
  pipeline: GenerationPipeline,
  opts: { lane?: GenerationLane; runner?: ReturnType<typeof createFakeRunner> } = {}
): GenerationManager {
  return createGenerationManager({
    runner: opts.runner ?? createFakeRunner({ script: [{ type: 'done', stopReason: 'end_turn' }] }),
    checkouts: NO_CHECKOUTS,
    pipeline,
    settings: async () => ({ ...DEFAULT_SETTINGS, checkoutEnabled: false }),
    skill: async () => TOUR_SKILL,
    generation: { models: { claude: 'opus' }, maxRepairRounds: 2 },
    repo: { owner: 'acme', name: 'widgets' },
    repoRoot: '/repo',
    currentBranch: async () => 'feat/b',
    log: () => undefined,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    lane: opts.lane,
  })
}

function steps(over: Partial<TourGenerationSteps> = {}) {
  return {
    prepare: vi.fn(over.prepare ?? (async () => prepared())),
    publish: vi.fn(over.publish ?? (async () => PUBLISHED)),
    repoRoot: '/repo',
    cli: CLI,
  }
}

async function settled(m: GenerationManager, key: ReviewKey): Promise<GenerationJob> {
  for (let i = 0; i < 200; i++) {
    const job = m.status(key)
    if (job !== null && ['done', 'failed', 'cancelled'].includes(job.phase)) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the job did not end')
}

describe('tour prompts', () => {
  it('replaces prepare and publish, names the server CLI, and carries what prepare printed and the skill', () => {
    const prompt = tourGenerationPrompt(prepared(), TOUR_SKILL, CLI)
    expect(prompt).toContain("this project's copy, .claude/skills/pr-tour/SKILL.md")
    expect(prompt).toContain(
      "run `/usr/bin/node /pkg/bin/pr-review.mjs <step> … --data-dir '/my data/.pr-review'` instead"
    )
    expect(prompt).toContain('Do not run `tour publish`')
    expect(prompt).toContain('Write only under the tour directory, /data/tours/aaa')
    expect(prompt).toContain('"sceneGuidePath": "/pkg/skills/pr-tour/scenes.md"')
    expect(prompt.endsWith('# pr-tour\n\nDraw the landmarks.')).toBe(true)
    expect(
      tourGenerationPrompt(prepared(), { info: { source: 'default', version: '9.9.9' }, body: 'x' }, CLI)
    ).toContain('the one pr-review 9.9.9 ships')
  })

  it('names the problems and the attempt in a repair', () => {
    expect(tourRepairPrompt(['SCHEMA (root): bad'], 2, 3)).toBe(
      [
        'Publish rejected the tour (attempt 1 of 3). Fix exactly these problems in the model and scene files:',
        '',
        '- SCHEMA (root): bad',
        '',
        'Do not weaken the content to pass: shorten text, move hunks, fix anchors. Validate again, then answer with the single word `done`.',
      ].join('\n')
    )
  })
})

describe('the tour generation', () => {
  it('prepares, runs a writing agent from the repository root, and publishes with sharing as asked', async () => {
    const runner = createFakeRunner({
      script: [
        { type: 'chunk', text: 'done' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    })
    const s = steps()
    const m = manager(tourPipeline(s), { runner })
    const started = await m.start(7, { force: false, share: false })
    expect(started).toMatchObject({ kind: 'tour', key: 7, model: 'opus', phase: 'preparing' })
    const job = await settled(m, 7)
    expect(job).toMatchObject({ kind: 'tour', phase: 'done', headSha: HEAD, sharing: PUBLISHED.sharing })
    expect(s.prepare).toHaveBeenCalledWith(
      { kind: 'pr', number: 7 },
      { force: false, log: expect.any(Function) }
    )
    expect(s.publish).toHaveBeenCalledWith('/data/tours/aaa', {
      agent: 'claude',
      model: 'opus',
      harness: 'other',
      allowStale: false,
      share: false,
    })
    expect(runner.runs).toHaveLength(1)
    expect(runner.runs[0]).toMatchObject({ cwd: '/repo', access: 'write', model: 'opus' })
    expect(runner.ensured[0]).toMatch(/^pr-review-acme-widgets-7-claude-tour\d+$/)
  })

  it('writes a head that already has a tour again from a blank page', async () => {
    const s = steps({
      prepare: async (_input, opts) => prepared(opts.force ? {} : { status: 'exists' }),
    })
    const m = manager(tourPipeline(s))
    await m.start('branch', { force: false, base: 'main' })
    expect((await settled(m, 'branch')).phase).toBe('done')
    expect(s.prepare.mock.calls.map(([input, opts]) => [input, opts.force])).toEqual([
      [{ kind: 'local', source: 'branch', base: 'main' }, false],
      [{ kind: 'local', source: 'branch', base: 'main' }, true],
    ])
  })

  it('sends the problems publish names back, and publishes what the agent fixed', async () => {
    const runner = createFakeRunner({ script: [{ type: 'done', stopReason: 'end_turn' }] })
    let calls = 0
    const s = steps({
      publish: async () => {
        calls += 1
        if (calls === 1) {
          throw new TourInvalidError(
            { ok: false, errors: [{ code: 'SCHEMA', where: '(root)', message: 'landmarks is missing' }] },
            1
          )
        }
        return PUBLISHED
      },
    })
    const m = manager(tourPipeline(s), { runner })
    await m.start(7, { force: true })
    const job = await settled(m, 7)
    expect(job).toMatchObject({ phase: 'done', round: 2, problems: ['SCHEMA landmarks is missing'] })
    expect(runner.runs[1]?.prompt).toContain('- SCHEMA landmarks is missing')
    expect(runner.runs[1]?.access).toBe('write')
  })

  it('fails on a publish error that is no rejected model', async () => {
    const s = steps({
      publish: async () => {
        throw new Error('disk full')
      },
    })
    const m = manager(tourPipeline(s))
    await m.start(7, { force: false })
    expect(await settled(m, 7)).toMatchObject({ phase: 'failed', error: { message: 'disk full' } })
  })

  it('shares the lane with the canvas: one job of either kind at a time, each kind showing its own', async () => {
    const lane = createGenerationLane()
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tours = manager(
      tourPipeline(
        steps({
          prepare: async () => {
            await gate
            return prepared()
          },
        })
      ),
      { lane }
    )
    const canvases = manager(
      canvasPipeline({
        prepare: async () => {
          throw new Error('not reached')
        },
        publish: async () => {
          throw new Error('not reached')
        },
        fix: async () => [],
      }),
      { lane }
    )
    await tours.start(7, { force: false })
    const refused = await canvases.start(7, { force: false }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(GenerationBusyError)
    expect((refused as Error).message).toBe(
      'a tour is already being generated for #7, and one runs at a time'
    )
    expect(canvases.status(7)).toBeNull()
    expect(canvases.running()).toBe(7)
    release()
    expect((await settled(tours, 7)).phase).toBe('done')
    expect(canvases.status(7)).toBeNull()
  })
})
