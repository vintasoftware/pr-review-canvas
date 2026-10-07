// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../contract/settings.js'
import type { CheckoutStore, SweepOptions } from './checkouts.js'
import { startCheckoutSweep } from './checkout-sweep.js'

function fakeCheckouts(opts: { fail?: boolean } = {}): CheckoutStore & { sweeps: SweepOptions[] } {
  const sweeps: SweepOptions[] = []
  return {
    sweeps,
    root: '/data/checkouts',
    lease: () => Promise.reject(new Error('not used')),
    list: async () => [],
    size: async () => 0,
    sweep: async options => {
      sweeps.push(options)
      if (opts.fail === true) {
        throw new Error('disk gone')
      }
      return {
        removed: [
          {
            key: 'branch',
            worktree: 'fix',
            folder: 'branch~fix',
            dir: '/data/checkouts/branch~fix',
            sha: 'a',
            lastUsedAt: 'then',
            locked: false,
          },
        ],
        skipped: [],
      }
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startCheckoutSweep', () => {
  it('sweeps at startup with the idle limit, then again after the configured minutes', async () => {
    const checkouts = fakeCheckouts()
    let settings: Settings = { ...DEFAULT_SETTINGS, checkoutIdleDays: 3, checkoutSweepMinutes: 15 }
    const lines: string[] = []
    const sweeper = startCheckoutSweep({
      checkouts,
      readSettings: async () => settings,
      log: l => lines.push(l),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(checkouts.sweeps).toEqual([{ olderThanDays: 3 }])
    expect(lines).toEqual(['removed the idle review checkout of branch~fix (last used then)'])
    // A change in the settings applies from the next sweep.
    settings = { ...settings, checkoutIdleDays: 1 }
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1)
    expect(checkouts.sweeps).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(checkouts.sweeps).toEqual([{ olderThanDays: 3 }, { olderThanDays: 1 }])
    sweeper.stop()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(checkouts.sweeps).toHaveLength(2)
  })

  it('logs a failed sweep and keeps its schedule', async () => {
    const checkouts = fakeCheckouts({ fail: true })
    const lines: string[] = []
    const sweeper = startCheckoutSweep({
      checkouts,
      readSettings: async () => ({ ...DEFAULT_SETTINGS, checkoutSweepMinutes: 5 }),
      log: l => lines.push(l),
    })
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(lines).toEqual([
      'review checkout sweep failed: disk gone',
      'review checkout sweep failed: disk gone',
    ])
    sweeper.stop()
  })

  it('logs a settings file it cannot read and sweeps again on the default schedule', async () => {
    const checkouts = fakeCheckouts()
    const lines: string[] = []
    let readable = false
    const sweeper = startCheckoutSweep({
      checkouts,
      readSettings: async () => {
        if (!readable) {
          throw new Error('EISDIR: illegal operation on a directory, read')
        }
        return DEFAULT_SETTINGS
      },
      log: l => lines.push(l),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(lines).toEqual(['review checkout sweep failed: EISDIR: illegal operation on a directory, read'])
    expect(checkouts.sweeps).toEqual([])
    readable = true
    await vi.advanceTimersByTimeAsync(DEFAULT_SETTINGS.checkoutSweepMinutes * 60 * 1000)
    expect(checkouts.sweeps).toEqual([{ olderThanDays: DEFAULT_SETTINGS.checkoutIdleDays }])
    sweeper.stop()
  })

  it('removes nothing while idle cleanup is off, and does not reschedule once stopped', async () => {
    const checkouts = fakeCheckouts()
    const sweeper = startCheckoutSweep({
      checkouts,
      readSettings: async () => ({ ...DEFAULT_SETTINGS, checkoutIdleDays: -1 }),
      log: () => undefined,
    })
    sweeper.stop()
    expect(await sweeper.runOnce()).toBeNull()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(checkouts.sweeps).toEqual([])
  })
})
