// The idle sweep `serve` runs: at startup, then every `checkoutSweepMinutes`. The settings are read
// again on each run, so a change in the dialog applies from the next one without a restart. Each run
// also removes the base checkouts of pull requests merged or closed since: only a tour's generator
// used them, and that pull request will not be toured again. The head checkouts stay to the idle
// rule, since AI Chat still reads them after a merge.
import { CHECKOUT_IDLE_NEVER, DEFAULT_SETTINGS, type Settings } from '../contract/settings.js'
import type { ReviewCheckouts, SweepResult } from './checkouts.js'

export interface CheckoutSweeper {
  /** Runs one sweep now; resolves to null when idle cleanup is off. */
  runOnce(): Promise<SweepResult | null>
  stop(): void
}

/** The states a pull request's base checkout is removed in. */
const DONE_STATES = new Set(['merged', 'closed'])

export function startCheckoutSweep(opts: {
  checkouts: ReviewCheckouts
  readSettings: () => Promise<Settings>
  log: (line: string) => void
  /** The base checkouts, and how to read a pull request's state (`open`, `merged`, `closed`). */
  base?: { checkouts: ReviewCheckouts; prState: (number: number) => Promise<string> } | undefined
}): CheckoutSweeper {
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const sweepWith = async (settings: Settings): Promise<SweepResult | null> => {
    if (settings.checkoutIdleDays === CHECKOUT_IDLE_NEVER) {
      return null
    }
    const result = await opts.checkouts.sweep({ olderThanDays: settings.checkoutIdleDays })
    for (const removed of result.removed) {
      opts.log(`removed the idle review checkout of ${String(removed.key)} (last used ${removed.lastUsedAt})`)
    }
    const done = await sweepDoneBases()
    return { removed: [...result.removed, ...done.removed], skipped: [...result.skipped, ...done.skipped] }
  }

  /**
   * Removes the base checkouts of pull requests merged or closed. A state that cannot be read now
   * (offline, a rate limit) leaves the checkout for the next run.
   */
  const sweepDoneBases = async (): Promise<SweepResult> => {
    const out: SweepResult = { removed: [], skipped: [] }
    const base = opts.base
    if (base === undefined) {
      return out
    }
    for (const info of await base.checkouts.list()) {
      if (typeof info.key !== 'number' || info.locked) {
        continue
      }
      let state: string
      try {
        state = await base.prState(info.key)
      } catch (err) {
        opts.log(
          `could not read the state of #${info.key}, so its base checkout stays: ${err instanceof Error ? err.message : String(err)}`
        )
        continue
      }
      if (!DONE_STATES.has(state)) {
        continue
      }
      try {
        if (await base.checkouts.remove(info.key)) {
          out.removed.push(info)
          opts.log(`removed the base checkout of #${info.key}: the pull request is ${state}`)
        }
      } catch {
        // Taken by a run that started since the listing: the next sweep tries again.
        out.skipped.push({ ...info, locked: true })
      }
    }
    return out
  }

  const logFailure = (err: unknown): void => {
    opts.log(`review checkout sweep failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const schedule = async (): Promise<void> => {
    // An unreadable settings file (a folder, no permission) skips this sweep, not the server.
    const settings = await opts.readSettings().catch((err: unknown) => {
      logFailure(err)
      return null
    })
    if (settings !== null) {
      await sweepWith(settings).catch(logFailure)
    }
    if (stopped) {
      return
    }
    const minutes = (settings ?? DEFAULT_SETTINGS).checkoutSweepMinutes
    timer = setTimeout(() => void schedule(), minutes * 60 * 1000)
    // A pending sweep never keeps the process alive on its own.
    timer.unref()
  }

  void schedule()
  return {
    runOnce: async () => sweepWith(await opts.readSettings()),
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  }
}
