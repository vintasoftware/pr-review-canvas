// One turn at a time per pull request: build the prompt, run the agent, stream what it says,
// and keep the transcript. The lock is what makes `CHAT_BUSY` a real answer rather than two
// agents writing into one thread.
import type { AgentRunner } from '../acpx/acpx.js'
import type { ChatContext, ChatEvent, ChatThreadsResponse, ChatTurn } from '../contract/chat.js'
import type { FileEntry, Repo, ReviewArtifact } from '../contract/review-artifact.js'
import type { Settings, SettingsOverrides } from '../contract/settings.js'
import type { ChatThread } from '../contract/state.js'
import type { SettingsStore } from '../store/settings-store.js'
import type { StateStore } from '../store/state-store.js'
import { type ContextSources, renderChatContext } from './context.js'
import { renderSeed, type SeedPaths } from './seed.js'
import { NEW_THREAD_TITLE, nextThreadIndex, type TranscriptStore, threadName, threadTitle } from './threads.js'

export class ChatBusyError extends Error {
  constructor() {
    super('a chat turn is already running for this pull request')
    this.name = 'ChatBusyError'
  }
}

export interface ChatManagerDeps {
  runner: AgentRunner
  settings: SettingsStore
  state: StateStore
  transcripts: TranscriptStore
  repo: Repo
  repoRoot: string
  /** `serve --agent/--model`, which win over the settings file. */
  overrides: SettingsOverrides
  loadSeedTemplate: () => Promise<string>
  now: () => Date
}

/** Everything about the pull request one turn needs, resolved by the route. */
export interface ChatTarget {
  prNumber: number
  headSha: string
  artifact: ReviewArtifact
  files: FileEntry[]
  patches: Record<string, string>
  /** `<canvas>/derived`, which holds head/, base/ and patches/. */
  derivedDir: string
  readLines: ContextSources['readLines']
}

export interface ChatSendInput {
  message: string
  context: ChatContext
  thread?: string | undefined
}

export interface ChatManager {
  effectiveSettings(): Promise<Settings>
  threads(prNumber: number): Promise<ChatThreadsResponse>
  createThread(prNumber: number): Promise<ChatThread>
  selectThread(prNumber: number, name: string): Promise<ChatThread | null>
  send(target: ChatTarget, input: ChatSendInput): AsyncIterable<ChatEvent>
  /** True when a turn was running and has been asked to stop. */
  cancel(prNumber: number): Promise<boolean>
  busy(prNumber: number): boolean
}

/** The slot a turn holds while it runs. The handle is filled in once the agent has started. */
interface RunningTurn {
  run: { cancel: () => Promise<void> } | null
  /** True once a stop arrived, which can be before the agent has started. */
  stopped: boolean
}

export function createChatManager(deps: ChatManagerDeps): ChatManager {
  const running = new Map<number, RunningTurn>()

  const effectiveSettings = async (): Promise<Settings> => {
    const saved = await deps.settings.read()
    return {
      ...saved,
      ...(deps.overrides.agent === undefined ? {} : { agent: deps.overrides.agent }),
      ...(deps.overrides.model === undefined ? {} : { model: deps.overrides.model }),
    }
  }

  const newThread = async (prNumber: number, agent: string): Promise<ChatThread> => {
    const at = deps.now().toISOString()
    let created: ChatThread | null = null
    await deps.state.update(prNumber, state => {
      const thread: ChatThread = {
        name: threadName(deps.repo, prNumber, agent, nextThreadIndex(state.chat.threads)),
        agent,
        rev: 0,
        title: NEW_THREAD_TITLE,
        createdAt: at,
        seededHeadSha: '',
      }
      created = thread
      return { ...state, chat: { threads: [...state.chat.threads, thread], activeThread: thread.name } }
    })
    if (created === null) {
      throw new Error('the thread was not created')
    }
    return created
  }

  /** The thread a message goes to: the one asked for, the active one, or a fresh one. */
  const resolveThread = async (prNumber: number, agent: string, wanted?: string): Promise<ChatThread> => {
    const state = await deps.state.read(prNumber)
    const byName = wanted === undefined ? undefined : state.chat.threads.find(t => t.name === wanted)
    const active =
      byName ??
      (state.chat.activeThread === undefined
        ? undefined
        : state.chat.threads.find(t => t.name === state.chat.activeThread))
    // Changing the agent starts a new thread: the old session belongs to the old agent.
    if (active === undefined || active.agent !== agent) {
      return newThread(prNumber, agent)
    }
    if (state.chat.activeThread !== active.name) {
      await deps.state.update(prNumber, current => ({
        ...current,
        chat: { ...current.chat, activeThread: active.name },
      }))
    }
    return active
  }

  /**
   * Writes the answer down. A turn the agent never took leaves the thread as it was, so the next
   * try creates the session again and sends the seed again.
   */
  const saveTurn = async (
    prNumber: number,
    thread: ChatThread,
    userText: string,
    assistant: ChatTurn,
    seededHeadSha: string,
    reached: boolean
  ): Promise<void> => {
    await deps.transcripts.append(prNumber, thread.name, assistant)
    if (!reached) {
      return
    }
    await deps.state.update(prNumber, state => ({
      ...state,
      chat: {
        ...state.chat,
        threads: state.chat.threads.map(t =>
          t.name === thread.name
            ? {
                ...t,
                rev: t.rev + 1,
                seededHeadSha,
                // The first turn of a thread gives it its title.
                title: t.rev === 0 ? threadTitle(userText) : t.title,
              }
            : t
        ),
      },
    }))
  }

  /**
   * Clears the mark that says this thread has been seeded. The agent lost the acpx session behind
   * it, so the next turn creates the session again and sends the seed with it. The revision keeps
   * counting the turns the thread has taken, which is what its title is keyed on.
   */
  const forgetSession = async (prNumber: number, name: string): Promise<void> => {
    await deps.state.update(prNumber, state => ({
      ...state,
      chat: {
        ...state.chat,
        threads: state.chat.threads.map(t => (t.name === name ? { ...t, seededHeadSha: '' } : t)),
      },
    }))
  }

  async function* send(target: ChatTarget, input: ChatSendInput): AsyncIterable<ChatEvent> {
    if (running.has(target.prNumber)) {
      throw new ChatBusyError()
    }
    // The slot is taken before the first await, so a second request that arrives while this one
    // is still reading the settings sees a busy chat rather than starting a second agent.
    const slot: RunningTurn = { run: null, stopped: false }
    running.set(target.prNumber, slot)
    try {
      yield* runTurn(target, input, slot)
    } finally {
      running.delete(target.prNumber)
    }
  }

  async function* runTurn(target: ChatTarget, input: ChatSendInput, slot: RunningTurn): AsyncIterable<ChatEvent> {
    const settings = await effectiveSettings()
    const thread = await resolveThread(target.prNumber, settings.agent, input.thread)
    const seeded = thread.seededHeadSha !== target.headSha
    const at = deps.now().toISOString()
    const contextBlock = await renderChatContext(input.context, {
      artifact: target.artifact,
      files: target.files,
      patches: target.patches,
      readLines: target.readLines,
    })
    const seed = seeded
      ? `${renderSeed(await deps.loadSeedTemplate(), target.artifact, seedPaths(deps, target))}\n\n`
      : ''
    const prompt = `${seed}${contextBlock}\n\n## Question\n\n${input.message}\n`

    // A thread that has never been seeded has no acpx session behind it either.
    if (thread.seededHeadSha === '') {
      await deps.runner.ensureSession({
        agent: settings.agent,
        session: thread.name,
        cwd: deps.repoRoot,
        timeoutSec: settings.chatTimeoutSec,
      })
    }

    await deps.transcripts.append(target.prNumber, thread.name, {
      role: 'user',
      text: input.message,
      at,
      context: input.context,
    })

    // A stop that arrived while the turn was setting up means no agent is started at all. The
    // transcript is written before the events, so a reader who leaves now still finds it there.
    if (slot.stopped) {
      await saveTurn(
        target.prNumber,
        thread,
        input.message,
        { role: 'assistant', text: '', at: deps.now().toISOString(), incomplete: 'cancelled' },
        target.headSha,
        // The seed never went anywhere, so the thread stays where it was.
        false
      )
      yield { event: 'turn', thread: thread.name, agent: settings.agent, seeded }
      yield { event: 'cancelled' }
      return
    }

    const run = deps.runner.run({
      agent: settings.agent,
      session: thread.name,
      prompt,
      cwd: deps.repoRoot,
      timeoutSec: settings.chatTimeoutSec,
      model: settings.model ?? undefined,
      maxTurns: settings.maxTurns ?? undefined,
      // The runner scrubs the line before it gets here; this only writes it down.
      onRawLine: line => {
        void deps.transcripts.appendEvent(target.prNumber, thread.name, line).catch(() => undefined)
      },
    })
    slot.run = run
    // A stop between the spawn above and the loop below reaches the agent through its handle.
    if (slot.stopped) {
      void run.cancel().catch(() => undefined)
    }

    let answer = ''
    let incomplete: string | undefined
    let ended = false
    try {
      yield { event: 'turn', thread: thread.name, agent: settings.agent, seeded }
      for await (const event of run.events) {
        switch (event.type) {
          case 'chunk':
            answer += event.text
            yield { event: 'chunk', text: event.text }
            break
          case 'thought':
            yield { event: 'thought', text: event.text }
            break
          case 'tool':
            yield { event: 'tool', id: event.id, title: event.title, status: event.status }
            break
          case 'done':
            if (event.stopReason === 'cancelled') {
              incomplete = 'cancelled'
              yield { event: 'cancelled' }
            } else if (event.stopReason === 'end_turn') {
              yield { event: 'done', stopReason: event.stopReason }
            } else {
              incomplete = event.stopReason
              yield {
                event: 'error',
                code: 'AGENT_INCOMPLETE',
                message: `the agent stopped early (${event.stopReason})`,
              }
            }
            break
          case 'error':
            incomplete = event.code
            yield { event: 'error', code: event.code, message: event.message, ...hintFor(event.code) }
            break
          default:
            break
        }
      }
      ended = true
    } finally {
      // A reader that went away leaves the agent running, so the turn is stopped with it, and
      // what it had said by then is a partial answer rather than the whole one.
      if (!ended) {
        incomplete ??= 'cancelled'
        await run.cancel().catch(() => undefined)
      }
      await saveTurn(
        target.prNumber,
        thread,
        input.message,
        {
          role: 'assistant',
          text: answer,
          at: deps.now().toISOString(),
          ...(incomplete === undefined ? {} : { incomplete }),
        },
        target.headSha,
        // An error before the agent said anything means the turn never reached it.
        answer !== '' || incomplete === undefined || incomplete === 'cancelled'
      )
      if (incomplete === 'AGENT_NO_SESSION') {
        await forgetSession(target.prNumber, thread.name)
      }
    }
  }

  return {
    effectiveSettings,
    async threads(prNumber) {
      const [state, settings] = await Promise.all([deps.state.read(prNumber), effectiveSettings()])
      return {
        threads: state.chat.threads.map(t => ({
          name: t.name,
          agent: t.agent,
          title: t.title,
          createdAt: t.createdAt,
        })),
        activeThread: state.chat.activeThread ?? null,
        agent: settings.agent,
      }
    },
    async createThread(prNumber) {
      const settings = await effectiveSettings()
      return newThread(prNumber, settings.agent)
    },
    async selectThread(prNumber, name) {
      const state = await deps.state.read(prNumber)
      const thread = state.chat.threads.find(t => t.name === name)
      if (thread === undefined) {
        return null
      }
      await deps.state.update(prNumber, current => ({ ...current, chat: { ...current.chat, activeThread: name } }))
      return thread
    },
    send,
    async cancel(prNumber) {
      const slot = running.get(prNumber)
      if (slot === undefined) {
        return false
      }
      // A turn whose agent has not started yet is stopped by the flag: `runTurn` reads it the
      // moment it has a handle, so the stop is never lost to the setup it arrived during.
      slot.stopped = true
      await slot.run?.cancel()
      return true
    },
    busy: prNumber => running.has(prNumber),
  }
}

function seedPaths(deps: ChatManagerDeps, target: ChatTarget): SeedPaths {
  return {
    headDir: `${target.derivedDir}/head`,
    baseDir: `${target.derivedDir}/base`,
    patchDir: `${target.derivedDir}/patches`,
    repoRoot: deps.repoRoot,
  }
}

function hintFor(code: string): { hint?: string } {
  if (code === 'AGENT_AUTH_REQUIRED') {
    return { hint: 'log the agent in from a terminal, then try again' }
  }
  if (code === 'AGENT_MISSING') {
    return { hint: 'install acpx and the agent CLI, then reload' }
  }
  return {}
}
