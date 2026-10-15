// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECKOUT_IDLE_NEVER, DEFAULT_SETTINGS, type Settings } from '../contract/settings.js'
import type { ReviewCheckouts, SweepOptions } from './checkouts.js'
import { startCheckoutSweep } from './checkout-sweep.js'

function fakeCheckouts(opts: { fail?: boolean } = {}): ReviewCheckouts & { sweeps: SweepOptions[] } {
  const sweeps: SweepOptions[] = []
  return {
    sweeps,
    root: '/data/checkouts',
    lease: () => Promise.reject(new Error('not used')),
    list: async () => [],
    size: async () => 0,
    remove: async () => false,
    sweep: async options => {
      sweeps.push(options)
      if (opts.fail === true) {
        throw new Error('disk gone')
      }
      return {
        removed: [{ key: 42, dir: '/data/checkouts/42', sha: 'a', lastUsedAt: 'then', locked: false }],
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
  it('removes the base checkouts of merged and closed pull requests, and keeps the rest', async () => {
    const info = (key: number | 'branch', locked = false) => ({
      key,
      dir: `/data/checkouts/base/${String(key)}`,
      sha: 'a',
      lastUsedAt: 'now',
      locked,
    })
    const removed: Array<number | 'branch'> = []
    const base = {
      ...fakeCheckouts(),
      list: async () => [info(1), info(2), info(3), info(4), info(5, true), info('branch')],
      remove: async (key: number | 'branch') => {
        if (key === 4) {
          throw new Error('busy')
        }
        removed.push(key)
        return true
      },
    }
    const states: Record<number, string> = { 1: 'merged', 2: 'closed', 3: 'open', 4: 'merged', 5: 'merged' }
    const asked: number[] = []
    const lines: string[] = []
    const settings = { ...DEFAULT_SETTINGS, checkoutSweepMinutes: 60 }
    const sweeper = startCheckoutSweep({
      checkouts: fakeCheckouts(),
      readSettings: async () => settings,
      log: l => lines.push(l),
      base: {
        checkouts: base,
        prState: async n => {
          asked.push(n)
          if (n === 3 && asked.filter(a => a === 3).length > 1) {
            throw new Error('offline')
          }
          return states[n] ?? 'open'
        },
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    // A branch review has no pull request, and a checkout in use is not asked about.
    expect(asked).toEqual([1, 2, 3, 4])
    expect(removed).toEqual([1, 2])
    expect(lines).toContain('removed the base checkout of #1: the pull request is merged')
    expect(lines).toContain('removed the base checkout of #2: the pull request is closed')
    // A state it cannot read leaves the checkout, and says why.
    const result = await sweeper.runOnce()
    expect(result?.skipped.map(c => c.key)).toEqual([4])
    expect(lines).toContain('could not read the state of #3, so its base checkout stays: offline')
    sweeper.stop()
  })

  it('leaves base checkouts alone when cleanup is off', async () => {
    const prState = vi.fn(async () => 'merged')
    const sweeper = startCheckoutSweep({
      checkouts: fakeCheckouts(),
      readSettings: async () => ({ ...DEFAULT_SETTINGS, checkoutIdleDays: CHECKOUT_IDLE_NEVER }),
      log: () => {},
      base: { checkouts: fakeCheckouts(), prState },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(prState).not.toHaveBeenCalled()
    sweeper.stop()
  })

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
    expect(lines).toEqual(['removed the idle review checkout of 42 (last used then)'])
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
