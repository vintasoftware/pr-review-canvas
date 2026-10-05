// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { envWithoutRepo } from '../git/environment.mjs'
import { GitError } from '../git/git.js'
import { createFakeCheckoutGit, makeTempDir } from '../testing/fakes.js'
import {
  CheckoutBusyError,
  createCheckoutGit,
  createReviewCheckouts,
  type ReviewCheckouts,
  STALE_LOCK_MS,
} from './checkouts.js'

// `lstat` stays real; one test makes it fail the way a file deleted mid-walk does.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat) }
})

let tmp: string
let now: Date
let checkouts: ReviewCheckouts

const DAY = 24 * 60 * 60 * 1000

beforeEach(async () => {
  tmp = await makeTempDir('pr-review-checkouts-')
  now = new Date('2026-09-20T12:00:00.000Z')
  checkouts = createReviewCheckouts({
    root: path.join(tmp, 'checkouts'),
    git: createFakeCheckoutGit(),
    now: () => now,
  })
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function use(key: number | 'branch', sha: string): Promise<void> {
  const lease = await checkouts.lease(key, 'chat')
  try {
    await lease.moveTo(sha)
  } finally {
    await lease.release()
  }
}

describe('a lease', () => {
  it('names the holder in this process that refuses it, and another process otherwise', async () => {
    const held = await checkouts.lease(42, 'generation')
    const refused = await checkouts.lease(42, 'chat').catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(CheckoutBusyError)
    expect(refused).toMatchObject({
      holder: 'generation',
      message: 'a canvas generation is using the review checkout of 42',
    })
    // A second server over the same data dir sees only the lock file, so it names another process.
    const other = createReviewCheckouts({
      root: path.join(tmp, 'checkouts'),
      git: createFakeCheckoutGit(),
      now: () => now,
    })
    await expect(other.lease(42, 'chat')).rejects.toMatchObject({ holder: null })
    await held.release()
    const again = await checkouts.lease(42, 'chat')
    await again.release()
  })

  it('keeps a holder in this process however old its lock is, and the sweep leaves it', async () => {
    const held = await checkouts.lease(42, 'generation')
    await held.moveTo('a'.repeat(40))
    // Past the stale age, a lock of this very pid would be taken over by its age alone.
    now = new Date(now.getTime() + STALE_LOCK_MS + 60_000)
    const lock = path.join(tmp, 'checkouts', '42.lock')
    await utimes(
      lock,
      new Date(now.getTime() - STALE_LOCK_MS - 60_000),
      new Date(now.getTime() - STALE_LOCK_MS - 60_000)
    )
    await expect(checkouts.lease(42, 'chat')).rejects.toMatchObject({ holder: 'generation' })
    const swept = await checkouts.sweep({ all: true })
    expect(swept.removed).toEqual([])
    expect(swept.skipped.map(info => info.key)).toEqual([42])
    await held.release()
  })

  it('is refused while another holder has the checkout, and free again once released', async () => {
    const held = await checkouts.lease(42, 'chat')
    await expect(checkouts.lease(42, 'chat')).rejects.toThrow(CheckoutBusyError)
    await held.release()
    const again = await checkouts.lease(42, 'chat')
    await again.release()
  })

  it('takes over a lock whose process is gone', async () => {
    await use(42, 'a'.repeat(40))
    await writeFile(path.join(tmp, 'checkouts', '42.lock'), '999999999')
    const lease = await checkouts.lease(42, 'chat')
    await lease.release()
  })

  it('takes over a lock older than any turn could run', async () => {
    await use(42, 'a'.repeat(40))
    const lock = path.join(tmp, 'checkouts', '42.lock')
    await writeFile(lock, String(process.pid))
    const old = new Date(now.getTime() - STALE_LOCK_MS - 1000)
    await utimes(lock, old, old)
    const lease = await checkouts.lease(42, 'chat')
    await lease.release()
  })

  it('runs no git command when the checkout is already at the commit', async () => {
    const git = createFakeCheckoutGit()
    const own = createReviewCheckouts({ root: path.join(tmp, 'own'), git, now: () => now })
    const first = await own.lease(42, 'chat')
    await first.moveTo('a'.repeat(40))
    await first.release()
    const second = await own.lease(42, 'chat')
    await second.moveTo('a'.repeat(40))
    await second.release()
    expect(git.calls.map(c => c[0])).toEqual(['add'])
  })

  it('reports the commit the checkout is on, and none before it exists', async () => {
    const first = await checkouts.lease(42, 'chat')
    expect(first.head).toBeNull()
    await first.moveTo('a'.repeat(40))
    await first.release()
    const second = await checkouts.lease(42, 'chat')
    expect(second.head).toBe('a'.repeat(40))
    await second.release()
  })
})

describe('size', () => {
  it('counts a file deleted between listing the folder and reading its size as empty', async () => {
    const dir = path.join(tmp, 'walk')
    await mkdir(dir)
    await writeFile(path.join(dir, 'kept.txt'), '12345')
    await writeFile(path.join(dir, 'gone.txt'), 'abc')
    const real = vi.mocked(lstat).getMockImplementation()
    vi.mocked(lstat).mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('gone.txt')) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
      }
      return real!(file, ...rest)
    })
    try {
      expect(await checkouts.size(dir)).toBe(5)
    } finally {
      vi.mocked(lstat).mockImplementation(real!)
    }
  })
})

describe('the idle sweep', () => {
  it('removes checkouts unused for longer than the limit and keeps the rest', async () => {
    await use(42, 'a'.repeat(40))
    now = new Date(now.getTime() + 5 * DAY)
    await use('branch', 'b'.repeat(40))
    now = new Date(now.getTime() + 3 * DAY)
    const result = await checkouts.sweep({ olderThanDays: 7 })
    expect(result.removed.map(c => c.key)).toEqual([42])
    expect((await checkouts.list()).map(c => c.key)).toEqual(['branch'])
  })

  it('ignores files in the checkouts folder that name no review', async () => {
    await use(42, 'a'.repeat(40))
    await writeFile(path.join(tmp, 'checkouts', 'notes.json'), '{}')
    expect((await checkouts.list()).map(c => c.key)).toEqual([42])
  })

  it('lists what it would remove on a dry run, and removes nothing', async () => {
    await use(42, 'a'.repeat(40))
    const result = await checkouts.sweep({ all: true, dryRun: true })
    expect(result.removed.map(c => c.key)).toEqual([42])
    expect(await checkouts.list()).toHaveLength(1)
  })

  it('lists a checkout a turn is holding as skipped on a dry run', async () => {
    await use(42, 'a'.repeat(40))
    const held = await checkouts.lease(42, 'chat')
    const result = await checkouts.sweep({ all: true, dryRun: true })
    expect(result).toMatchObject({ removed: [], skipped: [{ key: 42, locked: true }] })
    await held.release()
  })

  it('leaves a checkout a turn is holding', async () => {
    await use(42, 'a'.repeat(40))
    const held = await checkouts.lease(42, 'chat')
    const result = await checkouts.sweep({ all: true })
    expect(result.removed).toEqual([])
    expect(result.skipped.map(c => c.key)).toEqual([42])
    await held.release()
  })
})

describe('createCheckoutGit', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: envWithoutRepo(), encoding: 'utf8' }).trim()

  it('creates a detached worktree, moves it, and removes it, leaving the reader checkout alone', async () => {
    const repo = path.join(tmp, 'repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: envWithoutRepo() })
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'user.name', 'T')
    await writeFile(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'one')
    const first = git(repo, 'rev-parse', 'HEAD')
    await writeFile(path.join(repo, 'a.txt'), 'two\n')
    git(repo, 'commit', '-q', '-am', 'two')
    const second = git(repo, 'rev-parse', 'HEAD')
    await writeFile(path.join(repo, 'a.txt'), 'uncommitted\n')
    // One of the reader's own worktrees, its folder moved away for now.
    const readerWorktree = path.join(tmp, 'reader-wt')
    git(repo, 'worktree', 'add', '-q', '--detach', readerWorktree)
    await rename(readerWorktree, `${readerWorktree}-moved`)

    const real = createReviewCheckouts({
      root: path.join(tmp, 'data', 'checkouts'),
      git: createCheckoutGit(repo),
      now: () => now,
    })
    const lease = await real.lease(7, 'chat')
    await expect(lease.moveTo('f'.repeat(40))).rejects.toThrow(GitError)
    await lease.moveTo(first)
    expect(await readFile(path.join(lease.dir, 'a.txt'), 'utf8')).toBe('one\n')
    await lease.moveTo(second)
    expect(await readFile(path.join(lease.dir, 'a.txt'), 'utf8')).toBe('two\n')
    await lease.release()
    expect(await readFile(path.join(repo, 'a.txt'), 'utf8')).toBe('uncommitted\n')
    expect(git(repo, 'branch', '--show-current')).toBe('main')

    const reopened = await real.lease(7, 'chat')
    expect(reopened.head).toBe(second)
    await reopened.release()
    // A symlink is not counted: it is not a file of its own.
    await symlink('a.txt', path.join(lease.dir, 'link.txt'))
    expect(await real.size(lease.dir)).toBe('two\n'.length)

    await real.sweep({ all: true })
    expect(git(repo, 'worktree', 'list')).not.toContain(lease.dir)
    expect(await real.list()).toEqual([])
    // Creating, moving, and removing the checkout never forgot the reader's worktree.
    expect(git(repo, 'worktree', 'list')).toContain(readerWorktree)

    // A checkout folder deleted by hand is taken over on the next turn.
    const again = await real.lease(7, 'chat')
    await again.moveTo(first)
    await again.release()
    await rm(again.dir, { recursive: true, force: true })
    const retaken = await real.lease(7, 'chat')
    expect(retaken.head).toBeNull()
    await retaken.moveTo(second)
    expect(await readFile(path.join(retaken.dir, 'a.txt'), 'utf8')).toBe('two\n')
    await retaken.release()
  })
})
