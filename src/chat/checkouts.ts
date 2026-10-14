// Review checkouts: one detached git worktree per review, at the commit the chat talks about, so
// the agent reads the reviewed version of every file without touching the reader's checkout.
// See docs/adr/0004-chat-reads-a-review-checkout.md.
import { lstat, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execGit, GitError, type GitExec } from '../git/git.js'
import { keyToString, parseReviewKey, type ReviewKey } from '../contract/review-key.js'

/** A lock older than this is left over from a process that died without letting go. */
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000

export class CheckoutBusyError extends Error {
  constructor(key: ReviewKey) {
    super(`another pr-review process is using the review checkout of ${keyToString(key)}`)
    this.name = 'CheckoutBusyError'
  }
}

/** The git commands a checkout needs. The real one runs git; tests pass a fake. */
export interface CheckoutGit {
  /** `git worktree add --detach --force <dir> <sha>`, run in the reader's repository. */
  add(dir: string, sha: string): Promise<void>
  /** `git checkout --detach --force <sha>`, run in the checkout. */
  move(dir: string, sha: string): Promise<void>
  /** The commit the checkout is on, or null when `dir` is not a working checkout. */
  head(dir: string): Promise<string | null>
  /**
   * `git worktree remove --force <dir>`, which also forgets a checkout whose folder is gone. No
   * `git worktree prune`: it would forget every missing worktree of the clone, the reader's too.
   */
  remove(dir: string): Promise<void>
}

export function createCheckoutGit(repoRoot: string, exec: GitExec = execGit): CheckoutGit {
  // A checkout is only read, so the repository's own hooks (post-checkout and the like) stay off.
  const must = async (cwd: string, args: string[]): Promise<void> => {
    const full = ['-c', 'core.hooksPath=/dev/null', ...args]
    const r = await exec(cwd, full)
    if (r.code !== 0) {
      throw new GitError(full, r.stderr, r.code)
    }
  }
  return {
    // `--force` also takes over a registration whose folder was removed by hand.
    add: (dir, sha) => must(repoRoot, ['worktree', 'add', '--detach', '--force', dir, sha]),
    move: (dir, sha) => must(dir, ['checkout', '--detach', '--force', '--quiet', sha]),
    head: async dir => {
      if (!(await exists(path.join(dir, '.git')))) {
        return null
      }
      const r = await exec(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null
    },
    remove: async dir => {
      await exec(repoRoot, ['worktree', 'remove', '--force', dir])
    },
  }
}

/** One checkout held by a chat turn. Nothing else moves or removes it until `release`. */
export interface CheckoutLease {
  dir: string
  /** The commit the checkout is on now, or null when it does not exist yet. */
  head: string | null
  /** Creates the checkout or moves it to `sha`, and records the turn as its last use. */
  moveTo(sha: string): Promise<void>
  release(): Promise<void>
}

export interface CheckoutInfo {
  key: ReviewKey
  dir: string
  /** The commit it was last moved to. */
  sha: string
  lastUsedAt: string
  /** True while a chat turn holds it. */
  locked: boolean
}

export interface SweepOptions {
  /** Remove checkouts unused for longer than this; ignored with `all`. */
  olderThanDays?: number | undefined
  all?: boolean | undefined
  dryRun?: boolean | undefined
}

export interface SweepResult {
  removed: CheckoutInfo[]
  /** Checkouts a chat turn was holding, left alone. */
  skipped: CheckoutInfo[]
}

export interface ReviewCheckouts {
  /** The folder all checkouts of this repository live in. */
  root: string
  /** Takes the checkout of `key` for one turn; throws CheckoutBusyError when another process has it. */
  lease(key: ReviewKey): Promise<CheckoutLease>
  list(): Promise<CheckoutInfo[]>
  /** Removes idle checkouts, or every one with `all`. A checkout in use is never removed. */
  sweep(options: SweepOptions): Promise<SweepResult>
  /** Bytes the checkout takes on disk, `.git` excluded; the settings dialog lists it. */
  size(dir: string): Promise<number>
}

interface CheckoutMeta {
  sha: string
  lastUsedAt: string
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createReviewCheckouts(opts: {
  root: string
  git: CheckoutGit
  now: () => Date
}): ReviewCheckouts {
  const { root, git, now } = opts
  const dirOf = (key: ReviewKey): string => path.join(root, keyToString(key))
  const metaOf = (key: ReviewKey): string => `${dirOf(key)}.json`
  const lockOf = (key: ReviewKey): string => `${dirOf(key)}.lock`

  /** The metadata this module wrote, or null when the checkout has none (or it was cut short). */
  const readMeta = async (key: ReviewKey): Promise<CheckoutMeta | null> => {
    try {
      return JSON.parse(await readFile(metaOf(key), 'utf8')) as CheckoutMeta
    } catch {
      return null
    }
  }

  /** A lock whose process is gone, or that is older than any turn could run, is taken over. */
  const lockIsStale = async (file: string): Promise<boolean> => {
    try {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
      const pid = Number(text.trim())
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid)) {
        return true
      }
      return now().getTime() - info.mtimeMs > STALE_LOCK_MS
    } catch {
      return true
    }
  }

  /** True when the lock was taken. */
  const tryLock = async (key: ReviewKey): Promise<boolean> => {
    await mkdir(root, { recursive: true })
    const file = lockOf(key)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(file, 'wx')
        await handle.writeFile(String(process.pid))
        await handle.close()
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || !(await lockIsStale(file))) {
          return false
        }
        await rm(file, { force: true })
      }
    }
    return false
  }

  const unlock = (key: ReviewKey): Promise<void> => rm(lockOf(key), { force: true })

  const isLocked = async (key: ReviewKey): Promise<boolean> =>
    (await exists(lockOf(key))) && !(await lockIsStale(lockOf(key)))

  const removeCheckout = async (key: ReviewKey): Promise<void> => {
    const dir = dirOf(key)
    await git.remove(dir)
    // git leaves the folder when the worktree was never registered or was half created.
    await rm(dir, { recursive: true, force: true })
    await rm(metaOf(key), { force: true })
  }

  const list = async (): Promise<CheckoutInfo[]> => {
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      return []
    }
    const out: CheckoutInfo[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue
      }
      const key = parseReviewKey(name.slice(0, -'.json'.length))
      const meta = key === null ? null : await readMeta(key)
      if (key === null || meta === null) {
        continue
      }
      out.push({ key, dir: dirOf(key), ...meta, locked: await isLocked(key) })
    }
    return out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
  }

  const size = async (dir: string): Promise<number> => {
    let total = 0
    const walk = async (current: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (current === dir && entry.name === '.git') {
          continue
        }
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          // A running turn's `git checkout`, or a sweep, can delete a file between readdir and here.
          total += (await lstat(full).catch(() => ({ size: 0 }))).size
        }
      }
    }
    await walk(dir)
    return total
  }

  return {
    root,
    async lease(key) {
      if (!(await tryLock(key))) {
        throw new CheckoutBusyError(key)
      }
      const dir = dirOf(key)
      let head: string | null
      try {
        head = await git.head(dir)
      } catch (err) {
        await unlock(key)
        throw err
      }
      return {
        dir,
        head,
        async moveTo(sha) {
          if (head === null) {
            // A folder that is not a checkout (a half-finished add) is cleared first.
            await rm(dir, { recursive: true, force: true })
            await git.add(dir, sha)
          } else if (head !== sha) {
            await git.move(dir, sha)
          }
          head = sha
          await writeFile(metaOf(key), JSON.stringify({ sha, lastUsedAt: now().toISOString() }))
        },
        release: () => unlock(key),
      }
    },
    list,
    size,
    async sweep(options) {
      const cutoff =
        options.olderThanDays === undefined
          ? null
          : now().getTime() - options.olderThanDays * 24 * 60 * 60 * 1000
      const removed: CheckoutInfo[] = []
      const skipped: CheckoutInfo[] = []
      for (const info of await list()) {
        const idle = options.all === true || (cutoff !== null && Date.parse(info.lastUsedAt) <= cutoff)
        if (!idle) {
          continue
        }
        if (options.dryRun === true) {
          ;(info.locked ? skipped : removed).push(info)
          continue
        }
        // Holding the lock while removing keeps a turn from starting in a folder that is going away.
        if (!(await tryLock(info.key))) {
          skipped.push({ ...info, locked: true })
          continue
        }
        try {
          await removeCheckout(info.key)
          removed.push(info)
        } finally {
          await unlock(info.key)
        }
      }
      return { removed, skipped }
    },
  }
}

/**
 * One view over several checkout folders: a lease goes to the first, while listing and sweeping
 * cover them all, so `clean`, the idle sweep, and the settings dialog see every checkout.
 */
export function combineCheckouts(primary: ReviewCheckouts, ...others: ReviewCheckouts[]): ReviewCheckouts {
  const all = [primary, ...others]
  return {
    root: primary.root,
    lease: key => primary.lease(key),
    async list() {
      const lists = await Promise.all(all.map(c => c.list()))
      return lists.flat().sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
    },
    async sweep(options) {
      const results = await Promise.all(all.map(c => c.sweep(options)))
      return { removed: results.flatMap(r => r.removed), skipped: results.flatMap(r => r.skipped) }
    },
    size: dir => primary.size(dir),
  }
}
