import type { Capabilities } from '../contract/api.js'

/** What a page assumes before the probe answers: posting is tried and the host decides. */
export const UNKNOWN_CAPABILITIES: Capabilities = {
  canComment: 'unknown',
  tokenKind: 'unprobed',
  login: null,
}

/** How long a probe answer is reused. A new token needs `?refresh=1` or ten minutes. */
export const CAPABILITY_TTL_MS = 10 * 60 * 1000

export interface CapabilityProbe {
  get(opts?: { refresh?: boolean }): Promise<Capabilities>
}

/**
 * The probe with its cache. One per server process; `refresh` skips the cache after the user
 * changed their token.
 */
export function createCapabilityProbe(
  probe: () => Promise<Capabilities>,
  now: () => Date,
  ttlMs = CAPABILITY_TTL_MS
): CapabilityProbe {
  let cached: { at: number; value: Capabilities } | null = null
  return {
    get: async (opts = {}) => {
      const at = now().getTime()
      if (!opts.refresh && cached !== null && at - cached.at < ttlMs) {
        return cached.value
      }
      const value = await probe()
      cached = { at, value }
      return value
    },
  }
}
