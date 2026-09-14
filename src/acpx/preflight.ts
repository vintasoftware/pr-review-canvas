import type { AgentRunner } from './acpx.js'

/** How long the acpx presence check is reused. */
export const PREFLIGHT_TTL_MS = 10 * 60 * 1000

export interface AcpxPreflight {
  installed: boolean
  version: string | null
}

export interface PreflightProbe {
  get(opts?: { refresh?: boolean }): Promise<AcpxPreflight>
}

/**
 * Is acpx on PATH? The answer barely changes while the server runs, so it is asked once and
 * reused; the page shows a banner and hides the chat when it says no.
 */
export function createPreflightProbe(runner: AgentRunner, now: () => Date, ttlMs = PREFLIGHT_TTL_MS): PreflightProbe {
  let cached: { at: number; value: AcpxPreflight } | null = null
  let inFlight: Promise<AcpxPreflight> | null = null
  return {
    async get(opts = {}) {
      const at = now().getTime()
      if (opts.refresh !== true && cached !== null && at - cached.at < ttlMs) {
        return cached.value
      }
      if (inFlight !== null) {
        return inFlight
      }
      inFlight = runner
        .acpxVersion()
        .then(version => {
          const value: AcpxPreflight = { installed: version !== null, version }
          cached = { at: now().getTime(), value }
          return value
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}
