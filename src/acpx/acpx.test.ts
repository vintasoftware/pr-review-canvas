// @vitest-environment node
// The spawn path against a real child process: src/testing/fake-acpx.mjs stands in for acpx and
// plays the scenarios the spike showed, the exit-0-without-an-answer one included.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_ROOT } from '../paths.js'
import {
  type AgentRunner,
  buildCancelArgs,
  buildEnsureArgs,
  buildExecArgs,
  buildPromptArgs,
  commonAcpxArgs,
  createAgentRunner as createProductionAgentRunner,
  readExecStream,
} from './acpx.js'
import type { AgentEvent } from './events.js'

// Process protocol tests inject unsandboxed transports; sandbox.test.ts exercises containment.
const createAgentRunner: typeof createProductionAgentRunner = options => createProductionAgentRunner({
  spawnImpl: spawn,
  execFileImpl: (file, args, opts) => promisify(execFile)(file, args, { ...opts, encoding: 'utf8' }),
  ...options,
})

const FAKE = path.join(PACKAGE_ROOT, 'src', 'testing', 'fake-acpx.mjs')

let tmp: string

/** The scenario the fake acpx plays, and where it writes what it was given. */
const env: {
  FAKE_ACPX_MODE?: string
  FAKE_ACPX_ARGV_FILE?: string
  FAKE_ACPX_PROMPT_FILE?: string
  FAKE_ACPX_CANCEL_FILE?: string
} = process.env

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'pr-review-acpx-'))
})

afterEach(async () => {
  for (const key of ['FAKE_ACPX_MODE', 'FAKE_ACPX_ARGV_FILE', 'FAKE_ACPX_PROMPT_FILE', 'FAKE_ACPX_CANCEL_FILE']) {
    delete process.env[key]
  }
  await rm(tmp, { recursive: true, force: true })
})

/** The fake is a node script, so the "binary" the runner spawns is the script itself. */
function runner(): AgentRunner {
  return createAgentRunner({ bin: FAKE })
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const event of events) {
    out.push(event)
  }
  return out
}

const RUN = {
  agent: 'claude',
  session: 'pr-review-acme-widgets-42-claude-t1',
  prompt: 'is this covered?',
  cwd: PACKAGE_ROOT,
  timeoutSec: 30,
}

describe('argument building', () => {
  it('always asks for JSON, read-only tools, no terminal, and no shell metacharacter survives', () => {
    expect(commonAcpxArgs('/repo', 600)).toEqual([
      '--cwd',
      '/repo',
      '--format',
      'json',
      '--json-strict',
      '--suppress-reads',
      '--approve-reads',
      '--non-interactive-permissions',
      'deny',
      '--no-terminal',
      '--timeout',
      '600',
    ])
  })

  it('puts the model, the turn cap, the agent, and the session on the prompt command line', () => {
    expect(buildPromptArgs({ ...RUN, cwd: '/repo', model: 'claude-opus-5', maxTurns: 4 }).slice(-10)).toEqual([
      '--model',
      'claude-opus-5',
      '--max-turns',
      '4',
      'claude',
      '-s',
      RUN.session,
      'prompt',
      '-f',
      '-',
    ])
    expect(buildPromptArgs({ ...RUN, cwd: '/repo', model: '' }).slice(-6)).toEqual([
      'claude',
      '-s',
      RUN.session,
      'prompt',
      '-f',
      '-',
    ])
  })

  it('cancels, ensures, and execs through the same flag set', () => {
    expect(buildCancelArgs('codex', 'sess', '/repo').slice(-4)).toEqual(['codex', 'cancel', '-s', 'sess'])
    expect(buildEnsureArgs('codex', 'sess', '/repo', 60).slice(-5)).toEqual([
      'codex',
      'sessions',
      'ensure',
      '-s',
      'sess',
    ])
    expect(buildExecArgs('codex', '/repo', 60, 'Reply OK').slice(-3)).toEqual(['codex', 'exec', 'Reply OK'])
  })
})

describe('createAgentRunner().run', () => {
  it('streams a finished turn and reports its stop reason', async () => {
    env.FAKE_ACPX_MODE = 'ok'
    const events = await collect(runner().run(RUN).events)
    expect(events).toEqual([
      { type: 'usage', used: 10, size: 100 },
      { type: 'chunk', text: 'Yes. ' },
      { type: 'chunk', text: 'Covered at `src/a.ts:10`.' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })

  it('sends the prompt on stdin and spawns the flags the chat needs', async () => {
    env.FAKE_ACPX_MODE = 'ok'
    env.FAKE_ACPX_PROMPT_FILE = path.join(tmp, 'prompt.txt')
    env.FAKE_ACPX_ARGV_FILE = path.join(tmp, 'argv.txt')
    await collect(runner().run(RUN).events)
    expect(await readFile(path.join(tmp, 'prompt.txt'), 'utf8')).toBe('is this covered?')
    const argv = JSON.parse((await readFile(path.join(tmp, 'argv.txt'), 'utf8')).trim()) as string[]
    expect(argv).toContain('--suppress-reads')
    expect(argv).toContain('--no-terminal')
    expect(argv.slice(-6)).toEqual(['claude', '-s', RUN.session, 'prompt', '-f', '-'])
  })

  it('keeps the file content out of the raw log even though acpx leaves it under _meta', async () => {
    env.FAKE_ACPX_MODE = 'suppressed-read'
    const lines: string[] = []
    await collect(runner().run({ ...RUN, onRawLine: line => lines.push(line) }).events)
    expect(lines.join('\n')).toContain('read output suppressed')
    expect(lines.join('\n')).not.toContain('SECRET FILE BODY')
  })

  it('reports AGENT_INCOMPLETE when acpx exits 0 without a terminal event', async () => {
    env.FAKE_ACPX_MODE = 'incomplete'
    const events = await collect(runner().run(RUN).events)
    expect(events).toEqual([
      { type: 'chunk', text: 'half an ans' },
      { type: 'error', code: 'AGENT_INCOMPLETE', message: 'the agent stopped before finishing its answer' },
    ])
  })

  it('reports the auth failure the agent writes and stops there', async () => {
    env.FAKE_ACPX_MODE = 'auth'
    const events = await collect(runner().run(RUN).events)
    expect(events).toEqual([
      {
        type: 'error',
        code: 'AGENT_AUTH_REQUIRED',
        message: 'agent advertised auth methods but no matching credentials found',
      },
    ])
  })

  it('reports a usage error with the exit code acpx used', async () => {
    env.FAKE_ACPX_MODE = 'usage'
    const events = await collect(runner().run(RUN).events)
    expect(events).toEqual([{ type: 'error', code: 'AGENT_USAGE', message: "error: unknown option '--nope'" }])
  })

  it('rejects a line that is not a message', async () => {
    env.FAKE_ACPX_MODE = 'protocol'
    const events = await collect(runner().run(RUN).events)
    expect(events).toEqual([
      { type: 'error', code: 'AGENT_PROTOCOL_INVALID', message: expect.stringContaining('not JSON') },
    ])
  })

  it('rejects a line too large to be a message', async () => {
    env.FAKE_ACPX_MODE = 'bigline'
    const events = await collect(runner().run(RUN).events)
    expect(events[0]?.type).toBe('error')
    expect(events[0]).toMatchObject({ code: 'AGENT_PROTOCOL_INVALID' })
  })

  it('cancels a running turn by asking acpx first and stopping the child after', async () => {
    env.FAKE_ACPX_MODE = 'hang'
    env.FAKE_ACPX_CANCEL_FILE = path.join(tmp, 'cancel.json')
    const run = runner().run(RUN)
    const iterator = run.events[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: 'chunk', text: 'thinking' })
    await run.cancel()
    const rest: AgentEvent[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) {
        break
      }
      rest.push(next.value)
    }
    expect(rest).toEqual([{ type: 'done', stopReason: 'cancelled' }])
    const cancelArgs = JSON.parse(await readFile(path.join(tmp, 'cancel.json'), 'utf8')) as string[]
    expect(cancelArgs.slice(-4)).toEqual(['claude', 'cancel', '-s', RUN.session])
  })

  it('cancelling twice asks acpx once', async () => {
    env.FAKE_ACPX_MODE = 'hang'
    const run = runner().run(RUN)
    const first = run.cancel()
    expect(run.cancel()).toBe(first)
    await first
    await collect(run.events)
  })

  it('kills a cancel command that outstays its own timeout, rather than leaving it behind', async () => {
    env.FAKE_ACPX_MODE = 'hang'
    const calls: Array<{ timeout?: number; killSignal?: NodeJS.Signals }> = []
    const run = createAgentRunner({
      bin: FAKE,
      cancelGraceMs: 20,
      execFileImpl: (_file, _args, options) => {
        calls.push(options)
        return new Promise(() => undefined)
      },
    }).run(RUN)
    await run.events[Symbol.asyncIterator]().next()
    await run.cancel()
    expect(calls[0]).toMatchObject({ timeout: 30_000, killSignal: 'SIGKILL' })
  })

  it('stops the child even when the cancel command never comes back', async () => {
    env.FAKE_ACPX_MODE = 'hang'
    const run = createAgentRunner({
      bin: FAKE,
      cancelGraceMs: 20,
      // A cancel command that hangs forever: the kill must not wait for it.
      execFileImpl: () => new Promise(() => undefined),
    }).run(RUN)
    const iterator = run.events[Symbol.asyncIterator]()
    await iterator.next()
    await run.cancel()
    const rest: AgentEvent[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) {
        break
      }
      rest.push(next.value)
    }
    expect(rest).toEqual([{ type: 'done', stopReason: 'cancelled' }])
  })

  it('stops a turn that outlives its own deadline', async () => {
    env.FAKE_ACPX_MODE = 'hang'
    // The runner's deadline is the acpx timeout plus its slack, so a zero timeout fires at once.
    const events = await collect(
      createAgentRunner({ bin: FAKE, deadlineSlackMs: 50 }).run({ ...RUN, timeoutSec: 0 }).events
    )
    expect(events.at(-1)).toEqual({
      type: 'error',
      code: 'AGENT_TIMEOUT',
      message: 'the agent did not answer within 0 seconds',
    })
  })

  it('reports a binary that is not there', async () => {
    const events = await collect(createAgentRunner({ bin: path.join(tmp, 'no-such-acpx') }).run(RUN).events)
    expect(events).toEqual([{ type: 'error', code: 'AGENT_MISSING', message: expect.stringContaining('ENOENT') }])
  })
})

describe('createAgentRunner().exec', () => {
  it('returns the agent reply of a one-shot run', async () => {
    env.FAKE_ACPX_MODE = 'ok'
    expect(await runner().exec({ agent: 'claude', prompt: 'Reply OK', cwd: PACKAGE_ROOT, timeoutSec: 30 })).toEqual({
      ok: true,
      text: 'Yes. Covered at `src/a.ts:10`.',
    })
  })

  it('returns the failure code when the agent is not logged in', async () => {
    env.FAKE_ACPX_MODE = 'auth'
    const result = await runner().exec({ agent: 'codex', prompt: 'Reply OK', cwd: PACKAGE_ROOT, timeoutSec: 30 })
    expect(result).toMatchObject({ ok: false, code: 'AGENT_AUTH_REQUIRED' })
  })

  it('maps the exit code and preserves stderr when acpx emits no JSON', async () => {
    env.FAKE_ACPX_MODE = 'usage'
    expect(await runner().exec({ agent: 'claude', prompt: 'x', cwd: PACKAGE_ROOT, timeoutSec: 30 })).toEqual({
      ok: false,
      text: '',
      code: 'AGENT_USAGE',
      message: "error: unknown option '--nope'",
    })
  })

  it('calls a finished turn with no words an incomplete answer', async () => {
    env.FAKE_ACPX_MODE = 'silent'
    expect(await runner().exec({ agent: 'claude', prompt: 'x', cwd: PACKAGE_ROOT, timeoutSec: 5 })).toEqual({
      ok: false,
      text: '',
      code: 'AGENT_INCOMPLETE',
      message: 'the agent replied nothing',
    })
  })

  it('reports a missing binary as such', async () => {
    const missing = createAgentRunner({ bin: path.join(tmp, 'no-such-acpx') })
    const result = await missing.exec({ agent: 'claude', prompt: 'x', cwd: PACKAGE_ROOT, timeoutSec: 5 })
    expect(result).toMatchObject({ ok: false, code: 'AGENT_FAILED', message: expect.stringContaining('not installed') })
  })

  it('calls a run that never finished incomplete, even when it wrote an answer', async () => {
    env.FAKE_ACPX_MODE = 'incomplete-exec'
    const result = await runner().exec({ agent: 'claude', prompt: 'x', cwd: PACKAGE_ROOT, timeoutSec: 5 })
    expect(result).toEqual({
      ok: false,
      text: '',
      code: 'AGENT_INCOMPLETE',
      message: 'the agent stopped before finishing',
    })
  })
})

describe('readExecStream', () => {
  it('joins the chunks of a finished stream', () => {
    const stream = [
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"O"}}}}',
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"K"}}}}',
      '{"id":2,"result":{"stopReason":"end_turn"}}',
      '',
    ].join('\n')
    expect(readExecStream(stream)).toEqual({ text: 'OK', error: null, ended: true })
  })

  it('calls a turn that stopped for another reason unfinished', () => {
    const stream = '{"id":2,"result":{"stopReason":"max_turn_requests"}}\n'
    expect(readExecStream(stream)).toEqual({ text: '', error: null, ended: false })
  })

  it('stops at the first error line', () => {
    const stream = '{"error":{"message":"nope","data":{"detailCode":"AUTH_REQUIRED"}}}\n'
    expect(readExecStream(stream)).toEqual({
      text: '',
      ended: false,
      error: { code: 'AGENT_AUTH_REQUIRED', message: 'nope' },
    })
  })

  it('reports a line that is not JSON', () => {
    expect(readExecStream('oops\n')).toEqual({
      text: '',
      ended: false,
      error: { code: 'AGENT_PROTOCOL_INVALID', message: 'the agent wrote a line that is not JSON' },
    })
  })
})

describe('createAgentRunner().acpxVersion and .availability', () => {
  it('reads the version acpx prints', async () => {
    expect(await runner().acpxVersion()).toBe('0.13.2-fake')
  })

  it('returns null when acpx is not installed', async () => {
    expect(await createAgentRunner({ bin: path.join(tmp, 'nope') }).acpxVersion()).toBeNull()
  })

  it('reports an agent whose CLI is not on PATH', async () => {
    const stub = createAgentRunner({
      bin: FAKE,
      execFileImpl: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
      },
    })
    expect(await stub.availability('claude')).toEqual({
      installed: false,
      authenticated: false,
      reason: 'claude is not on PATH',
    })
  })

  it('reports an agent that is installed but not logged in', async () => {
    const stub = createAgentRunner({
      bin: FAKE,
      execFileImpl: async () => {
        throw Object.assign(new Error('exit 1'), { code: 1 })
      },
    })
    expect(await stub.availability('codex')).toEqual({
      installed: true,
      authenticated: false,
      reason: '`codex login status` failed; log in and try again',
    })
  })

  it('reports an agent that answers its auth check', async () => {
    const stub = createAgentRunner({ bin: FAKE, execFileImpl: async () => ({ stdout: 'ok', stderr: '' }) })
    expect(await stub.availability('claude')).toEqual({ installed: true, authenticated: true })
  })

  it('has no auth check for an agent it does not know', async () => {
    expect(await runner().availability('gemini')).toEqual({
      installed: false,
      authenticated: false,
      reason: 'no auth check is known for gemini',
    })
  })
})

describe('the runner in the odd cases', () => {
  it('reports a spawn that throws instead of failing later', async () => {
    const runner = createAgentRunner({
      bin: 'acpx',
      spawnImpl: () => {
        throw new Error('no processes left')
      },
    })
    const run = runner.run(RUN)
    expect(await collect(run.events)).toEqual([
      { type: 'error', code: 'AGENT_MISSING', message: 'no processes left' },
    ])
    // There is nothing to cancel, and asking does not throw.
    await expect(run.cancel()).resolves.toBeUndefined()
  })

  it('reports a child that fails for a reason other than a missing binary', async () => {
    env.FAKE_ACPX_MODE = 'ok'
    const runner = createAgentRunner({
      bin: FAKE,
      spawnImpl: (file, args, options) => {
        const child = spawn(file, args, options)
        setTimeout(() => child.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' })), 0)
        return child
      },
    })
    const events = await collect(runner.run(RUN).events)
    expect(events.at(-1)).toEqual({ type: 'error', code: 'AGENT_FAILED', message: 'boom' })
  })

  it('reports the exit code when the child says nothing on stderr', async () => {
    const runner = createAgentRunner({
      bin: process.execPath,
      spawnImpl: (_file, _args, options) => spawn(process.execPath, ['-e', 'process.exit(5)'], options),
    })
    expect(await collect(runner.run(RUN).events)).toEqual([
      { type: 'error', code: 'AGENT_PERMISSION_DENIED', message: 'the agent was denied a permission it needed' },
    ])
  })

  it('rejects a partial line left behind when the child ends', async () => {
    const runner = createAgentRunner({
      bin: process.execPath,
      spawnImpl: (_file, _args, options) => spawn(process.execPath, ['-e', 'process.stdout.write("{oops")'], options),
    })
    expect(await collect(runner.run(RUN).events)).toEqual([
      { type: 'error', code: 'AGENT_PROTOCOL_INVALID', message: expect.stringContaining('not JSON') },
    ])
  })

  it('passes a timeout to the one-shot call and runs it in the repository', async () => {
    /** @type {Array<{ file: string; args: string[]; options: { cwd?: string; timeout?: number } }>} */
    const calls: Array<{ file: string; args: string[]; options: { cwd?: string; timeout?: number } }> = []
    const runner = createAgentRunner({
      bin: 'acpx',
      execFileImpl: async (file, args, options) => {
        calls.push({ file, args, options })
        return { stdout: '', stderr: '' }
      },
    })
    await runner.exec({ agent: 'claude', prompt: 'Reply OK', cwd: '/repo', timeoutSec: 30 })
    await runner.acpxVersion()
    expect(calls[0]?.options).toEqual({ cwd: '/repo', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
    expect(calls[1]?.options).toEqual({ timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
  })
})

describe('the runner after the turn has ended', () => {
  it('drops an event that arrives after the stream closed', async () => {
    env.FAKE_ACPX_MODE = 'ok'
    const run = runner().run(RUN)
    expect(await collect(run.events)).toHaveLength(4)
    // Cancelling a finished turn is a no-op rather than a second stream.
    await run.cancel()
    expect(await collect(run.events)).toEqual([])
  })

  it('keeps the stderr of a failed child as the message', async () => {
    const events = await collect(
      createAgentRunner({
        bin: process.execPath,
        spawnImpl: (_file, _args, options) =>
          spawn(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(1)'], options),
      }).run(RUN).events
    )
    expect(events).toEqual([{ type: 'error', code: 'AGENT_FAILED', message: 'boom' }])
  })
})

describe('createAgentRunner().ensureSession', () => {
  it('asks acpx to create the named session', async () => {
    /** The arguments the call was made with. */
    const calls: string[][] = []
    const runner = createAgentRunner({
      bin: 'acpx',
      execFileImpl: async (_file, args) => {
        calls.push(args)
        return { stdout: '', stderr: '' }
      },
    })
    await runner.ensureSession({ agent: 'codex', session: 'pr-review-a-b-42-codex-t1', cwd: '/repo', timeoutSec: 60 })
    expect(calls[0]?.slice(-5)).toEqual(['codex', 'sessions', 'ensure', '-s', 'pr-review-a-b-42-codex-t1'])
    expect(calls[0]).toContain('--no-terminal')
  })

  it('says nothing when acpx refuses, so the prompt can report the real failure', async () => {
    const runner = createAgentRunner({
      bin: 'acpx',
      execFileImpl: async () => {
        throw Object.assign(new Error('nope'), { code: 1 })
      },
    })
    await expect(
      runner.ensureSession({ agent: 'claude', session: 'pr-review-a-b-42-claude-t1', cwd: '/repo', timeoutSec: 60 })
    ).resolves.toBeUndefined()
  })
})
