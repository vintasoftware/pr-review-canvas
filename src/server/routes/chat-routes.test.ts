// @vitest-environment node
// The chat and settings routes end to end through Hono, with an in-memory agent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatBusyError } from '../../chat/chat-manager.js'
import { ChatContextError } from '../../chat/context.js'
import type { ErrorEnvelope, HealthResponse } from '../../contract/api.js'
import type { ChatEvent, ChatHistoryResponse, ChatThreadsResponse } from '../../contract/chat.js'
import type { AgentProbeResult, AgentsResponse, SettingsResponse } from '../../contract/settings.js'
import { DEFAULT_PROJECT_CONFIG } from '../../project-config.js'
import { createFakeRunner, type FakeRunner } from '../../testing/fake-runner.js'
import { makeTestContext, type TestContext } from '../../testing/fakes.js'
import { ghFor42, gitFor42, syntheticArtifact } from '../../testing/synthetic.js'
import { createApp } from '../app.js'
import { AppError } from '../errors.js'
import { replayFrom, toChatError } from './chat-routes.js'

const LOCAL = { host: '127.0.0.1:3010' }
const POST = { ...LOCAL, origin: 'http://127.0.0.1:3010', 'content-type': 'application/json' }
const T1 = 'pr-review-acme-widgets-42-claude-t1'

let t: TestContext
let runner: FakeRunner

async function context(opts: { chat?: boolean; runner?: FakeRunner } = {}): Promise<TestContext> {
  runner = opts.runner ?? createFakeRunner()
  return makeTestContext({
    git: gitFor42(),
    gh: ghFor42(),
    runner,
    fixtureArtifact: syntheticArtifact(),
    projectConfig: {
      config: { ...DEFAULT_PROJECT_CONFIG, chat: { enabled: opts.chat ?? true } },
      warnings: [],
      source: '/repo/pr-review.config.yml',
    },
  })
}

/** The bundle route builds `derived/`, which the chat route then reads. */
async function warmDerived(): Promise<void> {
  await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function sendChat(body: unknown): Promise<Response> {
  return createApp(t.ctx).request('/api/prs/42/chat', {
    method: 'POST',
    headers: POST,
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  t = await context()
})

afterEach(async () => {
  await t.cleanup()
})

describe('POST /api/prs/:n/chat', () => {
  it.each([false, true])(
    'logs a chat failure with its original stack (stream started: %s)',
    async started => {
      await warmDerived()
      const logs: string[] = []
      t.ctx.log = line => logs.push(line)
      const failure = new Error('chat storage failed')
      t.ctx.chat.send = async function* () {
        if (started) yield { event: 'chunk', text: 'partial answer' }
        throw failure
      }
      const response = await sendChat({ message: 'private question', context: { kind: 'pr' } })
      expect(response.status).toBe(started ? 200 : 500)
      expect(await response.text()).toContain('chat storage failed')
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('[serve] POST /api/prs/42/chat 500 INTERNAL')
      expect(logs[0]).toContain(failure.stack?.split('\n')[1]?.trim())
      expect(logs[0]).not.toContain('private question')
    }
  )

  it('answers with an event stream of the turn', async () => {
    await warmDerived()
    const res = await sendChat({ message: 'is this covered?', context: { kind: 'pr' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(
      `event: turn\ndata: {"thread":"${T1}","agent":"claude","seeded":true}\n\n` +
        'event: chunk\ndata: {"text":"Yes. "}\n\n' +
        'event: chunk\ndata: {"text":"The behavior is covered at `src/a.ts:10`."}\n\n' +
        'event: done\ndata: {"stopReason":"end_turn"}\n\n'
    )
  })

  it('sends the line range the reader selected to the agent', async () => {
    await warmDerived()
    await (
      await sendChat({
        message: 'why?',
        context: { kind: 'lines', path: 'src/app.ts', side: 'new', start: 2, end: 3 },
      })
    ).text()
    expect(runner.runs[0]?.prompt).toContain('## Context: src/app.ts lines 2–3')
  })

  it('refuses a second turn with CHAT_BUSY while one is running', async () => {
    await t.cleanup()
    t = await context({ runner: createFakeRunner({ delayMs: 20 }) })
    await warmDerived()
    const first = sendChat({ message: 'one', context: { kind: 'pr' } })
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await sendChat({ message: 'two', context: { kind: 'pr' } })
    expect(second.status).toBe(409)
    const envelope = await json<ErrorEnvelope>(second)
    expect(envelope.error.code).toBe('CHAT_BUSY')
    expect(envelope.error.hint).toContain('stop the running answer')
    await (await first).text()
  })

  it('stops the agent when the browser goes away while the answer is still coming', async () => {
    await t.cleanup()
    t = await context({ runner: createFakeRunner({ delayMs: 20 }) })
    await warmDerived()
    const res = await sendChat({ message: 'one', context: { kind: 'pr' } })
    const body = res.body
    if (body === null) {
      throw new Error('the turn answered without a stream')
    }
    const reader = body.getReader()
    await reader.read()
    await reader.cancel()
    expect(runner.cancelled).toEqual([T1])
    await expect.poll(() => t.ctx.chat.busy(42)).toBe(false)
  })

  it('refuses a context the canvas does not have, with a status rather than a stream', async () => {
    await warmDerived()
    const res = await sendChat({ message: 'x', context: { kind: 'file', path: '../../etc/passwd' } })
    expect(res.status).toBe(400)
    expect((await json<ErrorEnvelope>(res)).error.message).toContain('not a file of this pull request')
  })

  it('rejects a body that is not a message with a context', async () => {
    const bad = await sendChat({ message: '' })
    expect(bad.status).toBe(400)
    const notJson = await createApp(t.ctx).request('/api/prs/42/chat', {
      method: 'POST',
      headers: POST,
      body: '{',
    })
    expect(notJson.status).toBe(400)
  })

  it('says so when the diff of this head is not on this machine', async () => {
    const res = await sendChat({ message: 'x', context: { kind: 'pr' } })
    expect(res.status).toBe(404)
    expect((await json<ErrorEnvelope>(res)).error.message).toContain('not available locally')
  })

  it('says so when there is no canvas to talk about', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42(), runner: createFakeRunner() })
    await warmDerived()
    const res = await sendChat({ message: 'x', context: { kind: 'pr' } })
    expect(res.status).toBe(404)
    expect((await json<ErrorEnvelope>(res)).error.code).toBe('CANVAS_NOT_FOUND')
  })
})

describe('the chat thread routes', () => {
  it('lists no threads before the first message', async () => {
    const res = await createApp(t.ctx).request('/api/prs/42/chat/threads', { headers: LOCAL })
    expect(await json<ChatThreadsResponse>(res)).toEqual({ threads: [], activeThread: null, agent: 'claude' })
  })

  it('starts a thread and returns the list it belongs to', async () => {
    const res = await createApp(t.ctx).request('/api/prs/42/chat/threads', { method: 'POST', headers: POST })
    expect(res.status).toBe(201)
    const body = await json<ChatThreadsResponse & { thread: { name: string } }>(res)
    expect(body.thread.name).toBe(T1)
    expect(body.activeThread).toBe(T1)
  })

  it('reads a thread transcript back', async () => {
    await warmDerived()
    await (await sendChat({ message: 'is this covered?', context: { kind: 'pr' } })).text()
    const res = await createApp(t.ctx).request(`/api/prs/42/chat/threads/${T1}/history`, { headers: LOCAL })
    const body = await json<ChatHistoryResponse>(res)
    expect(body.name).toBe(T1)
    expect(body.turns.map(turn => turn.role)).toEqual(['user', 'assistant'])
  })

  it('refuses a thread name that is not one of this pull request', async () => {
    const res = await createApp(t.ctx).request('/api/prs/42/chat/threads/..%2F..%2Fetc/history', {
      headers: LOCAL,
    })
    expect(res.status).toBe(404)
  })

  it('reports whether there was a turn to cancel', async () => {
    const res = await createApp(t.ctx).request('/api/prs/42/chat/cancel', { method: 'POST', headers: POST })
    expect(await json<{ cancelled: boolean }>(res)).toEqual({ cancelled: false })
  })
})

describe('the settings routes', () => {
  it('returns the personal settings, the flags that win over them, and the project config', async () => {
    t = await context()
    t.ctx.config.chatOverrides.agent = 'codex'
    const res = await createApp(t.ctx).request('/api/settings', { headers: LOCAL })
    const body = await json<SettingsResponse>(res)
    expect(body.settings).toEqual({
      version: 1,
      skin: 'github',
      theme: 'auto',
      foldLevel: 'light',
      layerView: 'all',
      agent: 'claude',
      model: null,
      chatTimeoutSec: 600,
      maxTurns: null,
    })
    expect(body.overrides).toEqual({ agent: 'codex' })
    expect(body.file).toContain('settings.yml')
    expect(body.project).toEqual({
      file: '/repo/pr-review.config.yml',
      chatEnabled: true,
      rulebook: null,
      maxRepairRounds: 3,
      inlineDiffMaxLines: 1500,
      smallPrHunks: 10,
      keepForIdenticalDiff: true,
      layers: 0,
      highRisk: 0,
    })
  })

  it('saves what the dialog sends and reads it back', async () => {
    const app = createApp(t.ctx)
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({
        foldLevel: 'aggressive',
        agent: 'codex',
        model: 'gpt-5.2',
        chatTimeoutSec: 300,
        maxTurns: 4,
      }),
    })
    expect((await json<SettingsResponse>(res)).settings).toEqual({
      version: 1,
      skin: 'github',
      theme: 'auto',
      foldLevel: 'aggressive',
      layerView: 'all',
      agent: 'codex',
      model: 'gpt-5.2',
      chatTimeoutSec: 300,
      maxTurns: 4,
    })
    const again = await app.request('/api/settings', { headers: LOCAL })
    expect((await json<SettingsResponse>(again)).settings.agent).toBe('codex')
  })

  it('rejects a setting outside its range', async () => {
    const res = await createApp(t.ctx).request('/api/settings', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ chatTimeoutSec: 1 }),
    })
    expect(res.status).toBe(400)
  })

  it('lists the agents with whether each can run', async () => {
    const res = await createApp(t.ctx).request('/api/settings/agents', { headers: LOCAL })
    expect(await json<AgentsResponse>(res)).toEqual({
      acpx: { installed: true, version: '0.13.2' },
      agents: [
        { id: 'claude', available: true, installed: true, authenticated: true },
        { id: 'codex', available: true, installed: true, authenticated: true },
      ],
    })
  })

  it('probes one agent with a real round trip, and reuses the result', async () => {
    const app = createApp(t.ctx)
    const first = await json<AgentProbeResult>(
      await app.request('/api/settings/agents/claude/probe', { method: 'POST', headers: POST })
    )
    expect(first).toMatchObject({ id: 'claude', ok: true, reply: 'OK', cached: false })
    const second = await json<AgentProbeResult>(
      await app.request('/api/settings/agents/claude/probe', { method: 'POST', headers: POST })
    )
    expect(second.cached).toBe(true)
    expect(runner.execs).toHaveLength(1)
  })

  it('refuses to probe an agent it does not know', async () => {
    const res = await createApp(t.ctx).request('/api/settings/agents/gemini/probe', {
      method: 'POST',
      headers: POST,
    })
    expect(res.status).toBe(400)
  })
})

describe('with chat turned off in the project config', () => {
  beforeEach(async () => {
    await t.cleanup()
    t = await context({ chat: false })
  })

  it('answers 404 on every chat and agent route', async () => {
    const app = createApp(t.ctx)
    const routes: Array<[string, RequestInit]> = [
      ['/api/settings/agents', { headers: LOCAL }],
      ['/api/settings/agents/claude/probe', { method: 'POST', headers: POST }],
      ['/api/prs/42/chat/threads', { headers: LOCAL }],
      ['/api/prs/42/chat/threads', { method: 'POST', headers: POST }],
      [`/api/prs/42/chat/threads/${T1}/history`, { headers: LOCAL }],
      ['/api/prs/42/chat/cancel', { method: 'POST', headers: POST }],
      ['/api/prs/42/chat', { method: 'POST', headers: POST, body: '{}' }],
    ]
    for (const [url, init] of routes) {
      const res = await app.request(url, init)
      expect([url, res.status]).toEqual([url, 404])
      expect((await json<ErrorEnvelope>(res)).error.message).toContain('chat is turned off')
    }
  })

  it('still reads and writes the settings file, which holds the reading level', async () => {
    const app = createApp(t.ctx)
    const read = await json<SettingsResponse>(await app.request('/api/settings', { headers: LOCAL }))
    expect([read.settings.foldLevel, read.project.chatEnabled]).toEqual(['light', false])
    const saved = await app.request('/api/settings', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ foldLevel: 'moderate' }),
    })
    expect(saved.status).toBe(200)
    const again = await json<SettingsResponse>(await app.request('/api/settings', { headers: LOCAL }))
    expect(again.settings.foldLevel).toBe('moderate')
  })

  it('still serves the look of the page, which is not an agent surface', async () => {
    const app = createApp(t.ctx)
    expect(await json(await app.request('/api/appearance', { headers: LOCAL }))).toEqual({
      skin: 'github',
      theme: 'auto',
    })
    const saved = await app.request('/api/appearance', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ skin: 'github', theme: 'dark' }),
    })
    expect(saved.status).toBe(200)
    expect(await json(saved)).toEqual({ skin: 'github', theme: 'dark' })
  })

  it('leaves the rest of the API alone', async () => {
    const res = await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
    expect(res.status).toBe(200)
  })
})

describe('the health check', () => {
  it('reports acpx and the active agent while chat is on', async () => {
    const res = await createApp(t.ctx).request('/api/health', { headers: LOCAL })
    const body = await json<HealthResponse>(res)
    expect(body.checks.acpx).toEqual({ ok: true, detail: '0.13.2' })
    expect(body.chat).toEqual({ enabled: true, acpx: true, agent: 'claude', model: null })
  })

  it('reports a missing acpx and hides the pane', async () => {
    await t.cleanup()
    t = await context({ runner: createFakeRunner({ acpxVersion: null }) })
    const bundle = await json<{ chat: unknown; warnings: string[] }>(
      await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
    )
    expect(bundle.chat).toEqual({ enabled: false, acpx: false, agent: 'claude', model: null })
    expect(bundle.warnings).toContain(
      'acpx is not on PATH, so the AI Chat pane is off; install acpx to turn it on'
    )
  })
})

describe('replayFrom', () => {
  it('puts the already-read event back in front of the rest', async () => {
    const rest: ChatEvent[] = [{ event: 'done', stopReason: 'end_turn' }]
    let at = 0
    const iterator: AsyncIterator<ChatEvent> = {
      next: async () => {
        const value = rest[at]
        at += 1
        return value === undefined ? { done: true, value: undefined } : { done: false, value }
      },
    }
    const out: ChatEvent[] = []
    for await (const event of replayFrom({ done: false, value: { event: 'cancelled' } }, iterator)) {
      out.push(event)
    }
    expect(out).toEqual([{ event: 'cancelled' }, { event: 'done', stopReason: 'end_turn' }])
  })

  it('is an empty stream for a turn that had already ended', async () => {
    const out: ChatEvent[] = []
    for await (const event of replayFrom(
      { done: true, value: undefined },
      {
        next: async () => ({ done: true, value: undefined }),
      }
    )) {
      out.push(event)
    }
    expect(out).toEqual([])
  })

  it('stops the turn when the reader gives up', async () => {
    let returned = false
    const stream = replayFrom(
      { done: false, value: { event: 'cancelled' } },
      {
        next: async () => ({ done: false, value: { event: 'chunk', text: 'a' } }),
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        },
      }
    )
    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.return?.(undefined)
    expect(returned).toBe(true)
  })
})

describe('the health check with chat off', () => {
  it('leaves out the agent checks entirely', async () => {
    await t.cleanup()
    t = await context({ chat: false })
    const body = await json<{ checks: Record<string, unknown>; chat: unknown }>(
      await createApp(t.ctx).request('/api/health', { headers: LOCAL })
    )
    expect(Object.keys(body.checks)).toEqual(['git', 'origin', 'gh', 'ghAuth'])
    expect(body.chat).toEqual({ enabled: false, acpx: false })
  })

  it('reports the active agent as not installed when its CLI is missing', async () => {
    await t.cleanup()
    t = await context({
      runner: createFakeRunner({
        availability: { claude: { installed: false, authenticated: false, reason: 'claude is not on PATH' } },
      }),
    })
    const body = await json<HealthResponse>(await createApp(t.ctx).request('/api/health', { headers: LOCAL }))
    expect(body.checks.agentInstalled).toEqual({ ok: false, detail: 'claude is not on PATH' })
    expect(body.checks.agentAuth).toEqual({ ok: false })
  })

  it('reports acpx as missing in the health check too', async () => {
    await t.cleanup()
    t = await context({ runner: createFakeRunner({ acpxVersion: null }) })
    const body = await json<HealthResponse>(await createApp(t.ctx).request('/api/health', { headers: LOCAL }))
    expect(body.checks.acpx).toEqual({ ok: false, detail: 'acpx is not on PATH' })
  })
})

describe('toChatError', () => {
  it('maps every way a turn can be refused', () => {
    expect(toChatError(new ChatBusyError()).code).toBe('CHAT_BUSY')
    expect(toChatError(new ChatContextError('no such file')).status).toBe(400)
    const app = new AppError('CANVAS_NOT_FOUND', 'gone', 404)
    expect(toChatError(app)).toBe(app)
    expect(toChatError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' })
    expect(toChatError('a string')).toMatchObject({ code: 'INTERNAL', message: 'a string' })
  })
})
