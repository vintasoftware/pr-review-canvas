import type { AgentAvailability, AgentProbeResult, AgentsResponse, ChatAgent } from '../contract/settings.js'
import { CHAT_AGENTS } from '../contract/settings.js'
import type { AgentRunner } from './acpx.js'
import type { PreflightProbe } from './preflight.js'

/** A probe is a real round trip to a model, so its answer is reused for ten minutes. */
export const PROBE_TTL_MS = 10 * 60 * 1000
export const PROBE_TIMEOUT_SEC = 120
export const PROBE_PROMPT = 'Reply OK'
/** Enough of the reply to see that the agent answered, and no more. */
export const PROBE_REPLY_MAX = 200

export interface AgentDirectory {
  list(opts?: { refresh?: boolean }): Promise<AgentsResponse>
  probe(id: ChatAgent, opts?: { refresh?: boolean }): Promise<AgentProbeResult>
}

export interface CreateAgentDirectoryOptions {
  runner: AgentRunner
  preflight: PreflightProbe
  cwd: string
  now: () => Date
  ttlMs?: number
}

export function createAgentDirectory(opts: CreateAgentDirectoryOptions): AgentDirectory {
  const ttlMs = opts.ttlMs ?? PROBE_TTL_MS
  const probes = new Map<ChatAgent, { at: number; value: AgentProbeResult }>()
  const availability = new Map<ChatAgent, { at: number; value: AgentAvailability }>()

  const availabilityOf = async (id: ChatAgent, refresh: boolean): Promise<AgentAvailability> => {
    const at = opts.now().getTime()
    const hit = availability.get(id)
    if (!refresh && hit !== undefined && at - hit.at < ttlMs) {
      return hit.value
    }
    const checked = await opts.runner.availability(id)
    const value: AgentAvailability = {
      id,
      available: checked.installed && checked.authenticated,
      installed: checked.installed,
      authenticated: checked.authenticated,
      ...(checked.reason === undefined ? {} : { reason: checked.reason }),
    }
    availability.set(id, { at: opts.now().getTime(), value })
    return value
  }

  return {
    async list(listOpts = {}) {
      const refresh = listOpts.refresh === true
      const acpx = await opts.preflight.get(refresh ? { refresh: true } : {})
      const agents = await Promise.all(CHAT_AGENTS.map(id => availabilityOf(id, refresh)))
      return { acpx: { installed: acpx.installed, version: acpx.version }, agents }
    },

    async probe(id, probeOpts = {}) {
      const at = opts.now().getTime()
      const hit = probes.get(id)
      if (probeOpts.refresh !== true && hit !== undefined && at - hit.at < ttlMs) {
        return { ...hit.value, cached: true }
      }
      const startedAt = opts.now().getTime()
      const result = await opts.runner.exec({
        agent: id,
        prompt: PROBE_PROMPT,
        cwd: opts.cwd,
        timeoutSec: PROBE_TIMEOUT_SEC,
      })
      const finishedAt = opts.now().getTime()
      const value: AgentProbeResult = {
        id,
        ok: result.ok,
        ms: finishedAt - startedAt,
        reply: result.text.slice(0, PROBE_REPLY_MAX),
        ...(result.code === undefined ? {} : { code: result.code }),
        ...(result.message === undefined ? {} : { message: result.message }),
        at: new Date(finishedAt).toISOString(),
        cached: false,
      }
      probes.set(id, { at: finishedAt, value })
      return value
    },
  }
}
