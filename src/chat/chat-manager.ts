// One turn at a time per pull request: build the prompt, run the agent, stream what it says,
// and keep the transcript. The lock is what makes `CHAT_BUSY` a real answer rather than two
// agents writing into one thread.
import type { AgentRunner } from '../acpx/acpx.js'
import { latestModel } from '../acpx/models.js'
import type {
  ChatContext,
  ChatEvent,
  ChatHistoryResponse,
  ChatThreadsResponse,
  ChatTurn,
} from '../contract/chat.js'
import type { FileEntry, Repo, ReviewArtifact } from '../contract/review-artifact.js'
import type { Settings, SettingsOverrides } from '../contract/settings.js'
import type { ReviewKey } from '../contract/review-key.js'
import type { ChatThread } from '../contract/state.js'
import type { SettingsStore } from '../store/settings-store.js'
import type { StateStore } from '../store/state-store.js'
import type { CheckoutLease, ReviewCheckouts } from './checkouts.js'
import { type ContextSources, renderChatContext, type TourSources } from './context.js'
import { type CodeSource, renderSeed, type SeedPaths } from './seed.js'
import { renderTourSeed } from './tour-seed.js'
import {
  NEW_THREAD_TITLE,
  nextThreadIndex,
  type TranscriptStore,
  threadName,
  threadTitle,
} from './threads.js'

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
  /** `serve --chat-agent/--chat-model`, which win over the settings file. */
  overrides: SettingsOverrides
  loadSeedTemplate: () => Promise<string>
  /** The seed of a tour's grilling thread. */
  loadTourSeedTemplate: () => Promise<string>
  checkouts: ReviewCheckouts
  /** The branch the reader's checkout is on, for the warning when a turn falls back to it. */
  currentBranch: () => Promise<string | null>
  now: () => Date
}

/** Everything about the review target one turn needs, resolved by the route. */
export interface ChatTarget {
  key: ReviewKey
  headSha: string
  /** The canvas the chat talks about; absent for a tour's grilling. */
  artifact?: ReviewArtifact | undefined
  /** The tour the grilling talks about: it runs in the tour's own thread with the tour's seed. */
  tour?: TourSources | undefined
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
  threads(key: ReviewKey): Promise<ChatThreadsResponse>
  createThread(key: ReviewKey): Promise<ChatThread>
  selectThread(key: ReviewKey, name: string): Promise<ChatThread | null>
  send(target: ChatTarget, input: ChatSendInput): AsyncIterable<ChatEvent>
  /** The transcript of the tour's thread, empty before the first grilling. */
  tourHistory(key: ReviewKey): Promise<ChatHistoryResponse>
  /** True when a turn was running and has been asked to stop. */
  cancel(key: ReviewKey): Promise<boolean>
  busy(key: ReviewKey): boolean
}

/** The slot a turn holds while it runs. The handle is filled in once the agent has started. */
interface RunningTurn {
  run: { cancel: () => Promise<void> } | null
  /** The review checkout this turn holds, released when the turn ends. */
  lease: CheckoutLease | null
  /** True once a stop arrived, which can be before the agent has started. */
  stopped: boolean
}

/**
 * The `--model` of one turn: the newest model of the saved family. With no saved model the agent's
 * own default applies, unless the session is on a model that has since been replaced: a thread
 * started months ago, or a default set to an old id.
 */
async function modelForTurn(
  runner: AgentRunner,
  settings: Settings,
  session: string,
  cwd: string
): Promise<string | undefined> {
  const upgrades = await runner.modelUpgrades(settings.chatAgent)
  if (settings.chatModel !== null) {
    return latestModel(settings.chatAgent, settings.chatModel, upgrades)
  }
  const current = await runner.sessionModel({ agent: settings.chatAgent, session, cwd })
  if (current === null) {
    return undefined
  }
  const latest = latestModel(settings.chatAgent, current, upgrades)
  return latest === current ? undefined : latest
}

export function createChatManager(deps: ChatManagerDeps): ChatManager {
  const running = new Map<ReviewKey, RunningTurn>()

  const effectiveSettings = async (): Promise<Settings> => {
    const saved = await deps.settings.read()
    return {
      ...saved,
      ...(deps.overrides.chatAgent === undefined ? {} : { chatAgent: deps.overrides.chatAgent }),
      ...(deps.overrides.chatModel === undefined ? {} : { chatModel: deps.overrides.chatModel }),
    }
  }

  const newThread = async (key: ReviewKey, agent: string): Promise<ChatThread> => {
    const at = deps.now().toISOString()
    let created: ChatThread | null = null
    await deps.state.update(key, state => {
      const thread: ChatThread = {
        name: threadName(deps.repo, key, agent, nextThreadIndex(state.chat.threads)),
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

  /**
   * The tour's one thread for this agent, `t0`, which no canvas thread is ever numbered. It is
   * created when the first grilling turn needs it, and never made the active thread: the canvas's
   * pane does not list it.
   */
  const tourThread = async (key: ReviewKey, agent: string): Promise<ChatThread> => {
    const name = threadName(deps.repo, key, agent, 0)
    const state = await deps.state.read(key)
    const found = state.chat.threads.find(t => t.name === name)
    if (found !== undefined) {
      return found
    }
    const thread: ChatThread = {
      name,
      agent,
      rev: 0,
      title: 'The tour',
      createdAt: deps.now().toISOString(),
      seededHeadSha: '',
      tour: true,
    }
    await deps.state.update(key, current => ({
      ...current,
      chat: { ...current.chat, threads: [...current.chat.threads, thread] },
    }))
    return thread
  }

  /** The thread a message goes to: the one asked for, the active one, or a fresh one. */
  const resolveThread = async (key: ReviewKey, agent: string, wanted?: string): Promise<ChatThread> => {
    const state = await deps.state.read(key)
    const byName =
      wanted === undefined ? undefined : state.chat.threads.find(t => t.name === wanted && t.tour !== true)
    const active =
      byName ??
      (state.chat.activeThread === undefined
        ? undefined
        : state.chat.threads.find(t => t.name === state.chat.activeThread && t.tour !== true))
    // Changing the agent starts a new thread: the old session belongs to the old agent.
    if (active === undefined || active.agent !== agent) {
      return newThread(key, agent)
    }
    if (state.chat.activeThread !== active.name) {
      await deps.state.update(key, current => ({
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
    key: ReviewKey,
    thread: ChatThread,
    userText: string,
    assistant: ChatTurn,
    seededHeadSha: string,
    seededCwd: string,
    reached: boolean
  ): Promise<void> => {
    await deps.transcripts.append(key, thread.name, assistant)
    if (!reached) {
      return
    }
    await deps.state.update(key, state => ({
      ...state,
      chat: {
        ...state.chat,
        threads: state.chat.threads.map(t =>
          t.name === thread.name
            ? {
                ...t,
                rev: t.rev + 1,
                seededHeadSha,
                seededCwd,
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
  const forgetSession = async (key: ReviewKey, name: string): Promise<void> => {
    await deps.state.update(key, state => ({
      ...state,
      chat: {
        ...state.chat,
        threads: state.chat.threads.map(t => (t.name === name ? { ...t, seededHeadSha: '' } : t)),
      },
    }))
  }

  async function* send(target: ChatTarget, input: ChatSendInput): AsyncIterable<ChatEvent> {
    if (running.has(target.key)) {
      throw new ChatBusyError()
    }
    // The slot is taken before the first await, so a second request that arrives while this one
    // is still reading the settings sees a busy chat rather than starting a second agent.
    const slot: RunningTurn = { run: null, stopped: false, lease: null }
    running.set(target.key, slot)
    try {
      yield* runTurn(target, input, slot)
    } finally {
      // The lock goes first, so a slot that looks free always has a free checkout behind it.
      await slot.lease?.release().catch(() => undefined)
      running.delete(target.key)
    }
  }

  /**
   * Where the agent reads code for this turn, and the events that say so. The uncommitted review,
   * and a reader who turned checkouts off, read the reader's own checkout. Otherwise the review
   * checkout is leased before the first event, so another process holding it is a refusal, and
   * then put at the turn's commit; a checkout that fails falls back to the reader's checkout with
   * a warning rather than failing the turn.
   */
  async function* prepareCode(
    target: ChatTarget,
    settings: Settings,
    slot: RunningTurn
  ): AsyncGenerator<ChatEvent, CodeSource> {
    if (target.key === 'uncommitted') {
      return { kind: 'working-tree', cwd: deps.repoRoot }
    }
    if (!settings.checkoutEnabled) {
      return { kind: 'reader-checkout', cwd: deps.repoRoot }
    }
    const lease = await deps.checkouts.lease(target.key)
    slot.lease = lease
    if (lease.head !== target.headSha) {
      yield { event: 'checkout', status: 'preparing', sha: target.headSha, creating: lease.head === null }
    }
    try {
      await lease.moveTo(target.headSha)
      return { kind: 'checkout', cwd: lease.dir, sha: target.headSha }
    } catch (err) {
      const fallback = {
        message: err instanceof Error ? err.message : String(err),
        branch: await deps.currentBranch().catch(() => null),
      }
      yield { event: 'checkout', status: 'fallback', ...fallback }
      return { kind: 'fallback', cwd: deps.repoRoot, ...fallback }
    }
  }

  async function* runTurn(
    target: ChatTarget,
    input: ChatSendInput,
    slot: RunningTurn
  ): AsyncIterable<ChatEvent> {
    const settings = await effectiveSettings()
    const thread =
      target.tour === undefined
        ? await resolveThread(target.key, settings.chatAgent, input.thread)
        : await tourThread(target.key, settings.chatAgent)
    const at = deps.now().toISOString()
    const contextBlock = await renderChatContext(input.context, {
      artifact: target.artifact,
      tour: target.tour,
      files: target.files,
      patches: target.patches,
      readLines: target.readLines,
    })
    const code = yield* prepareCode(target, settings, slot)
    const { cwd } = code
    // Saved on the answer, so the warning is still there when the thread is opened again.
    const fallback: Pick<ChatTurn, 'fallback'> =
      code.kind === 'fallback' ? { fallback: { message: code.message, branch: code.branch } } : {}
    // acpx scopes a session by its folder, so a thread whose session ran elsewhere starts over.
    const sameSession = thread.seededHeadSha !== '' && (thread.seededCwd ?? deps.repoRoot) === cwd
    const seeded = !sameSession || thread.seededHeadSha !== target.headSha
    const seed = seeded ? `${await renderSubjectSeed(deps, target, code)}\n\n` : ''
    const prompt = `${seed}${contextBlock}\n\n## Question\n\n${input.message}\n`

    if (!sameSession) {
      await deps.runner.ensureSession({
        agent: settings.chatAgent,
        session: thread.name,
        cwd,
        timeoutSec: settings.chatTimeoutSec,
      })
    }
    await deps.transcripts.append(target.key, thread.name, {
      role: 'user',
      text: input.message,
      at,
      context: input.context,
    })

    const model = await modelForTurn(deps.runner, settings, thread.name, cwd)

    // A stop that arrived while the turn was setting up means no agent is started at all. The
    // transcript is written before the events, so a reader who leaves now still finds it there.
    if (slot.stopped) {
      await saveTurn(
        target.key,
        thread,
        input.message,
        { role: 'assistant', text: '', at: deps.now().toISOString(), incomplete: 'cancelled', ...fallback },
        target.headSha,
        cwd,
        // The seed never went anywhere, so the thread stays where it was.
        false
      )
      yield { event: 'turn', thread: thread.name, agent: settings.chatAgent, seeded }
      yield { event: 'cancelled' }
      return
    }

    const run = deps.runner.run({
      agent: settings.chatAgent,
      session: thread.name,
      prompt,
      cwd,
      timeoutSec: settings.chatTimeoutSec,
      model,
      maxTurns: settings.maxTurns ?? undefined,
      // The runner scrubs the line before it gets here; this only writes it down.
      onRawLine: line => {
        void deps.transcripts.appendEvent(target.key, thread.name, line).catch(() => undefined)
      },
    })
    slot.run = run
    // A stop between the spawn above and the loop below reaches the agent through its handle.
    if (slot.stopped) {
      void run.cancel().catch(() => undefined)
    }

    let answer = ''
    let textAfterTool = false
    let incomplete: string | undefined
    let ended = false
    try {
      yield { event: 'turn', thread: thread.name, agent: settings.chatAgent, seeded }
      for await (const event of run.events) {
        switch (event.type) {
          case 'chunk': {
            let text = event.text
            if (text !== '') {
              // Tool calls separate text runs; ordinary token chunks must still join verbatim.
              if (textAfterTool && /\S$/.test(answer) && /^\S/.test(text)) {
                text = ` ${text}`
              }
              textAfterTool = false
            }
            answer += text
            yield { event: 'chunk', text }
            break
          }
          case 'thought':
            yield { event: 'thought', text: event.text }
            break
          case 'tool':
            textAfterTool = true
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
        // A stop that already reached the agent through `cancel` is not sent twice.
        if (!slot.stopped) {
          await run.cancel().catch(() => undefined)
        }
      }
      await saveTurn(
        target.key,
        thread,
        input.message,
        {
          role: 'assistant',
          text: answer,
          at: deps.now().toISOString(),
          ...(incomplete === undefined ? {} : { incomplete }),
          ...fallback,
        },
        target.headSha,
        cwd,
        // An error before the agent said anything means the turn never reached it.
        answer !== '' || incomplete === undefined || incomplete === 'cancelled'
      )
      if (incomplete === 'AGENT_NO_SESSION') {
        await forgetSession(target.key, thread.name)
      }
    }
  }

  return {
    effectiveSettings,
    async threads(key) {
      const [state, settings] = await Promise.all([deps.state.read(key), effectiveSettings()])
      return {
        threads: state.chat.threads
          .filter(t => t.tour !== true)
          .map(t => ({
            name: t.name,
            agent: t.agent,
            title: t.title,
            createdAt: t.createdAt,
          })),
        activeThread: state.chat.activeThread ?? null,
        agent: settings.chatAgent,
      }
    },
    async createThread(key) {
      const settings = await effectiveSettings()
      return newThread(key, settings.chatAgent)
    },
    async selectThread(key, name) {
      const state = await deps.state.read(key)
      const thread = state.chat.threads.find(t => t.name === name)
      if (thread === undefined) {
        return null
      }
      await deps.state.update(key, current => ({
        ...current,
        chat: { ...current.chat, activeThread: name },
      }))
      return thread
    },
    send,
    async tourHistory(key) {
      const settings = await effectiveSettings()
      const name = threadName(deps.repo, key, settings.chatAgent, 0)
      return { name, turns: await deps.transcripts.read(key, name) }
    },
    async cancel(key) {
      const slot = running.get(key)
      if (slot === undefined) {
        return false
      }
      // A turn whose agent has not started yet is stopped by the flag: `runTurn` reads it the
      // moment it has a handle, so the stop is never lost to the setup it arrived during.
      slot.stopped = true
      await slot.run?.cancel()
      return true
    },
    busy: key => running.has(key),
  }
}

/** The seed of the subject: the tour's for a grilling, the canvas's for the chat. */
async function renderSubjectSeed(
  deps: ChatManagerDeps,
  target: ChatTarget,
  code: CodeSource
): Promise<string> {
  const paths = seedPaths(deps, target, code)
  if (target.tour !== undefined) {
    return renderTourSeed(await deps.loadTourSeedTemplate(), target.tour.artifact, paths)
  }
  if (target.artifact === undefined) {
    throw new Error('a chat turn needs a canvas or a tour')
  }
  return renderSeed(await deps.loadSeedTemplate(), target.artifact, paths)
}

function seedPaths(deps: ChatManagerDeps, target: ChatTarget, code: CodeSource): SeedPaths {
  return {
    headDir: `${target.derivedDir}/head`,
    baseDir: `${target.derivedDir}/base`,
    patchDir: `${target.derivedDir}/patches`,
    repoRoot: deps.repoRoot,
    code,
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
