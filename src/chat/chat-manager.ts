// One turn at a time per pull request: build the prompt, run the agent, stream what it says,
// and keep the transcript. The lock is what makes `CHAT_BUSY` a real answer rather than two
// agents writing into one thread.
import { type AgentRunner, CANCEL_TIMEOUT_SEC, KILL_GRACE_MS } from '../acpx/acpx.js'
import { latestModel } from '../acpx/models.js'
import {
  type ChatContext,
  type ChatEvent,
  type ChatHistoryResponse,
  type ChatThreadsResponse,
  type ChatTurn,
  chatContextLabel,
  sameChatContext,
  threadOfPlace,
  type TourChatThreadsResponse,
  type TourGrillContext,
  type TourPlace,
  tourPlaceLabel,
} from '../contract/chat.js'
import type { FileEntry, Repo, ReviewArtifact } from '../contract/review-artifact.js'
import type { TourReaderState } from '../contract/tour-api.js'
import type { TourArtifact } from '../contract/tour.js'
import type { Settings, SettingsOverrides } from '../contract/settings.js'
import { parseReviewFolder, type ReviewKey, reviewFolder } from '../contract/review-key.js'
import type { ChatThread } from '../contract/state.js'
import type { SettingsStore } from '../store/settings-store.js'
import type { StateStore } from '../store/state-store.js'
import { type CheckoutLease, readCodeAt, type ReviewCheckouts } from './checkouts.js'
import { renderChatContext, renderTourContext } from './context.js'
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

/**
 * How long a new turn waits for a stopped one to let go before it is refused: as long as the
 * runner gives a stopped agent to end.
 */
export const STOPPED_TURN_WAIT_MS = CANCEL_TIMEOUT_SEC * 1000 + KILL_GRACE_MS

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
  /** The seed of a thread of the tour's AI Chat. */
  loadTourChatSeedTemplate: () => Promise<string>
  checkouts: ReviewCheckouts
  /** The branch the reader's checkout is on, for the warning when a turn falls back to it. */
  currentBranch: () => Promise<string | null>
  now: () => Date
  /**
   * The turns running over this data dir, in this manager or any other over it. The worktrees of
   * one clone share a pull request's threads and review checkout, and so its turn: each of their
   * managers sees and stops it. Each worktree's local reviews are its own. A manager of its own
   * has turns of its own.
   */
  turns?: RunningTurns | undefined
  /** The linked worktree the manager's checkout is, null for the main checkout: it names which local reviews are its own. */
  worktree?: string | null | undefined
}

/** The turns running over one data dir, by review folder (`reviewFolder`). */
export type RunningTurns = Map<string, RunningTurn>

/**
 * What a turn is about and what it points at: the canvas, with one of its contexts and the thread
 * to answer in; the tour's grilling, with a decision or the plan, in the tour's own thread; or the
 * tour's AI Chat, with a place of the tour and the thread to answer in.
 */
export type ChatSubject =
  | {
      kind: 'canvas'
      artifact: ReviewArtifact
      /** Whether the reader may resolve the points of this canvas, so the agent may propose it. */
      readerResolves: boolean
      context: ChatContext
      /** The thread to answer in; the active one when absent. */
      thread?: string | undefined
    }
  | { kind: 'tour'; artifact: TourArtifact; reader: TourReaderState; context: TourGrillContext }
  | {
      kind: 'tour-chat'
      artifact: TourArtifact
      reader: TourReaderState
      context: TourPlace
      /** The tour thread to answer in; the place's thread when absent. */
      thread?: string | undefined
    }

/** Everything about the review target one turn needs, resolved by the route. */
export interface ChatTarget {
  key: ReviewKey
  headSha: string
  subject: ChatSubject
  files: FileEntry[]
  patches: Record<string, string>
  /** `<canvas>/derived`, which holds head/, base/ and patches/. */
  derivedDir: string
  readLines: (side: 'head' | 'base', path: string, from: number, to: number) => Promise<string[] | null>
}

export interface ChatManager {
  effectiveSettings(): Promise<Settings>
  threads(key: ReviewKey): Promise<ChatThreadsResponse>
  createThread(key: ReviewKey): Promise<ChatThread>
  selectThread(key: ReviewKey, name: string): Promise<ChatThread | null>
  /** Records how many of a thread's answers the reader has not seen; null for no such thread. */
  markUnseen(key: ReviewKey, name: string, unseen: number): Promise<ChatThread | null>
  send(target: ChatTarget, message: string): AsyncIterable<ChatEvent>
  /** The transcript of the tour's thread, empty before the first grilling. */
  tourHistory(key: ReviewKey): Promise<ChatHistoryResponse>
  /** The threads of the tour's AI Chat, each about a place of the tour. */
  tourThreads(key: ReviewKey): Promise<TourChatThreadsResponse>
  /** True when a turn was running and has been asked to stop. */
  cancel(key: ReviewKey): Promise<boolean>
  /**
   * The reviews with a turn running that are this checkout's: a pull request's, which every
   * worktree of the clone shares, or one of its own local reviews. The server checks it before it
   * removes the project.
   */
  running(): ReviewKey[]
}

/** The slot a turn holds while it runs. The handle is filled in once the agent has started. */
export interface RunningTurn {
  run: { cancel: () => Promise<void> } | null
  /** The review checkout this turn holds, released when the turn ends. */
  lease: CheckoutLease | null
  /** True once a stop arrived, which can be before the agent has started. */
  stopped: boolean
  /** Settles once the turn has let go of the lock. */
  ended: Promise<void>
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
  const turns: RunningTurns = deps.turns ?? new Map()
  const worktree = deps.worktree ?? null
  const folderOf = (key: ReviewKey): string => reviewFolder(key, worktree)

  const effectiveSettings = async (): Promise<Settings> => {
    const saved = await deps.settings.read()
    return {
      ...saved,
      ...(deps.overrides.chatAgent === undefined ? {} : { chatAgent: deps.overrides.chatAgent }),
      ...(deps.overrides.chatModel === undefined ? {} : { chatModel: deps.overrides.chatModel }),
    }
  }

  /**
   * Makes a thread. `opens` makes it the thread the pane opens next: new thread is the reader
   * opening one. A question's thread is not, since the reader may be reading another thread by the
   * time it is made; the pane records the thread it shows. A thread of the tour's AI Chat has a
   * place of the tour instead of an anchor, and the canvas's pane never lists it.
   */
  const newThread = async (
    key: ReviewKey,
    agent: string,
    made: {
      opens: boolean
      anchored?: { anchor: ChatContext; title: string }
      toured?: { place: TourPlace; title: string }
    }
  ): Promise<ChatThread> => {
    const { anchored, toured } = made
    const at = deps.now().toISOString()
    let created: ChatThread | null = null
    await deps.state.update(key, state => {
      const thread: ChatThread = {
        name: threadName(deps.repo, key, agent, nextThreadIndex(state.chat.threads)),
        agent,
        rev: 0,
        title: anchored?.title ?? toured?.title ?? NEW_THREAD_TITLE,
        createdAt: at,
        seededHeadSha: '',
        ...(anchored === undefined ? {} : { anchor: anchored.anchor }),
        ...(toured === undefined ? {} : { tour: true, place: toured.place }),
      }
      created = thread
      return {
        ...state,
        chat: {
          ...state.chat,
          threads: [...state.chat.threads, thread],
          ...(made.opens ? { activeThread: thread.name } : {}),
        },
      }
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

  /**
   * The thread a message goes to: the one it names, while it is this agent's; else, when the
   * reader keeps a thread per place, the thread of the place it is about; else a new thread, named
   * after that place when it has one. A thread of another agent is not continued: its session
   * belongs to that agent.
   */
  const resolveThread = async (
    key: ReviewKey,
    settings: Settings,
    wanted: string | undefined,
    context: ChatContext,
    artifact: ReviewArtifact
  ): Promise<ChatThread> => {
    const agent = settings.chatAgent
    const state = await deps.state.read(key)
    // A question about the whole PR that names no thread comes from new thread, so it starts one.
    const place = settings.chatThreadPerPlace && context.kind !== 'pr' ? context : undefined
    const thread =
      state.chat.threads.find(t => t.name === wanted && t.agent === agent && t.tour !== true) ??
      (place === undefined ? undefined : threadOfPlace(state.chat.threads, agent, place))
    if (thread === undefined) {
      return newThread(key, agent, {
        opens: false,
        ...(place === undefined
          ? {}
          : {
              anchored: {
                anchor: place,
                title: threadTitle(
                  chatContextLabel(
                    place,
                    id => artifact.layers.find(layer => layer.id === id)?.title,
                    fingerprint => artifact.points.find(point => point.fingerprint === fingerprint)?.title
                  )
                ),
              },
            }),
      })
    }
    return thread
  }

  /**
   * The tour chat thread a question goes to: the one it names, while it is this agent's thread of
   * the tour's AI Chat; else this agent's thread of the place; else a new thread titled after the
   * place. A question about the whole tour that names no thread comes from new thread, so it starts
   * one, as a question about the whole PR does on the canvas.
   */
  const resolveTourThread = async (
    key: ReviewKey,
    agent: string,
    wanted: string | undefined,
    place: TourPlace,
    artifact: TourArtifact
  ): Promise<ChatThread> => {
    const state = await deps.state.read(key)
    const ofTour = state.chat.threads.filter(t => t.place !== undefined && t.agent === agent)
    const thread =
      ofTour.find(t => t.name === wanted) ??
      (place.kind === 'tour'
        ? undefined
        : ofTour.findLast(t => t.place !== undefined && sameChatContext(t.place, place)))
    return (
      thread ??
      newThread(key, agent, {
        opens: false,
        toured: { place, title: threadTitle(tourPlaceLabel(place, artifact)) },
      })
    )
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
    seededReaderResolves: boolean,
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
                seededReaderResolves,
                // The first turn of a general thread gives it its title; an anchored one, or a
                // tour place's, is named after its place.
                title:
                  t.rev === 0 && t.anchor === undefined && t.place === undefined
                    ? threadTitle(userText)
                    : t.title,
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

  async function* send(target: ChatTarget, message: string): AsyncIterable<ChatEvent> {
    const folder = folderOf(target.key)
    const held = turns.get(folder)
    if (held !== undefined) {
      if (!held.stopped) {
        throw new ChatBusyError()
      }
      // A stopped turn is only finishing up, as when the reader left and came back: this turn
      // waits for it rather than being refused.
      await settlesWithin(held.ended, STOPPED_TURN_WAIT_MS)
      if (turns.has(folder)) {
        throw new ChatBusyError()
      }
    }
    // The slot is taken with no await since the check, so a second request that arrives while
    // this one is still reading the settings sees a busy chat rather than starting a second agent.
    let end = (): void => undefined
    const ended = new Promise<void>(resolve => {
      end = resolve
    })
    const slot: RunningTurn = { run: null, stopped: false, lease: null, ended }
    turns.set(folder, slot)
    try {
      yield* runTurn(target, message, slot)
    } finally {
      // The lock goes first, so a slot that looks free always has a free checkout behind it.
      await slot.lease?.release().catch(() => undefined)
      turns.delete(folder)
      end()
    }
  }

  /**
   * Where the agent reads code for this turn (see `readCodeAt`), and the events that say so. The
   * checkout is leased before the first event, so a holder elsewhere refuses the turn.
   */
  async function* prepareCode(
    target: ChatTarget,
    settings: Settings,
    slot: RunningTurn
  ): AsyncGenerator<ChatEvent, CodeSource> {
    const steps = readCodeAt({
      key: target.key,
      headSha: target.headSha,
      checkoutEnabled: settings.checkoutEnabled,
      holder: 'chat',
      checkouts: deps.checkouts,
      repoRoot: deps.repoRoot,
      currentBranch: deps.currentBranch,
      onLease: lease => {
        slot.lease = lease
      },
    })
    for (;;) {
      const next = await steps.next()
      if (next.done === true) {
        return next.value
      }
      yield { event: 'checkout', ...next.value }
    }
  }

  async function* runTurn(target: ChatTarget, message: string, slot: RunningTurn): AsyncIterable<ChatEvent> {
    const settings = await effectiveSettings()
    const { subject } = target
    const at = deps.now().toISOString()
    const contextBlock =
      subject.kind === 'canvas'
        ? await renderChatContext(subject.context, {
            artifact: subject.artifact,
            files: target.files,
            patches: target.patches,
            readLines: target.readLines,
          })
        : renderTourContext(subject.context, subject)
    // The seed says whether the reader may resolve points; a tour's reader restates instead.
    const readerResolves = subject.kind === 'canvas' && subject.readerResolves
    const code = yield* prepareCode(target, settings, slot)
    const { cwd } = code
    // Resolved once nothing above can refuse the question: a question that names no thread makes
    // one, and a refused one would leave it empty, under no name the pane ever heard.
    const thread =
      subject.kind === 'canvas'
        ? await resolveThread(target.key, settings, subject.thread, subject.context, subject.artifact)
        : subject.kind === 'tour-chat'
          ? await resolveTourThread(
              target.key,
              settings.chatAgent,
              subject.thread,
              subject.context,
              subject.artifact
            )
          : await tourThread(target.key, settings.chatAgent)
    // Saved on the answer, so the warning is still there when the thread is opened again.
    const fallback: Pick<ChatTurn, 'fallback'> =
      code.kind === 'fallback' ? { fallback: { message: code.message, branch: code.branch } } : {}
    // acpx scopes a session by its folder, so a thread whose session ran elsewhere starts over.
    const sameSession = thread.seededHeadSha !== '' && (thread.seededCwd ?? deps.repoRoot) === cwd
    const seeded =
      !sameSession ||
      thread.seededHeadSha !== target.headSha ||
      thread.seededReaderResolves !== readerResolves
    const seed = seeded ? `${await renderSubjectSeed(deps, target, code)}\n\n` : ''
    const prompt = `${seed}${contextBlock}\n\n## Question\n\n${message}\n`

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
      text: message,
      at,
      context: subject.context,
    })

    const model = await modelForTurn(deps.runner, settings, thread.name, cwd)

    // A stop that arrived while the turn was setting up means no agent is started at all. The
    // transcript is written before the events, so a reader who leaves now still finds it there.
    if (slot.stopped) {
      await saveTurn(
        target.key,
        thread,
        message,
        { role: 'assistant', text: '', at: deps.now().toISOString(), incomplete: 'cancelled', ...fallback },
        target.headSha,
        cwd,
        readerResolves,
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
        message,
        {
          role: 'assistant',
          text: answer,
          at: deps.now().toISOString(),
          ...(incomplete === undefined ? {} : { incomplete }),
          ...fallback,
        },
        target.headSha,
        cwd,
        readerResolves,
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
            turns: t.rev,
            ...(t.anchor === undefined ? {} : { anchor: t.anchor }),
            ...(t.unseen === undefined || t.unseen === 0 ? {} : { unseen: t.unseen }),
          })),
        activeThread: state.chat.activeThread ?? null,
        agent: settings.chatAgent,
      }
    },
    async createThread(key) {
      const settings = await effectiveSettings()
      return newThread(key, settings.chatAgent, { opens: true })
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
    async markUnseen(key, name, unseen) {
      let marked: ChatThread | null = null
      await deps.state.update(key, current => ({
        ...current,
        chat: {
          ...current.chat,
          threads: current.chat.threads.map(t => {
            if (t.name !== name) {
              return t
            }
            const { unseen: _old, ...rest } = t
            marked = unseen === 0 ? rest : { ...rest, unseen }
            return marked
          }),
        },
      }))
      return marked
    },
    send,
    async tourThreads(key) {
      const [state, settings] = await Promise.all([deps.state.read(key), effectiveSettings()])
      return {
        threads: state.chat.threads.flatMap(t =>
          t.place === undefined
            ? []
            : [
                {
                  name: t.name,
                  agent: t.agent,
                  title: t.title,
                  createdAt: t.createdAt,
                  turns: t.rev,
                  place: t.place,
                  ...(t.unseen === undefined || t.unseen === 0 ? {} : { unseen: t.unseen }),
                },
              ]
        ),
        agent: settings.chatAgent,
      }
    },
    async tourHistory(key) {
      const settings = await effectiveSettings()
      const name = threadName(deps.repo, key, settings.chatAgent, 0)
      return { name, turns: await deps.transcripts.read(key, name) }
    },
    async cancel(key) {
      const slot = turns.get(folderOf(key))
      if (slot === undefined) {
        return false
      }
      // A turn whose agent has not started yet is stopped by the flag: `runTurn` reads it the
      // moment it has a handle, so the stop is never lost to the setup it arrived during.
      slot.stopped = true
      await slot.run?.cancel()
      return true
    },
    running: () =>
      [...turns.keys()].flatMap(folder => {
        const review = parseReviewFolder(folder)
        return review !== null && folderOf(review.key) === folder ? [review.key] : []
      }),
  }
}

/** The seed of the subject: the grilling's or the tour chat's on the tour page, the canvas's for its chat. */
async function renderSubjectSeed(
  deps: ChatManagerDeps,
  target: ChatTarget,
  code: CodeSource
): Promise<string> {
  const paths = seedPaths(deps, target, code)
  const { subject } = target
  if (subject.kind !== 'canvas') {
    const template =
      subject.kind === 'tour' ? await deps.loadTourSeedTemplate() : await deps.loadTourChatSeedTemplate()
    return renderTourSeed(template, subject.artifact, paths)
  }
  return renderSeed(await deps.loadSeedTemplate(), subject.artifact, paths, {
    readerResolves: subject.readerResolves,
  })
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

/** Waits for `promise`, but no longer than `ms`. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    promise,
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
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
