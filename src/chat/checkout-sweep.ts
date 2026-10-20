// The idle sweep `serve` runs: at startup, then every `checkoutSweepMinutes`. The settings are read
// again on each run, so a change in the dialog applies from the next one without a restart. Each run
// also removes the tour checkouts of pull requests merged or closed since: only a tour's generator
// used them, and that pull request will not be toured again. The chat's checkouts stay to the idle
// rule, since AI Chat still reads them after a merge.
import { CHECKOUT_IDLE_NEVER, DEFAULT_SETTINGS, type Settings } from '../contract/settings.js'
import type { CheckoutStore, SweepResult } from './checkouts.js'

export interface CheckoutSweeper {
  /** Runs one sweep now; resolves to null when idle cleanup is off. */
  runOnce(): Promise<SweepResult | null>
  stop(): void
}

/** The states a pull request's tour checkouts are removed in. */
const DONE_STATES = new Set(['merged', 'closed'])

export function startCheckoutSweep(opts: {
  checkouts: Pick<CheckoutStore, 'sweep'>
  readSettings: () => Promise<Settings>
  log: (line: string) => void
  /**
   * The clone's tour checkouts, swept with the rest, and how to read a pull request's state
   * (`open`, `merged`, `closed`).
   */
  tour?:
    | {
        checkouts: Array<Pick<CheckoutStore, 'sweep' | 'list' | 'remove'>>
        prState: (number: number) => Promise<string>
      }
    | undefined
}): CheckoutSweeper {
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const sweepWith = async (settings: Settings): Promise<SweepResult | null> => {
    if (settings.checkoutIdleDays === CHECKOUT_IDLE_NEVER) {
      return null
    }
    const idle = { olderThanDays: settings.checkoutIdleDays }
    const results = [await opts.checkouts.sweep(idle)]
    for (const store of opts.tour?.checkouts ?? []) results.push(await store.sweep(idle))
    for (const removed of results.flatMap(r => r.removed)) {
      opts.log(`removed the idle review checkout of ${removed.folder} (last used ${removed.lastUsedAt})`)
    }
    results.push(await sweepDoneTours())
    return { removed: results.flatMap(r => r.removed), skipped: results.flatMap(r => r.skipped) }
  }

  /**
   * Removes the tour checkouts of pull requests merged or closed. A state that cannot be read now
   * (offline, a rate limit) leaves the checkout for the next run; each pull request is asked once.
   */
  const sweepDoneTours = async (): Promise<SweepResult> => {
    const out: SweepResult = { removed: [], skipped: [] }
    const tour = opts.tour
    if (tour === undefined) {
      return out
    }
    const states = new Map<number, string | null>()
    for (const store of tour.checkouts) {
      for (const info of await store.list()) {
        if (typeof info.key !== 'number' || info.locked) {
          continue
        }
        let state = states.get(info.key)
        if (state === undefined) {
          try {
            state = await tour.prState(info.key)
          } catch (err) {
            state = null
            opts.log(
              `could not read the state of #${info.key}, so its tour checkout stays: ${err instanceof Error ? err.message : String(err)}`
            )
          }
          states.set(info.key, state)
        }
        if (state === null || !DONE_STATES.has(state)) {
          continue
        }
        try {
          if (await store.remove(info.folder)) {
            out.removed.push(info)
            opts.log(`removed the tour checkout of #${info.key}: the pull request is ${state}`)
          }
        } catch {
          // Taken by a run that started since the listing: the next sweep tries again.
          out.skipped.push({ ...info, locked: true })
        }
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
