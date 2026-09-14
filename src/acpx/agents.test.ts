// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createFakeRunner } from '../testing/fake-runner.js'
import { createAgentDirectory } from './agents.js'
import { createPreflightProbe } from './preflight.js'

function clock(): { now: () => Date; advance: (ms: number) => void } {
  let at = Date.parse('2026-09-11T10:00:00.000Z')
  return {
    now: () => new Date(at),
    advance: ms => {
      at += ms
    },
  }
}

function directory(runner = createFakeRunner(), time = clock()) {
  const preflight = createPreflightProbe(runner, time.now)
  return { runner, time, dir: createAgentDirectory({ runner, preflight, cwd: '/repo', now: time.now }) }
}

describe('createPreflightProbe', () => {
  it('asks acpx once and reuses the answer', async () => {
    const runner = createFakeRunner()
    const time = clock()
    let calls = 0
    const counting = {
      ...runner,
      acpxVersion: async () => {
        calls += 1
        return runner.acpxVersion()
      },
    }
    const probe = createPreflightProbe(counting, time.now)
    expect(await probe.get()).toEqual({ installed: true, version: '0.13.2' })
    expect(await probe.get()).toEqual({ installed: true, version: '0.13.2' })
    expect(calls).toBe(1)
  })

  it('asks again after the answer goes stale, and when asked to refresh', async () => {
    const runner = createFakeRunner()
    const time = clock()
    let calls = 0
    const counting = {
      ...runner,
      acpxVersion: async () => {
        calls += 1
        return runner.acpxVersion()
      },
    }
    const probe = createPreflightProbe(counting, time.now, 1000)
    await probe.get()
    time.advance(1001)
    await probe.get()
    await probe.get({ refresh: true })
    expect(calls).toBe(3)
  })

  it('answers one call while another is still in flight', async () => {
    const runner = createFakeRunner()
    let calls = 0
    const counting = {
      ...runner,
      acpxVersion: async () => {
        calls += 1
        await new Promise(resolve => setTimeout(resolve, 5))
        return '0.13.2'
      },
    }
    const probe = createPreflightProbe(counting, clock().now)
    const [a, b] = await Promise.all([probe.get(), probe.get()])
    expect(a).toEqual(b)
    expect(calls).toBe(1)
  })

  it('reports acpx as missing when it is not on PATH', async () => {
    const probe = createPreflightProbe(createFakeRunner({ acpxVersion: null }), clock().now)
    expect(await probe.get()).toEqual({ installed: false, version: null })
  })
})

describe('createAgentDirectory().list', () => {
  it('reports every agent with the reason it cannot run', async () => {
    const runner = createFakeRunner({
      availability: {
        claude: { installed: true, authenticated: true },
        codex: { installed: true, authenticated: false, reason: 'log in first' },
      },
    })
    const { dir } = directory(runner)
    expect(await dir.list()).toEqual({
      acpx: { installed: true, version: '0.13.2' },
      agents: [
        { id: 'claude', available: true, installed: true, authenticated: true },
        { id: 'codex', available: false, installed: true, authenticated: false, reason: 'log in first' },
      ],
    })
  })

  it('reuses an availability answer until it goes stale', async () => {
    let calls = 0
    const base = createFakeRunner()
    const runner = {
      ...base,
      availability: async (a: string) => {
        calls += 1
        return base.availability(a)
      },
    }
    const time = clock()
    const preflight = createPreflightProbe(runner, time.now)
    const dir = createAgentDirectory({ runner, preflight, cwd: '/repo', now: time.now, ttlMs: 1000 })
    await dir.list()
    await dir.list()
    expect(calls).toBe(2)
    time.advance(1001)
    await dir.list()
    expect(calls).toBe(4)
  })
})

describe('createAgentDirectory().probe', () => {
  it('runs the agent once and reports how long it took', async () => {
    const runner = createFakeRunner({ exec: { ok: true, text: 'OK' } })
    const time = clock()
    let at = 0
    const stepping = () => {
      at += 1
      return new Date(Date.parse('2026-09-11T10:00:00.000Z') + at * 250)
    }
    const preflight = createPreflightProbe(runner, time.now)
    const dir = createAgentDirectory({ runner, preflight, cwd: '/repo', now: stepping })
    const result = await dir.probe('claude')
    expect(result).toMatchObject({ id: 'claude', ok: true, reply: 'OK', cached: false })
    expect(result.ms).toBe(250)
    expect(runner.execs).toEqual([{ agent: 'claude', prompt: 'Reply OK' }])
  })

  it('reuses the result for ten minutes and runs again on refresh', async () => {
    const runner = createFakeRunner()
    const { dir } = directory(runner)
    await dir.probe('claude')
    expect((await dir.probe('claude')).cached).toBe(true)
    expect(runner.execs).toHaveLength(1)
    await dir.probe('claude', { refresh: true })
    expect(runner.execs).toHaveLength(2)
  })

  it('reports the failure code and message of a probe that did not answer', async () => {
    const runner = createFakeRunner({
      exec: { ok: false, text: '', code: 'AGENT_AUTH_REQUIRED', message: 'not logged in' },
    })
    const { dir } = directory(runner)
    expect(await dir.probe('codex')).toMatchObject({
      ok: false,
      reply: '',
      code: 'AGENT_AUTH_REQUIRED',
      message: 'not logged in',
    })
  })

  it('cuts a long reply down to one line of evidence', async () => {
    const runner = createFakeRunner({ exec: { ok: true, text: 'x'.repeat(500) } })
    const { dir } = directory(runner)
    expect((await dir.probe('claude')).reply).toHaveLength(200)
  })
})
