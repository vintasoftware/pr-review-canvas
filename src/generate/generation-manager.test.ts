import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../acpx/events.js'
import { CheckoutBusyError, type ReviewCheckouts } from '../chat/checkouts.js'
import type { GenerationJob } from '../contract/generation.js'
import type { ReviewKey } from '../contract/review-key.js'
import { DEFAULT_SETTINGS, type Settings } from '../contract/settings.js'
import type { PrepareResult } from '../review/prepare.js'
import { ModelInvalidError, PublishError, type PublishResult } from '../review/publish.js'
import { createFakeRunner, type FakeRunnerOptions } from '../testing/fake-runner.js'
import {
  createGenerationManager,
  extractModelJson,
  GenerationBusyError,
  type GenerationManager,
  type GenerationSteps,
  codeNote,
  generationPreface,
  repairPrompt,
} from './generation-manager.js'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MODEL = '{"summary":"s","layers":[]}'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pr-review-gen-'))
  await writeFile(path.join(dir, 'prompt.md'), '## Paths\n\nthe task\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function prepared(over: Partial<PrepareResult> = {}): PrepareResult {
  return {
    canvasDir: dir,
    headSha: HEAD,
    mergeBaseSha: BASE,
    promptPath: path.join(dir, 'prompt.md'),
    contextPath: path.join(dir, 'context.json'),
    status: 'prepared',
    sharing: 'shared',
    models: { claude: 'opus' },
    ...over,
  }
}

const PUBLISHED: PublishResult = {
  status: 'published',
  headSha: HEAD,
  reviewJsonPath: '/x/review.json',
  attempts: 1,
  sharing: { status: 'shared', url: 'https://github.com/o/r/pull/7#c' },
  reviewUrl: 'http://localhost:3010/review/7',
}

function invalid(attempts: number): ModelInvalidError {
  return new ModelInvalidError(
    { ok: false, errors: [{ code: 'HUNK_UNASSIGNED', message: 'a_ts#1 in a.ts is in no layer' }] },
    attempts
  )
}

interface Harness {
  manager: GenerationManager
  runner: ReturnType<typeof createFakeRunner>
  steps: { [K in keyof GenerationSteps]: ReturnType<typeof vi.fn> }
  leases: { key: ReviewKey; moved: string[]; released: boolean }[]
  logs: string[]
}

function harness(
  opts: {
    runner?: FakeRunnerOptions
    settings?: Partial<Settings>
    steps?: Partial<GenerationSteps>
    lease?: 'busy' | 'move-fails'
    maxRepairRounds?: number
    busyElsewhere?: () => ReviewKey | null
  } = {}
): Harness {
  const runner = createFakeRunner({
    script: [
      // Text before a tool call is no part of the answer, even when it holds braces.
      { type: 'chunk', text: 'Reading {the manifest} first. ' },
      { type: 'tool', id: 't1', title: 'Read src/a.ts', status: 'pending' },
      { type: 'tool', id: 't1', title: 'Read src/a.ts', status: 'completed' },
      { type: 'chunk', text: `Here it is:\n${MODEL}` },
      { type: 'done', stopReason: 'end_turn' },
    ],
    ...opts.runner,
  })
  const leases: Harness['leases'] = []
  const checkouts: ReviewCheckouts = {
    root: '/data/checkouts',
    async lease(key) {
      if (opts.lease === 'busy') {
        throw new CheckoutBusyError(key, 'chat')
      }
      const lease = { key, moved: [] as string[], released: false }
      leases.push(lease)
      return {
        dir: `/data/checkouts/${String(key)}`,
        head: null,
        async moveTo(sha) {
          if (opts.lease === 'move-fails') {
            throw new Error('worktree add failed')
          }
          lease.moved.push(sha)
        },
        async release() {
          lease.released = true
        },
      }
    },
    list: async () => [],
    sweep: async () => ({ removed: [], skipped: [] }),
    size: async () => 0,
  }
  const steps = {
    prepare: vi.fn(opts.steps?.prepare ?? (async () => prepared())),
    publish: vi.fn(opts.steps?.publish ?? (async () => PUBLISHED)),
    fix: vi.fn(opts.steps?.fix ?? (async () => [])),
  }
  const logs: string[] = []
  const manager = createGenerationManager({
    runner,
    checkouts,
    steps,
    settings: async () => ({ ...DEFAULT_SETTINGS, ...opts.settings }),
    generation: { models: { claude: 'opus' }, maxRepairRounds: opts.maxRepairRounds ?? 3 },
    repo: { owner: 'Acme', name: 'widgets' },
    currentBranch: async () => 'feat/b',
    repoRoot: '/repo',
    log: line => logs.push(line),
    now: () => new Date('2026-10-05T12:00:00.000Z'),
    busyElsewhere: opts.busyElsewhere,
  })
  return { manager, runner, steps, leases, logs }
}

/** Polls the status until the job ends. */
async function settled(manager: GenerationManager, key: ReviewKey): Promise<GenerationJob> {
  for (let i = 0; i < 200; i++) {
    const job = manager.status(key)
    if (job !== null && ['done', 'failed', 'cancelled'].includes(job.phase)) {
      return job
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('the job did not end')
}

describe('extractModelJson', () => {
  it('keeps the object, dropping a fence or a word around it', () => {
    expect(extractModelJson(MODEL)).toBe(MODEL)
    expect(extractModelJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractModelJson('Done. {"a":{"b":2}} Bye')).toBe('{"a":{"b":2}}')
  })

  it('finds nothing in an answer with no object', () => {
    expect(extractModelJson('I could not do it')).toBeNull()
    expect(extractModelJson('} then {')).toBeNull()
  })
})

describe('prompts', () => {
  it('tells the agent to write nothing and to answer with the JSON', () => {
    const text = generationPreface({ kind: 'working-tree', cwd: '/c' }, HEAD, '/d/model.json')
    expect(text).toContain('the work under review')
    expect(text).toContain('/d/model.json')
    expect(text).toContain('write no file')
    expect(text).toMatch(/Answer with the model JSON itself/)
  })

  it('describes each place the agent can read code from', () => {
    expect(codeNote({ kind: 'checkout', cwd: '/c', sha: HEAD }, HEAD)).toContain(`a checkout of ${HEAD}`)
    const fallback = codeNote({ kind: 'fallback', cwd: '/r', message: 'm', branch: null }, HEAD)
    expect(fallback).toContain(`may be on another commit than ${HEAD}`)
    expect(codeNote({ kind: 'reader-checkout', cwd: '/r' }, HEAD)).toBe(fallback)
  })

  it('names the problems, the fixes to keep, and the attempt', () => {
    const text = repairPrompt(['HUNK_UNASSIGNED x'], ['layers.0.title: "a" -> "b"'], 2, 4)
    expect(text).toContain('attempt 1 of 4')
    expect(text).toContain('- HUNK_UNASSIGNED x')
    expect(text).toContain('keep them')
    expect(repairPrompt(['P'], [], 3, 4)).not.toContain('keep them')
  })
})

describe('createGenerationManager', () => {
  it('prepares, runs the agent in the review checkout, writes its JSON, and publishes', async () => {
    const h = harness()
    const started = await h.manager.start(7, { force: false })
    expect(started).toMatchObject({
      key: 7,
      agent: 'claude',
      model: 'opus',
      phase: 'preparing',
      round: 1,
      maxRounds: 4,
    })

    const job = await settled(h.manager, 7)
    expect(job).toMatchObject({
      phase: 'done',
      headSha: HEAD,
      sharing: PUBLISHED.sharing,
    })
    expect(job.activity).toEqual(['Read src/a.ts'])
    expect(h.steps.prepare).toHaveBeenCalledWith(
      { kind: 'pr', number: 7 },
      expect.objectContaining({ force: false })
    )
    expect(h.leases).toEqual([{ key: 7, moved: [HEAD], released: true }])

    const [run] = h.runner.runs
    expect(run?.cwd).toBe('/data/checkouts/7')
    expect(run?.model).toBe('opus')
    expect(run?.session).toMatch(/^pr-review-acme-widgets-7-claude-gen\d+$/)
    expect(h.runner.ensured).toEqual([run?.session])
    expect(run?.prompt).toContain(`a checkout of ${HEAD}`)
    expect(run?.prompt).toContain('the task')

    expect(await readFile(path.join(dir, 'model.json'), 'utf8')).toBe(`${MODEL}\n`)
    expect(h.steps.fix).toHaveBeenCalledWith(dir, path.join(dir, 'model.json'), MODEL)
    expect(h.steps.publish).toHaveBeenCalledWith(dir, {
      agent: 'claude',
      model: 'opus',
      harness: 'other',
      allowStale: false,
    })
    expect(h.logs.at(-1)).toBe('generation #7: published aaaaaaa')
  })

  it('reads the working tree for uncommitted work, without a checkout', async () => {
    const h = harness()
    await h.manager.start('uncommitted', { force: true })
    const job = await settled(h.manager, 'uncommitted')
    expect(job.phase).toBe('done')
    expect(h.steps.prepare).toHaveBeenCalledWith(
      { kind: 'local', source: 'uncommitted' },
      expect.objectContaining({ force: true })
    )
    expect(h.leases).toEqual([])
    expect(h.runner.runs[0]?.cwd).toBe('/repo')
    expect(h.runner.runs[0]?.prompt).toContain('the work under review')
  })

  it('reads the reader checkout when checkouts are off or the checkout cannot move', async () => {
    const off = harness({ settings: { checkoutEnabled: false } })
    await off.manager.start('branch', { force: false })
    await settled(off.manager, 'branch')
    expect(off.leases).toEqual([])
    expect(off.runner.runs[0]?.cwd).toBe('/repo')
    expect(off.runner.runs[0]?.prompt).toContain("the reader's checkout")

    const broken = harness({ lease: 'move-fails' })
    await broken.manager.start('branch', { force: false })
    expect((await settled(broken.manager, 'branch')).phase).toBe('done')
    expect(broken.runner.runs[0]?.cwd).toBe('/repo')
    expect(broken.leases[0]?.released).toBe(true)
    expect(broken.logs.some(l => l.includes('did not move'))).toBe(true)
  })

  it('runs with the agent default when the project names no model for the agent', async () => {
    const h = harness({ settings: { chatAgent: 'codex' } })
    const started = await h.manager.start(7, { force: false })
    expect(started.model).toBeNull()
    await settled(h.manager, 7)
    expect(h.runner.runs[0]?.model).toBeUndefined()
  })

  it('writes a head that already has a canvas again from a blank page', async () => {
    const h = harness({
      steps: {
        prepare: async (_input, opts) => prepared(opts.force ? {} : { status: 'exists' }),
      },
    })
    await h.manager.start(7, { force: false })
    expect(await settled(h.manager, 7)).toMatchObject({ phase: 'done', sharing: PUBLISHED.sharing })
    expect(h.steps.prepare.mock.calls.map(call => (call[1] as { force: boolean }).force)).toEqual([
      false,
      true,
    ])
    expect(h.runner.runs).toHaveLength(1)
  })

  it('sends the problems back and publishes the corrected model', async () => {
    let calls = 0
    const h = harness({
      steps: {
        publish: async () => {
          calls += 1
          if (calls === 1) {
            throw invalid(1)
          }
          return PUBLISHED
        },
        fix: async () => ['layers.0.title: "long" -> "short"'],
      },
    })
    await h.manager.start(7, { force: false })
    const job = await settled(h.manager, 7)
    expect(job).toMatchObject({
      phase: 'done',
      round: 2,
      problems: ['HUNK_UNASSIGNED a_ts#1 in a.ts is in no layer'],
    })
    expect(h.runner.runs).toHaveLength(2)
    expect(h.runner.runs[1]?.session).toBe(h.runner.runs[0]?.session)
    expect(h.runner.runs[1]?.prompt).toContain('- HUNK_UNASSIGNED a_ts#1 in a.ts is in no layer')
    expect(h.runner.runs[1]?.prompt).toContain('layers.0.title: "long" -> "short"')
  })

  it('gives up after the repair rounds the project allows', async () => {
    const h = harness({ maxRepairRounds: 1, steps: { publish: async () => Promise.reject(invalid(1)) } })
    await h.manager.start(7, { force: false })
    const job = await settled(h.manager, 7)
    expect(job).toMatchObject({ phase: 'failed', round: 2, error: { code: 'MODEL_INVALID' } })
    expect(job.error?.message).toBe('publish rejected the model 2 times')
    expect(h.runner.runs).toHaveLength(2)
  })

  it('fails with the agent error and its hint', async () => {
    const h = harness({
      runner: { script: [{ type: 'error', code: 'AGENT_AUTH_REQUIRED', message: 'log in first' }] },
    })
    await h.manager.start(7, { force: false })
    const job = await settled(h.manager, 7)
    expect(job.error).toEqual({
      code: 'GENERATION_FAILED',
      message: 'log in first',
      hint: 'log the agent in from a terminal, then try again',
    })
    expect(h.steps.publish).not.toHaveBeenCalled()
    expect(h.leases[0]?.released).toBe(true)
  })

  it('fails on a turn the agent ended early', async () => {
    const h = harness({ runner: { script: [{ type: 'done', stopReason: 'max_tokens' }] } })
    await h.manager.start(7, { force: false })
    expect((await settled(h.manager, 7)).error).toMatchObject({
      code: 'GENERATION_FAILED',
      message: 'the agent stopped early (max_tokens)',
    })
  })

  it('maps a failed step and a held checkout to their own codes', async () => {
    const gone = harness({ steps: { prepare: async () => Promise.reject(new Error('no such ref')) } })
    await gone.manager.start(7, { force: false })
    expect((await settled(gone.manager, 7)).error).toMatchObject({ code: 'INTERNAL', message: 'no such ref' })
    expect(gone.logs.at(-1)).toBe('generation #7: failed (INTERNAL)')

    const held = harness({ lease: 'busy' })
    await held.manager.start(7, { force: false })
    expect((await settled(held.manager, 7)).error?.code).toBe('GENERATION_BUSY')
  })

  it('runs one job at a time, for any review, and shows each review only its own', async () => {
    const h = harness({ runner: { delayMs: 30 } })
    await h.manager.start(42, { force: false })
    await expect(h.manager.start(42, { force: true })).rejects.toBeInstanceOf(GenerationBusyError)
    // A PR and the branch review of its branch share a head, and with it a canvas folder.
    const refused = await h.manager.start('branch', { force: false }).catch((err: unknown) => err)
    expect(refused).toMatchObject({
      key: 42,
      message: 'a canvas is already being generated for #42, and one runs at a time',
    })
    expect(h.manager.status('branch')).toBeNull()
    expect(await h.manager.cancel('branch')).toBe(false)
    await settled(h.manager, 42)
    await expect(h.manager.start('branch', { force: true })).resolves.toMatchObject({ key: 'branch' })
    // The job the server ran last is the one a page can read; the earlier review's is gone.
    expect(h.manager.status(42)).toBeNull()
    await settled(h.manager, 'branch')
  })

  it('names the review whose job is running, and none once it ends', async () => {
    const h = harness({ runner: { delayMs: 5 } })
    expect(h.manager.running()).toBeNull()
    await h.manager.start('branch', { force: false })
    expect(h.manager.running()).toBe('branch')
    await settled(h.manager, 'branch')
    expect(h.manager.running()).toBeNull()
  })

  it('refuses to start while a manager over the same data dir runs a job, naming its review', async () => {
    let elsewhere: ReviewKey | null = 42
    const h = harness({ busyElsewhere: () => elsewhere })
    const refused = await h.manager.start(7, { force: false }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(GenerationBusyError)
    expect(refused).toMatchObject({ key: 42 })
    expect(h.manager.status(7)).toBeNull()
    elsewhere = null
    await h.manager.start(7, { force: false })
    await settled(h.manager, 7)
  })

  it('refuses to start when a sibling job started while the settings were read', async () => {
    let checks = 0
    const h = harness({ busyElsewhere: () => (++checks === 1 ? null : 'uncommitted') })
    const refused = await h.manager.start(7, { force: false }).catch((err: unknown) => err)
    expect(refused).toMatchObject({ key: 'uncommitted' })
    expect(checks).toBe(2)
    expect(h.manager.status(7)).toBeNull()
    expect(h.steps.prepare).not.toHaveBeenCalled()
  })

  it('stops the agent mid-turn', async () => {
    const script: AgentEvent[] = [
      { type: 'tool', id: 't', title: 'Read a', status: 'pending' },
      { type: 'chunk', text: '{' },
      { type: 'chunk', text: '}' },
      { type: 'done', stopReason: 'end_turn' },
    ]
    const h = harness({ runner: { script, delayMs: 20 } })
    await h.manager.start(7, { force: false })
    for (let i = 0; i < 100 && h.manager.status(7)?.activity.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(await h.manager.cancel(7)).toBe(true)
    expect(h.manager.status(7)?.stopping).toBe(true)
    const job = await settled(h.manager, 7)
    expect(job.phase).toBe('cancelled')
    expect(job.stopping).toBeUndefined()
    expect(h.runner.cancelled).toHaveLength(1)
    expect(h.steps.publish).not.toHaveBeenCalled()
    expect(h.leases[0]?.released).toBe(true)
    expect(await h.manager.cancel(7)).toBe(false)
  })

  it('stops a job before its agent starts', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const h = harness({
      steps: {
        prepare: async () => {
          await gate
          return prepared()
        },
      },
    })
    await h.manager.start(7, { force: false })
    expect(await h.manager.cancel(7)).toBe(true)
    release()
    expect((await settled(h.manager, 7)).phase).toBe('cancelled')
    expect(h.runner.runs).toEqual([])
  })

  it('writes an answer with no JSON in it as it is, for publish to reject, and skips untitled tools', async () => {
    const h = harness({
      runner: {
        script: [
          { type: 'tool', id: 't', title: '', status: 'pending' },
          { type: 'chunk', text: 'I cannot read the diff.\n' },
          { type: 'done', stopReason: 'end_turn' },
        ],
      },
    })
    await h.manager.start(7, { force: false })
    const job = await settled(h.manager, 7)
    expect(job.activity).toEqual([])
    expect(await readFile(path.join(dir, 'model.json'), 'utf8')).toBe('I cannot read the diff.\n')
  })

  it('keeps one activity line per tool call, with its latest title and short paths', async () => {
    const h = harness({
      runner: {
        script: [
          { type: 'tool', id: 'a', title: 'Read File', status: 'pending' },
          { type: 'tool', id: 'a', title: `Read ${dir}/derived/patches/a.diff`, status: 'in_progress' },
          { type: 'tool', id: 'a', title: 'tool', status: 'completed' },
          { type: 'tool', id: 'b', title: 'Read /data/checkouts/7/src/b.ts', status: 'completed' },
          ...Array.from({ length: 9 }, (_, i): AgentEvent => ({
            type: 'tool',
            id: `c${i}`,
            title: `Grep ${i}`,
            status: 'completed',
          })),
          { type: 'tool', id: 'b', title: 'Read src/b.ts again', status: 'completed' },
          { type: 'chunk', text: MODEL },
          { type: 'done', stopReason: 'end_turn' },
        ],
      },
    })
    await h.manager.start(7, { force: false })
    const job = await settled(h.manager, 7)
    // Eight lines are kept. `b` fell off before its last update came, which then counts as a new call.
    expect(job.activity).toEqual([
      'Grep 2',
      'Grep 3',
      'Grep 4',
      'Grep 5',
      'Grep 6',
      'Grep 7',
      'Grep 8',
      'Read src/b.ts again',
    ])
    const early = harness({
      runner: {
        script: [
          { type: 'tool', id: 'a', title: 'Read File', status: 'pending' },
          { type: 'tool', id: 'a', title: `Read ${dir}/derived/patches/a.diff`, status: 'in_progress' },
          { type: 'tool', id: 'a', title: 'tool', status: 'completed' },
          { type: 'tool', id: 'b', title: 'Read /data/checkouts/7/src/b.ts', status: 'completed' },
          { type: 'chunk', text: MODEL },
          { type: 'done', stopReason: 'end_turn' },
        ],
      },
    })
    await early.manager.start(7, { force: false })
    expect((await settled(early.manager, 7)).activity).toEqual([
      'Read derived/patches/a.diff',
      'Read src/b.ts',
    ])
  })

  it('starts one job for two clicks that arrive together', async () => {
    const h = harness()
    const results = await Promise.allSettled([
      h.manager.start(7, { force: false }),
      h.manager.start(7, { force: false }),
    ])
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    await settled(h.manager, 7)
    expect(h.steps.prepare).toHaveBeenCalledTimes(1)
  })

  it('fails with the code and hint publish gives when the head moved', async () => {
    const h = harness({
      steps: {
        publish: async () =>
          Promise.reject(new PublishError('CANVAS_STALE', 'the head moved to bbbbbbb', 'prepare again')),
      },
    })
    await h.manager.start(7, { force: false })
    expect((await settled(h.manager, 7)).error).toEqual({
      code: 'CANVAS_STALE',
      message: 'the head moved to bbbbbbb',
      hint: 'prepare again',
    })
  })

  it('fails without a hint on an agent error the reader cannot fix', async () => {
    const h = harness({ runner: { script: [{ type: 'error', code: 'AGENT_FAILED', message: 'boom' }] } })
    await h.manager.start(7, { force: false })
    expect((await settled(h.manager, 7)).error).toEqual({ code: 'GENERATION_FAILED', message: 'boom' })
  })

  it('counts a step that fails after a stop as stopped', async () => {
    let fail: (err: Error) => void = () => undefined
    const h = harness({
      steps: {
        prepare: () =>
          new Promise<PrepareResult>((_resolve, reject) => {
            fail = reject
          }),
      },
    })
    await h.manager.start(7, { force: false })
    await h.manager.cancel(7)
    fail(new Error('interrupted'))
    expect((await settled(h.manager, 7)).phase).toBe('cancelled')
  })

  it('answers no job, and no stop, for a review it never ran', async () => {
    const h = harness()
    expect(h.manager.status(7)).toBeNull()
    expect(await h.manager.cancel(7)).toBe(false)
  })
})
