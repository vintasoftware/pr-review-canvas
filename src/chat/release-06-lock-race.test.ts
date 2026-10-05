import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createFakeCheckoutGit, makeTempDir } from '../testing/fakes.js'
import { createReviewCheckouts } from './checkouts.js'

// Make a real filesystem race repeatable: both callers see the abandoned lock, then the second
// caller deletes it only after the first has acquired its replacement. Production code is unchanged.
const timing = vi.hoisted(() => ({
  active: false,
  deletes: 0,
  secondArrived: () => {},
  bothSawStale: Promise.resolve(),
  allowSecondDelete: Promise.resolve(),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (timing.active && String(args[0]).endsWith('/42.lock')) {
        timing.deletes += 1
        if (timing.deletes === 1) {
          await timing.bothSawStale
        } else if (timing.deletes === 2) {
          timing.secondArrived()
          await timing.allowSecondDelete
        }
      }
      return actual.rm(...args)
    },
  }
})

// Deferred by the user: keep the reproduction as an expected failure.
it.fails('stale-lock recovery cannot delete a lock another caller just acquired', async () => {
  const root = await makeTempDir('release06-lock-race-')
  let continueSecond = () => {}
  timing.bothSawStale = new Promise<void>(resolve => {
    timing.secondArrived = resolve
  })
  timing.allowSecondDelete = new Promise<void>(resolve => {
    continueSecond = resolve
  })
  timing.active = true
  timing.deletes = 0
  try {
    await writeFile(path.join(root, '42.lock'), '999999999')
    const options = { root, git: createFakeCheckoutGit(), now: () => new Date() }
    const first = createReviewCheckouts(options).lease(42, 'chat')
    const second = createReviewCheckouts(options).lease(42, 'chat')
    await Promise.any([first, second])
    continueSecond()
    const results = await Promise.allSettled([first, second])
    timing.active = false
    const granted = results.filter(result => result.status === 'fulfilled')
    for (const result of granted) if (result.status === 'fulfilled') await result.value.release()
    expect(granted).toHaveLength(1)
  } finally {
    timing.active = false
    continueSecond()
    await rm(root, { recursive: true, force: true })
  }
})
