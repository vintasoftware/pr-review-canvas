/**
 * The chat's only process boundary: acpx. `AgentRunner` is what the chat manager depends on;
 * this file holds the real adapter and the argument builder. Tests use the in-memory fake in
 * `src/testing/fake-runner.ts` or spawn `src/testing/fake-acpx.mjs` through this adapter.
 */
import { type ChildProcess, execFile, type SpawnOptions, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import {
  type AgentErrorCode,
  type AgentEvent,
  exitCodeMessage,
  exitCodeToAgentCode,
  mapAcpxMessage,
  scrubForLog,
} from './events.js'
import { createNdjsonSplitter, NdjsonError } from './ndjson.js'

const execFileAsync = promisify(execFile)

export const ACPX_BIN = 'acpx'

/** How long the runner waits after its own deadline for acpx to stop on its own. */
export const KILL_GRACE_MS = 3000
/** A cancel that has not answered by then is given up on, and the child is killed instead. */
export const CANCEL_TIMEOUT_SEC = 30
/** The runner's deadline sits this far past acpx's, so acpx reports its own timeout first. */
export const DEADLINE_SLACK_MS = 15_000

export interface AgentRunOptions {
  agent: string
  /** The acpx session name, which is what a chat thread is. */
  session: string
  prompt: string
  cwd: string
  timeoutSec: number
  model?: string | undefined
  maxTurns?: number | undefined
  /**
   * Every acpx line the raw event log may keep. The scrubbing happens here rather than in the
   * caller, so no caller can write a file's content to disk by mistake.
   */
  onRawLine?: (line: string) => void
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>
  /** Asks acpx to cancel the turn, then stops the child. Safe to call more than once. */
  cancel(): Promise<void>
}

export interface AgentExecResult {
  ok: boolean
  text: string
  code?: AgentErrorCode
  message?: string
}

export interface AgentRunner {
  run(options: AgentRunOptions): AgentRun
  /**
   * Creates the named session when it does not exist yet. `prompt -s <name>` refuses an unknown
   * session on some agents (codex says so and exits), so a thread's first turn ensures it.
   */
  ensureSession(options: { agent: string; session: string; cwd: string; timeoutSec: number }): Promise<void>
  /** One real round trip, used by the settings probe. */
  exec(options: { agent: string; prompt: string; cwd: string; timeoutSec: number }): Promise<AgentExecResult>
  /** The acpx version, or null when acpx is not on PATH. */
  acpxVersion(): Promise<string | null>
  /** Whether one agent's own CLI is installed and logged in. */
  availability(agent: string): Promise<{ installed: boolean; authenticated: boolean; reason?: string }>
}

/**
 * The flags every acpx call carries: read-only tool policy, no terminal, JSON on stdout, and
 * file contents kept out of the stream.
 *
 * `--auth-policy fail` is deliberately absent. The spike showed codex refusing to start under
 * it while `codex login status` reported a signed-in account; a real auth failure still arrives
 * as an `AUTH_REQUIRED` error line.
 */
export function commonAcpxArgs(cwd: string, timeoutSec: number): string[] {
  return [
    '--cwd',
    cwd,
    '--format',
    'json',
    '--json-strict',
    '--suppress-reads',
    '--approve-reads',
    '--non-interactive-permissions',
    'deny',
    '--no-terminal',
    '--timeout',
    String(timeoutSec),
  ]
}

export function buildPromptArgs(options: AgentRunOptions): string[] {
  const args = commonAcpxArgs(options.cwd, options.timeoutSec)
  if (options.model !== undefined && options.model !== '') {
    args.push('--model', options.model)
  }
  if (options.maxTurns !== undefined) {
    args.push('--max-turns', String(options.maxTurns))
  }
  args.push(options.agent, '-s', options.session, 'prompt', '-f', '-')
  return args
}

export function buildCancelArgs(agent: string, session: string, cwd: string): string[] {
  return [...commonAcpxArgs(cwd, CANCEL_TIMEOUT_SEC), agent, 'cancel', '-s', session]
}

export function buildEnsureArgs(agent: string, session: string, cwd: string, timeoutSec: number): string[] {
  return [...commonAcpxArgs(cwd, timeoutSec), agent, 'sessions', 'ensure', '-s', session]
}

export function buildExecArgs(agent: string, cwd: string, timeoutSec: number, prompt: string): string[] {
  return [...commonAcpxArgs(cwd, timeoutSec), agent, 'exec', prompt]
}

/** What `claude auth status` / `codex login status` are called, per agent. */
const AUTH_CHECKS: Readonly<Record<string, { bin: string; args: string[] }>> = {
  claude: { bin: 'claude', args: ['auth', 'status'] },
  codex: { bin: 'codex', args: ['login', 'status'] },
}

/** Only the one call shape the runner makes, so a test double is a plain function. */
export type SpawnImpl = (file: string, args: string[], options: SpawnOptions) => ChildProcess
export type ExecFileImpl = (
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number; killSignal?: NodeJS.Signals }
) => Promise<{ stdout: string; stderr: string }>

export interface CreateAgentRunnerOptions {
  bin?: string
  spawnImpl?: SpawnImpl
  execFileImpl?: ExecFileImpl
  /** How far the runner's own deadline sits past acpx's. Tests shorten it. */
  deadlineSlackMs?: number
  /** How long a cancel command is waited for before the child is killed anyway. Tests shorten it. */
  cancelGraceMs?: number
}

/** A queue an async generator reads from while the child writes into it. */
function createEventQueue(): {
  push: (event: AgentEvent) => void
  end: () => void
  iterate: () => AsyncGenerator<AgentEvent>
} {
  const pending: AgentEvent[] = []
  let done = false
  let wake: (() => void) | null = null
  const signal = (): void => {
    const fn = wake
    wake = null
    fn?.()
  }
  return {
    push(event) {
      if (!done) {
        pending.push(event)
        signal()
      }
    },
    end() {
      done = true
      signal()
    },
    async *iterate() {
      for (;;) {
        // Re-read the queue after every yield: an event can arrive while the consumer holds us.
        while (pending.length > 0) {
          for (const next of pending.splice(0)) {
            yield next
          }
        }
        if (done) {
          return
        }
        await new Promise<void>(resolve => {
          wake = resolve
        })
      }
    },
  }
}

export function createAgentRunner(opts: CreateAgentRunnerOptions = {}): AgentRunner {
  const bin = opts.bin ?? ACPX_BIN
  const slackMs = opts.deadlineSlackMs ?? DEADLINE_SLACK_MS
  const cancelGraceMs = opts.cancelGraceMs ?? CANCEL_TIMEOUT_SEC * 1000
  const spawnImpl = opts.spawnImpl ?? spawn
  const run: ExecFileImpl =
    opts.execFileImpl ??
    ((file, args, options) => execFileAsync(file, args, { ...options, encoding: 'utf8', shell: false }))

  const execQuiet = async (
    file: string,
    args: string[],
    options: { cwd?: string; timeoutSec?: number; killSignal?: NodeJS.Signals } = {}
  ): Promise<{ ok: boolean; stdout: string; stderr: string; error?: unknown }> => {
    const call: { cwd?: string; timeout?: number; maxBuffer?: number; killSignal?: NodeJS.Signals } = {
      maxBuffer: 4 * 1024 * 1024,
    }
    if (options.cwd !== undefined) {
      call.cwd = options.cwd
    }
    if (options.timeoutSec !== undefined) {
      call.timeout = options.timeoutSec * 1000
    }
    if (options.killSignal !== undefined) {
      call.killSignal = options.killSignal
    }
    try {
      const { stdout, stderr } = await run(file, args, call)
      return { ok: true, stdout, stderr }
    } catch (err) {
      const shaped = err as { stdout?: string; stderr?: string }
      return { ok: false, stdout: shaped.stdout ?? '', stderr: shaped.stderr ?? '', error: err }
    }
  }

  return {
    run(options) {
      return startRun(
        bin,
        spawnImpl,
        options,
        // The cancel call gets its own timeout, and SIGKILL when it elapses: a cancel that hangs
        // must neither hold the kill back nor stay behind as a process of its own.
        agentArgs =>
          execQuiet(bin, agentArgs, {
            cwd: options.cwd,
            timeoutSec: CANCEL_TIMEOUT_SEC,
            killSignal: 'SIGKILL',
          }),
        slackMs,
        cancelGraceMs
      )
    },

    async ensureSession(options) {
      await execQuiet(bin, buildEnsureArgs(options.agent, options.session, options.cwd, options.timeoutSec), {
        cwd: options.cwd,
        timeoutSec: options.timeoutSec + DEADLINE_SLACK_MS / 1000,
      })
    },

    async exec(options) {
      const result = await execQuiet(
        bin,
        buildExecArgs(options.agent, options.cwd, options.timeoutSec, options.prompt),
        {
          cwd: options.cwd,
          timeoutSec: options.timeoutSec + DEADLINE_SLACK_MS / 1000,
        }
      )
      const { text, error, ended } = readExecStream(result.stdout)
      if (error !== null) {
        return { ok: false, text: '', code: error.code, message: error.message }
      }
      if (!result.ok) {
        const code = exitCodeOf(result.error)
        return {
          ok: false,
          text: '',
          // A failed call never exits 0, so the table always names a code here.
          code: exitCodeToAgentCode(code) ?? 'AGENT_FAILED',
          message: missingBinary(result.error) ? `${bin} is not installed` : exitCodeMessage(code),
        }
      }
      if (!ended) {
        return {
          ok: false,
          text: '',
          code: 'AGENT_INCOMPLETE',
          message: 'the agent stopped before finishing',
        }
      }
      return text === ''
        ? { ok: false, text: '', code: 'AGENT_INCOMPLETE', message: 'the agent replied nothing' }
        : { ok: true, text }
    },

    async acpxVersion() {
      const result = await execQuiet(bin, ['--version'], { timeoutSec: 20 })
      return result.ok ? result.stdout.trim() : null
    },

    async availability(agent) {
      const check = AUTH_CHECKS[agent]
      if (check === undefined) {
        return { installed: false, authenticated: false, reason: `no auth check is known for ${agent}` }
      }
      const result = await execQuiet(check.bin, check.args, { timeoutSec: 30 })
      if (result.ok) {
        return { installed: true, authenticated: true }
      }
      if (missingBinary(result.error)) {
        return { installed: false, authenticated: false, reason: `${check.bin} is not on PATH` }
      }
      return {
        installed: true,
        authenticated: false,
        reason: `\`${check.bin} ${check.args.join(' ')}\` failed; log in and try again`,
      }
    },
  }
}

function exitCodeOf(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
    return error.code
  }
  return 1
}

function missingBinary(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * The agent's reply, the first error line, and whether the turn finished. acpx can exit 0 with no
 * terminal event, so a stream without one is an unfinished answer rather than a short one.
 */
export function readExecStream(stdout: string): {
  text: string
  error: { code: AgentErrorCode; message: string } | null
  ended: boolean
} {
  let text = ''
  let ended = false
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      return {
        text: '',
        ended: false,
        error: { code: 'AGENT_PROTOCOL_INVALID', message: 'the agent wrote a line that is not JSON' },
      }
    }
    const event = mapAcpxMessage(parsed)
    if (event === null) {
      continue
    }
    if (event.type === 'chunk') {
      text += event.text
    }
    if (event.type === 'done') {
      ended = event.stopReason === 'end_turn'
    }
    if (event.type === 'error') {
      return { text: '', ended: false, error: { code: event.code, message: event.message } }
    }
  }
  return { text: text.trim(), error: null, ended }
}

/** Spawns one prompt turn and turns its output into events. */
function startRun(
  bin: string,
  spawnImpl: SpawnImpl,
  options: AgentRunOptions,
  cancelCall: (args: string[]) => Promise<unknown>,
  deadlineSlackMs: number,
  cancelGraceMs: number
): AgentRun {
  const queue = createEventQueue()
  const splitter = createNdjsonSplitter()
  let finished = false
  let sawTerminal = false
  let cancelling = false
  /** True once the child process is gone, whatever ended it. */
  let closed = false
  /** @see AgentRun.cancel — set once so a second call does not spawn a second cancel. */
  let cancelPromise: Promise<void> | null = null

  let child: ChildProcess
  try {
    child = spawnImpl(bin, buildPromptArgs(options), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch {
    queue.push({ type: 'error', code: 'AGENT_MISSING', message: `${bin} could not be started` })
    queue.end()
    return { events: queue.iterate(), cancel: async () => undefined }
  }

  const finish = (event?: AgentEvent): void => {
    if (finished) {
      return
    }
    finished = true
    if (event !== undefined) {
      queue.push(event)
    }
    clearTimeout(deadline)
    queue.end()
  }

  const fail = (code: AgentErrorCode, message: string): void => {
    finish({ type: 'error', code, message })
    child.kill('SIGKILL')
  }

  const deadline = setTimeout(
    () => {
      void doCancel()
      fail('AGENT_TIMEOUT', `the agent did not answer within ${options.timeoutSec} seconds`)
    },
    options.timeoutSec * 1000 + deadlineSlackMs
  )
  // A pending deadline must not hold the process open on its own.
  deadline.unref?.()

  const doCancel = (): Promise<void> => {
    if (cancelPromise !== null) {
      return cancelPromise
    }
    cancelling = true
    cancelPromise = (async () => {
      // The cooperative cancel first: the agent then ends its turn with `cancelled`. A cancel
      // that does not come back in time is given up on, so the kill below always happens.
      await Promise.race([
        cancelCall(buildCancelArgs(options.agent, options.session, options.cwd)).catch(() => undefined),
        new Promise<void>(resolve => {
          const timer = setTimeout(resolve, cancelGraceMs)
          timer.unref?.()
        }),
      ])
      // The child is what has to go, not the stream: a turn that already reported `cancelled` can
      // still have a process behind it.
      if (closed) {
        return
      }
      child.kill('SIGTERM')
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, KILL_GRACE_MS)
        timer.unref?.()
        child.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    })()
    return cancelPromise
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    let messages: unknown[]
    try {
      messages = splitter.push(chunk)
    } catch (err) {
      fail('AGENT_PROTOCOL_INVALID', err instanceof NdjsonError ? err.message : String(err))
      return
    }
    for (const message of messages) {
      handleMessage(message)
    }
  })

  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(0, 4096)
  })

  const handleMessage = (message: unknown): void => {
    if (options.onRawLine !== undefined) {
      const loggable = scrubForLog(message)
      if (loggable !== null) {
        options.onRawLine(JSON.stringify(loggable))
      }
    }
    const event = mapAcpxMessage(message)
    if (event === null) {
      return
    }
    if (event.type === 'done' || event.type === 'error') {
      sawTerminal = true
    }
    queue.push(event)
    if (event.type === 'done') {
      finish()
    }
  }

  child.on('error', (err: NodeJS.ErrnoException) => {
    fail(err.code === 'ENOENT' ? 'AGENT_MISSING' : 'AGENT_FAILED', err.message)
  })

  child.on('close', (code: number | null) => {
    closed = true
    try {
      for (const message of splitter.flush()) {
        handleMessage(message)
      }
    } catch (err) {
      fail('AGENT_PROTOCOL_INVALID', err instanceof NdjsonError ? err.message : String(err))
      return
    }
    if (finished) {
      return
    }
    // A turn the reader stopped ends as cancelled, whatever the signal did to the exit code.
    if (cancelling) {
      finish({ type: 'done', stopReason: 'cancelled' })
      return
    }
    // The agent already said why it stopped, so the exit code adds nothing.
    if (sawTerminal) {
      finish()
      return
    }
    const exit = code ?? 1
    const mapped = exitCodeToAgentCode(exit)
    if (mapped !== null) {
      finish({
        type: 'error',
        code: mapped,
        message: stderr.trim() === '' ? exitCodeMessage(exit) : stderr.trim(),
      })
      return
    }
    // acpx 0.13.2 exits 0 when its own --timeout elapses, without a terminal event.
    finish({
      type: 'error',
      code: 'AGENT_INCOMPLETE',
      message: 'the agent stopped before finishing its answer',
    })
  })

  child.stdin?.on('error', () => undefined)
  child.stdin?.end(options.prompt)

  return { events: queue.iterate(), cancel: doCancel }
}
