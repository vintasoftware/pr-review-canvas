// An in-memory AgentRunner: route tests and chat-manager tests drive the agent from a script of
// events instead of a process. The spawn path itself is covered by fake-acpx.mjs.
import type { AgentExecResult, AgentRun, AgentRunner, AgentRunOptions } from '../acpx/acpx.js'
import type { AgentEvent } from '../acpx/events.js'

export interface FakeRunnerOptions {
  /** The events one run emits, in order. A function sees the options of that run. */
  script?: AgentEvent[] | ((options: AgentRunOptions) => AgentEvent[])
  /** What `cancel()` turns the rest of the run into; the default ends it as cancelled. */
  onCancel?: 'cancelled' | 'silent'
  exec?: AgentExecResult | ((agent: string) => AgentExecResult)
  acpxVersion?: string | null
  availability?: Record<string, { installed: boolean; authenticated: boolean; reason?: string }>
  /** Waits before each event, so a test can cancel in the middle of a run. */
  delayMs?: number
  /** Holds `ensureSession` until it resolves, so a test can act while a turn is still setting up. */
  ensureGate?: Promise<void>
  /** What `modelUpgrades` answers, per agent. */
  modelUpgrades?: Record<string, Record<string, string>>
  /** What `sessionModel` answers for every session; null by default. */
  sessionModel?: string | null
}

export interface FakeRunner extends AgentRunner {
  /** Every run this runner started, in order. */
  runs: AgentRunOptions[]
  cancelled: string[]
  execs: Array<{ agent: string; prompt: string }>
  /** The sessions the manager asked to have created, in order. */
  ensured: string[]
}

const DEFAULT_SCRIPT: AgentEvent[] = [
  { type: 'chunk', text: 'Yes. ' },
  { type: 'chunk', text: 'The behavior is covered at `src/a.ts:10`.' },
  { type: 'done', stopReason: 'end_turn' },
]

export function createFakeRunner(options: FakeRunnerOptions = {}): FakeRunner {
  const runs: AgentRunOptions[] = []
  const cancelled: string[] = []
  const execs: Array<{ agent: string; prompt: string }> = []
  const ensured: string[] = []

  return {
    runs,
    cancelled,
    execs,
    ensured,
    async ensureSession({ session }) {
      ensured.push(session)
      await options.ensureGate
    },
    run(runOptions): AgentRun {
      runs.push(runOptions)
      const script =
        typeof options.script === 'function' ? options.script(runOptions) : (options.script ?? DEFAULT_SCRIPT)
      let stopped = false
      const events = (async function* emit(): AsyncGenerator<AgentEvent> {
        for (const event of script) {
          if (stopped) {
            break
          }
          if (options.delayMs !== undefined) {
            await new Promise(resolve => setTimeout(resolve, options.delayMs))
          }
          if (stopped) {
            break
          }
          runOptions.onRawLine?.(
            JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { event } })
          )
          yield event
        }
        if (stopped && options.onCancel !== 'silent') {
          yield { type: 'done', stopReason: 'cancelled' }
        }
      })()
      return {
        events,
        cancel: async () => {
          stopped = true
          cancelled.push(runOptions.session)
        },
      }
    },
    async exec({ agent, prompt }) {
      execs.push({ agent, prompt })
      if (typeof options.exec === 'function') {
        return options.exec(agent)
      }
      return options.exec ?? { ok: true, text: 'OK' }
    },
    async acpxVersion() {
      return options.acpxVersion === undefined ? '0.13.2' : options.acpxVersion
    },
    async availability(agent) {
      return options.availability?.[agent] ?? { installed: true, authenticated: true }
    },
    async modelUpgrades(agent) {
      return new Map(Object.entries(options.modelUpgrades?.[agent] ?? {}))
    },
    async sessionModel() {
      return options.sessionModel ?? null
    },
  }
}
