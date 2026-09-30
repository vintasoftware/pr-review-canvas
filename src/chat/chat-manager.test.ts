// @vitest-environment node
import { freshReaderState } from '../contract/tour-api.js'
import { syntheticTour } from '../testing/synthetic-tour.js'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../acpx/events.js'
import type { ChatEvent } from '../contract/chat.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { createPrStore } from '../store/pr-store.js'
import { createSettingsStore, type SettingsStore } from '../store/settings-store.js'
import { createStateStore, type StateStore } from '../store/state-store.js'
import { createFakeRunner, type FakeRunner } from '../testing/fake-runner.js'
import { createFakeCheckoutGit, type FakeCheckoutGit, makeTempDir } from '../testing/fakes.js'
import { HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import { ChatBusyError, type ChatManager, type ChatTarget, createChatManager } from './chat-manager.js'
import { CheckoutBusyError, createReviewCheckouts, type ReviewCheckouts } from './checkouts.js'
import { createTranscriptStore, type TranscriptStore } from './threads.js'

const artifact = syntheticArtifact()
const files = SYNTHETIC_FILES.map(toFileEntry)
const patches = toPatchMap(SYNTHETIC_FILES)
const REPO = { owner: 'acme', name: 'widgets' }
const T1 = 'pr-review-acme-widgets-42-claude-t1'

let dataDir: string
let runner: FakeRunner
let state: StateStore
let settings: SettingsStore
let transcripts: TranscriptStore
let manager: ChatManager
let checkoutGit: FakeCheckoutGit
let checkouts: ReviewCheckouts

function target(): ChatTarget {
  return {
    key: 42,
    headSha: HEAD_SHA,
    artifact,
    files,
    patches,
    derivedDir: '/data/derived',
    readLines: async () => ['a line'],
  }
}

function build(
  opts: {
    runner?: FakeRunner
    overrides?: { chatAgent?: 'claude' | 'codex'; chatModel?: string }
    checkoutGit?: FakeCheckoutGit
  } = {}
) {
  runner = opts.runner ?? createFakeRunner()
  checkoutGit = opts.checkoutGit ?? createFakeCheckoutGit()
  checkouts = createReviewCheckouts({
    root: path.join(dataDir, 'checkouts'),
    git: checkoutGit,
    now: () => new Date('2026-09-11T10:00:00.000Z'),
  })
  const prs = createPrStore(dataDir)
  state = createStateStore(prs, () => new Date('2026-09-11T10:00:00.000Z'))
  settings = createSettingsStore(dataDir)
  transcripts = createTranscriptStore(number => prs.prDir(number))
  manager = createChatManager({
    runner,
    settings,
    state,
    transcripts,
    repo: REPO,
    repoRoot: '/repo',
    overrides: opts.overrides ?? {},
    loadSeedTemplate: async () => 'SEED for {{PR_META}}',
    loadTourSeedTemplate: async () => 'TOUR SEED for {{PR_META}}\n{{DECISIONS}}',
    checkouts,
    currentBranch: async () => 'main',
    now: () => new Date('2026-09-11T10:00:00.000Z'),
  })
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const event of events) {
    out.push(event)
  }
  return out
}

/** Reads the stream up to and including the first event named `name`. */
async function advanceTo(iterator: AsyncIterator<ChatEvent>, name: ChatEvent['event']): Promise<void> {
  for (;;) {
    const next = await iterator.next()
    if (next.done === true || next.value.event === name) {
      return
    }
  }
}

beforeEach(async () => {
  dataDir = await makeTempDir('pr-review-chatmgr-')
  build()
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('createChatManager().send', () => {
  it('opens a thread, seeds it, and streams the answer', async () => {
    const events = await collect(
      manager.send(target(), { message: 'is this covered?', context: { kind: 'pr' } })
    )
    expect(events).toEqual([
      { event: 'checkout', status: 'preparing', sha: HEAD_SHA, creating: true },
      { event: 'turn', thread: T1, agent: 'claude', seeded: true },
      { event: 'chunk', text: 'Yes. ' },
      { event: 'chunk', text: 'The behavior is covered at `src/a.ts:10`.' },
      { event: 'done', stopReason: 'end_turn' },
    ])
    const prompt = runner.runs[0]?.prompt ?? ''
    expect(prompt).toContain('SEED for')
    expect(prompt).toContain('## Context: the whole pull request')
    expect(prompt).toContain('## Question\n\nis this covered?')
    expect(runner.runs[0]?.session).toBe(T1)
    expect(runner.runs[0]?.cwd).toBe(path.join(dataDir, 'checkouts', '42'))
  })

  it('seeds once per thread, and again after the head moves', async () => {
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.runs[1]?.prompt).not.toContain('SEED for')

    const moved = { ...target(), headSha: 'c'.repeat(40) }
    const events = await collect(manager.send(moved, { message: 'three', context: { kind: 'pr' } }))
    expect(events.find(e => e.event === 'turn')).toEqual({
      event: 'turn',
      thread: T1,
      agent: 'claude',
      seeded: true,
    })
    expect(runner.runs[2]?.prompt).toContain('SEED for')
  })

  it.each([
    ['missing space', 'library.', '`src/store.ts` adds a lock.', 'library. `src/store.ts` adds a lock.'],
    ['trailing space', 'library. ', 'Confirmed.', 'library. Confirmed.'],
    ['leading space', 'library.', ' Confirmed.', 'library. Confirmed.'],
    ['paragraph break', 'library.', '\n\nConfirmed.', 'library.\n\nConfirmed.'],
    ['trailing newline', 'library.\n', 'Confirmed.', 'library.\nConfirmed.'],
    ['tool before text', '', 'Confirmed.', 'Confirmed.'],
    ['tool after text', 'Checking.', '', 'Checking.'],
  ])('preserves spacing around tools: %s', async (_name, before, after, expected) => {
    build({
      runner: createFakeRunner({
        script: [
          { type: 'chunk', text: before },
          { type: 'tool', id: 'read', title: 'Read file', status: 'pending' },
          { type: 'tool', id: 'read', title: 'Read file', status: 'completed' },
          { type: 'chunk', text: '' },
          { type: 'thought', text: 'Checking the result' },
          ...Array.from(after, text => ({ type: 'chunk' as const, text })),
          { type: 'done', stopReason: 'end_turn' },
        ],
      }),
    })
    const events = await collect(manager.send(target(), { message: 'check', context: { kind: 'pr' } }))
    expect(
      events
        .filter(event => event.event === 'chunk')
        .map(event => event.text)
        .join('')
    ).toBe(expected)
    expect((await transcripts.read(42, T1)).at(-1)?.text).toBe(expected)
  })

  it('separates text across each tool round while keeping ordinary chunks together', async () => {
    build({
      runner: createFakeRunner({
        script: [
          { type: 'chunk', text: 'Check' },
          { type: 'chunk', text: 'ing.' },
          { type: 'tool', id: 'one', title: 'Read file', status: 'completed' },
          { type: 'chunk', text: 'Found it.' },
          { type: 'tool', id: 'two', title: 'Read manifest', status: 'completed' },
          { type: 'chunk', text: 'Con' },
          { type: 'chunk', text: 'firmed.' },
          { type: 'done', stopReason: 'end_turn' },
        ],
      }),
    })
    const events = await collect(manager.send(target(), { message: 'check', context: { kind: 'pr' } }))
    const expected = 'Checking. Found it. Confirmed.'
    expect(
      events
        .filter(event => event.event === 'chunk')
        .map(event => event.text)
        .join('')
    ).toBe(expected)
    expect((await transcripts.read(42, T1)).at(-1)?.text).toBe(expected)
  })

  it('writes both turns to the transcript and titles the thread from the first message', async () => {
    await collect(
      manager.send(target(), { message: 'is this covered?', context: { kind: 'file', path: 'src/app.ts' } })
    )
    expect(await transcripts.read(42, T1)).toEqual([
      {
        role: 'user',
        text: 'is this covered?',
        at: '2026-09-11T10:00:00.000Z',
        context: { kind: 'file', path: 'src/app.ts' },
      },
      {
        role: 'assistant',
        text: 'Yes. The behavior is covered at `src/a.ts:10`.',
        at: '2026-09-11T10:00:00.000Z',
      },
    ])
    const threads = await manager.threads(42)
    expect(threads.threads).toEqual([
      { name: T1, agent: 'claude', title: 'is this covered?', createdAt: '2026-09-11T10:00:00.000Z' },
    ])
    expect(threads.activeThread).toBe(T1)
  })

  it('keeps the first message as the title when more are sent', async () => {
    await collect(manager.send(target(), { message: 'first', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'second', context: { kind: 'pr' } }))
    expect((await manager.threads(42)).threads[0]?.title).toBe('first')
  })

  it('writes the scrubbed acpx lines to the raw event log', async () => {
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    const log = await readFile(path.join(transcripts.dir(42), `${T1}.events.ndjson`), 'utf8')
    expect(log.trim().split('\n').length).toBeGreaterThan(0)
  })

  it('refuses a second turn while one is running', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    // The lock is taken by the time the first event comes back.
    await iterator.next()
    expect(manager.busy(42)).toBe(true)
    await expect(
      collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    ).rejects.toBeInstanceOf(ChatBusyError)
    for (;;) {
      if ((await iterator.next()).done === true) {
        break
      }
    }
    expect(manager.busy(42)).toBe(false)
  })

  it('reports a turn that was stopped as cancelled and saves what was said', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const events: ChatEvent[] = []
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    events.push((await iterator.next()).value)
    events.push((await iterator.next()).value)
    expect(await manager.cancel(42)).toBe(true)
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) {
        break
      }
      events.push(next.value)
    }
    expect(events.at(-1)).toEqual({ event: 'cancelled' })
    const turns = await transcripts.read(42, T1)
    expect(turns.at(-1)).toMatchObject({ role: 'assistant', incomplete: 'cancelled' })
  })

  it('says there is nothing to cancel when no turn is running', async () => {
    expect(await manager.cancel(42)).toBe(false)
  })

  it('reports a stop reason that is not end_turn as an incomplete answer', async () => {
    build({ runner: createFakeRunner({ script: [{ type: 'done', stopReason: 'max_turn_requests' }] }) })
    const events = await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(events.at(-1)).toEqual({
      event: 'error',
      code: 'AGENT_INCOMPLETE',
      message: 'the agent stopped early (max_turn_requests)',
    })
  })

  it('passes an agent error through with a hint the reader can act on', async () => {
    const script: AgentEvent[] = [{ type: 'error', code: 'AGENT_AUTH_REQUIRED', message: 'not logged in' }]
    build({ runner: createFakeRunner({ script }) })
    const events = await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(events.at(-1)).toEqual({
      event: 'error',
      code: 'AGENT_AUTH_REQUIRED',
      message: 'not logged in',
      hint: 'log the agent in from a terminal, then try again',
    })
  })

  it('passes thoughts and tool calls on, and ignores the rest', async () => {
    const script: AgentEvent[] = [
      { type: 'thought', text: 'hmm' },
      { type: 'tool', id: 't1', title: 'Read File', status: 'pending' },
      { type: 'usage', used: 1, size: 2 },
      { type: 'plan', entries: 1 },
      { type: 'done', stopReason: 'end_turn' },
    ]
    build({ runner: createFakeRunner({ script }) })
    const events = await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(events.filter(e => e.event !== 'turn' && e.event !== 'checkout')).toEqual([
      { event: 'thought', text: 'hmm' },
      { event: 'tool', id: 't1', title: 'Read File', status: 'pending' },
      { event: 'done', stopReason: 'end_turn' },
    ])
  })

  it('refuses a context the canvas does not have, before the agent is started', async () => {
    await expect(
      collect(manager.send(target(), { message: 'x', context: { kind: 'file', path: 'nope.ts' } }))
    ).rejects.toThrow(/not a file of this pull request/)
    expect(runner.runs).toEqual([])
  })
})

describe('createChatManager() threads and settings', () => {
  it('starts a new thread on request and makes it the active one', async () => {
    const first = await manager.createThread(42)
    const second = await manager.createThread(42)
    expect([first.name, second.name]).toEqual([T1, 'pr-review-acme-widgets-42-claude-t2'])
    expect((await manager.threads(42)).activeThread).toBe(second.name)
  })

  it('starts a new thread when the agent changes', async () => {
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    await settings.write({ chatAgent: 'codex' })
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    const { threads } = await manager.threads(42)
    expect(threads.map(t => t.agent)).toEqual(['claude', 'codex'])
    expect(threads[1]?.name).toBe('pr-review-acme-widgets-42-codex-t2')
  })

  it('answers in the thread the message names and makes it active again', async () => {
    const a = await manager.createThread(42)
    await manager.createThread(42)
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' }, thread: a.name }))
    expect(runner.runs[0]?.session).toBe(a.name)
    expect((await manager.threads(42)).activeThread).toBe(a.name)
  })

  it('selects a thread the reader picked, and says so when there is no such thread', async () => {
    const a = await manager.createThread(42)
    await manager.createThread(42)
    expect((await manager.selectThread(42, a.name))?.name).toBe(a.name)
    expect((await manager.threads(42)).activeThread).toBe(a.name)
    expect(await manager.selectThread(42, 'pr-review-acme-widgets-42-claude-t9')).toBeNull()
  })

  it('lets the serve flags win over the settings file', async () => {
    await settings.write({ chatAgent: 'claude', chatModel: 'from-file' })
    build({ overrides: { chatAgent: 'codex', chatModel: 'from-flag' } })
    expect(await manager.effectiveSettings()).toMatchObject({ chatAgent: 'codex', chatModel: 'from-flag' })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.model).toBe('from-flag')
    expect(runner.runs[0]?.agent).toBe('codex')
  })

  it('runs the newest model of the saved family', async () => {
    await settings.write({ chatAgent: 'codex', chatModel: 'gpt-5.6-terra[high]' })
    build({ runner: createFakeRunner({ modelUpgrades: { codex: { 'gpt-5.6-terra': 'gpt-6-sol' } } }) })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.model).toBe('gpt-6-sol[high]')
  })

  it('moves a Claude thread with no saved model from a versioned id to its alias', async () => {
    build({ runner: createFakeRunner({ sessionModel: 'claude-opus-5' }) })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.model).toBe('opus')
  })

  it('moves a Codex thread with no saved model off a model the catalog replaced', async () => {
    await settings.write({ chatAgent: 'codex' })
    build({
      runner: createFakeRunner({
        sessionModel: 'gpt-5.6-terra',
        modelUpgrades: { codex: { 'gpt-5.6-terra': 'gpt-6-sol' } },
      }),
    })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.model).toBe('gpt-6-sol')
  })

  it("leaves a thread with no saved model on the agent's default when it is current", async () => {
    build({ runner: createFakeRunner({ sessionModel: 'opus[1m]' }) })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.model).toBeUndefined()
  })

  it('passes the timeout and the turn cap the settings hold', async () => {
    await settings.write({ chatTimeoutSec: 120, maxTurns: 3 })
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(runner.runs[0]).toMatchObject({ timeoutSec: 120, maxTurns: 3, model: undefined })
  })
})

describe('the hints on an agent failure', () => {
  it('tells the reader to install acpx when it is missing', async () => {
    build({
      runner: createFakeRunner({ script: [{ type: 'error', code: 'AGENT_MISSING', message: 'no acpx' }] }),
    })
    const events = await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(events.at(-1)).toEqual({
      event: 'error',
      code: 'AGENT_MISSING',
      message: 'no acpx',
      hint: 'install acpx and the agent CLI, then reload',
    })
  })

  it('gives no hint for a failure the reader cannot act on', async () => {
    build({
      runner: createFakeRunner({ script: [{ type: 'error', code: 'AGENT_FAILED', message: 'boom' }] }),
    })
    const events = await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' } }))
    expect(events.at(-1)).toEqual({ event: 'error', code: 'AGENT_FAILED', message: 'boom' })
  })

  it('takes a model override on its own, leaving the agent to the file', async () => {
    build({ overrides: { chatModel: 'only-the-model' } })
    expect(await manager.effectiveSettings()).toMatchObject({
      chatAgent: 'claude',
      chatModel: 'only-the-model',
    })
  })
})

describe('the acpx session behind a thread', () => {
  it('is created before the first turn and not again after it', async () => {
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1])
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1])
  })

  it('is created for each new thread', async () => {
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    const second = await manager.createThread(42)
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1, second.name])
  })
})

describe('two turns that arrive together', () => {
  it('starts one agent, even when the second arrives before the first has read its settings', async () => {
    const first = manager.send(target(), { message: 'one', context: { kind: 'pr' } })[Symbol.asyncIterator]()
    const second = manager.send(target(), { message: 'two', context: { kind: 'pr' } })[Symbol.asyncIterator]()
    const started = first.next()
    await expect(second.next()).rejects.toBeInstanceOf(ChatBusyError)
    await started
    for (;;) {
      if ((await first.next()).done === true) {
        break
      }
    }
    expect(runner.runs).toHaveLength(1)
  })

  it('stops the agent and frees the chat when the reader goes away mid-answer', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await iterator.return?.(undefined)
    expect(runner.cancelled).toEqual([T1])
    expect(manager.busy(42)).toBe(false)
  })

  it('frees the chat when the reader goes away before the first event', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    const started = iterator.next()
    await iterator.return?.(undefined)
    await started.catch(() => undefined)
    expect(manager.busy(42)).toBe(false)
  })
})

describe('a turn the agent never took', () => {
  it('leaves the thread unseeded, so the next try creates the session and seeds again', async () => {
    build({
      runner: createFakeRunner({
        script: [{ type: 'error', code: 'AGENT_NO_SESSION', message: 'no session' }],
      }),
    })
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1])
    const after = await manager.threads(42)
    expect(after.threads[0]?.title).toBe('New thread')

    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1, T1])
    expect(runner.runs[1]?.prompt).toContain('SEED for')
  })

  it('keeps a cancelled turn as a turn that happened', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    await advanceTo(iterator, 'turn')
    await manager.cancel(42)
    for (;;) {
      if ((await iterator.next()).done === true) {
        break
      }
    }
    expect((await manager.threads(42)).threads[0]?.title).toBe('one')
  })
})

describe('a stop that arrives before the agent has started', () => {
  it('still stops the turn, instead of letting the answer run on', async () => {
    let openGate = (): void => undefined
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    build({ runner: createFakeRunner({ delayMs: 5, ensureGate: gate }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    expect(await manager.cancel(42)).toBe(true)
    openGate()
    expect((await first).value).toMatchObject({ event: 'checkout', status: 'preparing' })
    const rest: ChatEvent[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) {
        break
      }
      rest.push(next.value)
    }
    expect(rest).toEqual([
      { event: 'turn', thread: T1, agent: 'claude', seeded: true },
      { event: 'cancelled' },
    ])
    // No agent was started at all, so there was nothing left to cancel.
    expect(runner.runs).toEqual([])
    expect(manager.busy(42)).toBe(false)
  })

  it('leaves the thread unseeded, because the seed never went anywhere', async () => {
    let openGate = (): void => undefined
    const gate = new Promise<void>(resolve => {
      openGate = resolve
    })
    build({ runner: createFakeRunner({ ensureGate: gate }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    const first = iterator.next()
    await manager.cancel(42)
    openGate()
    await first
    for (;;) {
      if ((await iterator.next()).done === true) {
        break
      }
    }
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.runs[0]?.prompt).toContain('SEED for')
    expect((await manager.threads(42)).threads[0]?.title).toBe('two')
  })
})

describe('an answer the reader walked out on', () => {
  it('is kept as an incomplete answer, not as one the agent finished', async () => {
    build({ runner: createFakeRunner({ delayMs: 5 }) })
    const stream = manager.send(target(), { message: 'one', context: { kind: 'pr' } })
    const iterator = stream[Symbol.asyncIterator]()
    await advanceTo(iterator, 'chunk')
    await iterator.return?.(undefined)
    const turns = await transcripts.read(42, T1)
    expect(turns.at(-1)).toMatchObject({ role: 'assistant', text: 'Yes. ', incomplete: 'cancelled' })
  })
})

describe('a thread whose acpx session is gone', () => {
  it('creates the session again on the next turn, and seeds it again', async () => {
    build({
      runner: createFakeRunner({
        script: options =>
          options.prompt.includes('the session went away')
            ? [{ type: 'error', code: 'AGENT_NO_SESSION', message: 'no session' }]
            : [
                { type: 'chunk', text: 'Yes.' },
                { type: 'done', stopReason: 'end_turn' },
              ],
      }),
    })
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'the session went away', context: { kind: 'pr' } }))
    // The second turn found the session already there, so it neither ensured nor seeded.
    expect(runner.ensured).toEqual([T1])
    expect(runner.runs[1]?.prompt).not.toContain('SEED for')

    await collect(manager.send(target(), { message: 'three', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1, T1])
    expect(runner.runs[2]?.prompt).toContain('SEED for')
    // The thread keeps the title its first message gave it.
    expect((await manager.threads(42)).threads[0]?.title).toBe('one')
  })
})

describe('a thread whose first message reads like the placeholder', () => {
  it('keeps that title, instead of taking the next message as its first', async () => {
    await collect(manager.send(target(), { message: 'New thread', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'and now a real question', context: { kind: 'pr' } }))
    expect((await manager.threads(42)).threads[0]?.title).toBe('New thread')
  })

  it('keeps it through a lost session too, which puts the thread back to needing a seed', async () => {
    build({
      runner: createFakeRunner({
        script: options =>
          options.prompt.includes('the session went away')
            ? [{ type: 'error', code: 'AGENT_NO_SESSION', message: 'no session' }]
            : [
                { type: 'chunk', text: 'Yes.' },
                { type: 'done', stopReason: 'end_turn' },
              ],
      }),
    })
    await collect(manager.send(target(), { message: 'New thread', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'the session went away', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'and now a real question', context: { kind: 'pr' } }))
    expect(runner.runs[2]?.prompt).toContain('SEED for')
    expect((await manager.threads(42)).threads[0]?.title).toBe('New thread')
  })
})

describe('the review checkout a turn reads', () => {
  const FALLBACK = 'git worktree add failed (128): disk full'
  const checkoutDir = (): string => path.join(dataDir, 'checkouts', '42')

  it('creates it on the first turn and moves it only when the commit changes', async () => {
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    const second = await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(second.filter(e => e.event === 'checkout')).toEqual([])
    const moved = 'c'.repeat(40)
    const third = await collect(
      manager.send({ ...target(), headSha: moved }, { message: 'three', context: { kind: 'pr' } })
    )
    expect(third[0]).toEqual({ event: 'checkout', status: 'preparing', sha: moved, creating: false })
    expect(checkoutGit.calls.map(c => c[0])).toEqual(['add', 'move'])
    expect(runner.runs.every(r => r.cwd === checkoutDir())).toBe(true)
  })

  it('tells the agent the checkout is its working directory, and where installed dependencies are', async () => {
    build({ runner: createFakeRunner() })
    manager = createChatManager({
      runner,
      settings,
      state,
      transcripts,
      repo: REPO,
      repoRoot: '/repo',
      overrides: {},
      loadSeedTemplate: async () => '{{CODE_LOCATION}}',
      loadTourSeedTemplate: async () => '{{CODE_LOCATION}}',
      checkouts,
      currentBranch: async () => 'main',
      now: () => new Date('2026-09-11T10:00:00.000Z'),
    })
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    const prompt = runner.runs[0]?.prompt ?? ''
    expect(prompt).toContain(`Your working directory, \`${checkoutDir()}\``)
    expect(prompt).toContain('/repo')
    expect(prompt).toContain('may not be what the pull request uses')
  })

  it('reads the working tree for uncommitted work, without a checkout', async () => {
    const events = await collect(
      manager.send({ ...target(), key: 'uncommitted' }, { message: 'one', context: { kind: 'pr' } })
    )
    expect(events.filter(e => e.event === 'checkout')).toEqual([])
    expect(runner.runs[0]?.cwd).toBe('/repo')
    expect(checkoutGit.calls).toEqual([])
  })

  it("reads the reader's checkout when checkouts are turned off", async () => {
    await settings.write({ checkoutEnabled: false })
    const events = await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    expect(events.filter(e => e.event === 'checkout')).toEqual([])
    expect(runner.runs[0]?.cwd).toBe('/repo')
    expect(checkoutGit.calls).toEqual([])
  })

  it("falls back to the reader's checkout with a warning when the checkout fails", async () => {
    build({ checkoutGit: createFakeCheckoutGit({ fail: 'disk full' }) })
    const events = await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    expect(events.filter(e => e.event === 'checkout')).toEqual([
      { event: 'checkout', status: 'preparing', sha: HEAD_SHA, creating: true },
      { event: 'checkout', status: 'fallback', message: FALLBACK, branch: 'main' },
    ])
    expect(events.at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    expect(runner.runs[0]?.cwd).toBe('/repo')
    // The warning is saved on the answer, so the thread shows it again when reopened.
    expect((await transcripts.read(42, T1)).at(-1)).toMatchObject({
      role: 'assistant',
      fallback: { message: FALLBACK, branch: 'main' },
    })
  })

  it('is busy while another process holds the checkout, and free again after the turn', async () => {
    const held = await checkouts.lease(42)
    await expect(
      collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    ).rejects.toThrow(CheckoutBusyError)
    await held.release()
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    const again = await checkouts.lease(42)
    await again.release()
  })

  it('keeps a thread from before review checkouts on its session in the reader checkout', async () => {
    await settings.write({ checkoutEnabled: false })
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    // A state file written before threads recorded their folder.
    await state.update(42, current => ({
      ...current,
      chat: {
        ...current.chat,
        threads: current.chat.threads.map(({ seededCwd: _cwd, ...thread }) => thread),
      },
    }))
    await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1])
    expect(runner.runs[1]?.prompt).not.toContain('SEED for')
    // Turning review checkouts on moves it to a new session in the checkout, once.
    await settings.write({ checkoutEnabled: true })
    await collect(manager.send(target(), { message: 'three', context: { kind: 'pr' } }))
    await collect(manager.send(target(), { message: 'four', context: { kind: 'pr' } }))
    expect(runner.ensured).toEqual([T1, T1])
    expect(runner.runs[2]?.prompt).toContain('SEED for')
    expect(runner.runs[3]?.prompt).not.toContain('SEED for')
  })

  it('starts a new session and seeds again when the thread last ran in another folder', async () => {
    await settings.write({ checkoutEnabled: false })
    await collect(manager.send(target(), { message: 'one', context: { kind: 'pr' } }))
    await settings.write({ checkoutEnabled: true })
    const events = await collect(manager.send(target(), { message: 'two', context: { kind: 'pr' } }))
    expect(events.find(e => e.event === 'turn')).toMatchObject({ seeded: true })
    expect(runner.ensured).toEqual([T1, T1])
    expect(runner.runs[1]?.prompt).toContain('SEED for')
    expect(runner.runs[1]?.cwd).toBe(checkoutDir())
  })
})

describe("createChatManager() and the tour's grilling", () => {
  const T0 = 'pr-review-acme-widgets-42-claude-t0'

  function tourTarget(): ChatTarget {
    const { artifact: _artifact, ...rest } = target()
    return { ...rest, tour: { artifact: syntheticTour(), reader: freshReaderState() } }
  }

  it('runs in the tour thread with the tour seed, which the canvas pane never lists', async () => {
    const events = await collect(
      manager.send(tourTarget(), {
        message: 'I want to change this',
        context: { kind: 'tour-decision', key: 'sum-over-product' },
      })
    )
    expect(events.find(e => e.event === 'turn')).toEqual({
      event: 'turn',
      thread: T0,
      agent: 'claude',
      seeded: true,
    })
    const prompt = runner.runs[0]?.prompt ?? ''
    expect(prompt).toContain('TOUR SEED for')
    expect(prompt).toContain('`sum-over-product` · trade-off')
    expect(prompt).toContain('## Context: decision `sum-over-product`')
    expect(prompt).not.toContain('SEED for {{')
    expect(runner.runs[0]?.session).toBe(T0)
    expect((await manager.threads(42)).threads).toEqual([])
    expect((await manager.threads(42)).activeThread).toBeNull()
    const history = await manager.tourHistory(42)
    expect(history.name).toBe(T0)
    expect(history.turns.map(t => t.role)).toEqual(['user', 'assistant'])
    // The second turn reuses the thread and the session, so the seed is not sent again.
    await collect(manager.send(tourTarget(), { message: 'more', context: { kind: 'tour-plan' } }))
    expect(runner.runs[1]?.prompt).not.toContain('TOUR SEED')
    expect(runner.runs[1]?.prompt).toContain('## Context: the plan')
    // A canvas thread made afterwards is numbered from one, and the tour thread stays out of the list.
    const canvas = await manager.createThread(42)
    expect(canvas.name).toBe(T1)
    expect((await manager.threads(42)).threads.map(t => t.name)).toEqual([T1])
    await collect(manager.send(target(), { message: 'x', context: { kind: 'pr' }, thread: T0 }))
    expect(runner.runs[2]?.session).toBe(T1)
  })

  it('refuses a turn with neither a canvas nor a tour', async () => {
    const { artifact: _artifact, ...bare } = target()
    await expect(collect(manager.send(bare, { message: 'x', context: { kind: 'pr' } }))).rejects.toThrow(
      'a chat turn needs a canvas or a tour'
    )
  })
})
