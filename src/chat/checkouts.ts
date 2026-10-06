// Review checkouts: one detached git worktree per review, at the commit the chat talks about, so
// the agent reads the reviewed version of every file without touching the reader's checkout.
// See docs/adr/0004-chat-reads-a-review-checkout.md.
import { lstat, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execGit, GitError, type GitExec } from '../git/git.js'
import { parseReviewFolder, type ReviewKey, reviewFolder } from '../contract/review-key.js'
import type { CodeSource } from './seed.js'

/** A lock older than this is left over from a process that died without letting go. */
export const STALE_LOCK_MS = 2 * 60 * 60 * 1000

/** Who in this process reads code from a review checkout: a chat turn, or a canvas generation. */
export type CheckoutHolder = 'chat' | 'generation'

const HOLDER_WORDS: Record<CheckoutHolder, string> = {
  chat: 'a chat answer',
  generation: 'a canvas generation',
}

export class CheckoutBusyError extends Error {
  /** Who holds it in this process, or null when another pr-review process does. */
  readonly holder: CheckoutHolder | null

  /** `folder` is the checkout's name in the clone's checkouts, as `reviewFolder` gives it. */
  constructor(folder: string, holder: CheckoutHolder | null) {
    const who = holder === null ? 'another pr-review process' : HOLDER_WORDS[holder]
    super(`${who} is using the review checkout of ${folder}`)
    this.name = 'CheckoutBusyError'
    this.holder = holder
  }
}

/** A step on the way to the code: the checkout being made or moved, or the fallback taken. */
export type CodeSourceStep =
  | { status: 'preparing'; sha: string; creating: boolean }
  | { status: 'fallback'; message: string; branch: string | null }

/**
 * Where an agent reads the code of `key` at `headSha`, for the chat and for a generation alike.
 * The uncommitted review, and a reader who turned checkouts off, read the reader's own checkout.
 * Otherwise the review checkout is leased first, so a holder elsewhere is a refusal, and then put
 * at the commit; a checkout that fails falls back to the reader's checkout rather than failing.
 * It yields each step a reader may want to see, and returns the source.
 */
export async function* readCodeAt(input: {
  key: ReviewKey
  headSha: string
  checkoutEnabled: boolean
  holder: CheckoutHolder
  checkouts: ReviewCheckouts
  repoRoot: string
  currentBranch: () => Promise<string | null>
  /** Gets the lease the moment it is taken, so the caller releases it whatever happens next. */
  onLease: (lease: CheckoutLease) => void
}): AsyncGenerator<CodeSourceStep, CodeSource> {
  if (input.key === 'uncommitted') {
    return { kind: 'working-tree', cwd: input.repoRoot }
  }
  if (!input.checkoutEnabled) {
    return { kind: 'reader-checkout', cwd: input.repoRoot }
  }
  const lease = await input.checkouts.lease(input.key, input.holder)
  input.onLease(lease)
  if (lease.head !== input.headSha) {
    yield { status: 'preparing', sha: input.headSha, creating: lease.head === null }
  }
  try {
    await lease.moveTo(input.headSha)
    return { kind: 'checkout', cwd: lease.dir, sha: input.headSha }
  } catch (err) {
    const fallback = {
      message: err instanceof Error ? err.message : String(err),
      branch: await input.currentBranch().catch(() => null),
    }
    yield { status: 'fallback', ...fallback }
    return { kind: 'fallback', cwd: input.repoRoot, ...fallback }
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
  /** The linked worktree whose local review it is; null for a pull request's or the main checkout's. */
  worktree: string | null
  /** Its name among the clone's checkouts. */
  folder: string
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

/** What every view of a clone's checkouts shares. */
interface CheckoutsCommon {
  /** The folder all checkouts of this repository live in. */
  root: string
  list(): Promise<CheckoutInfo[]>
  /** Removes idle checkouts, or every one with `all`. A checkout in use is never removed. */
  sweep(options: SweepOptions): Promise<SweepResult>
  /** Bytes the checkout takes on disk, `.git` excluded; the settings dialog lists it. */
  size(dir: string): Promise<number>
}

/**
 * The checkouts of one clone, which every worktree of it shares, each named by its review folder.
 * One store per clone is what lets a holder in this process be named to every worktree.
 */
export interface CheckoutStore extends CheckoutsCommon {
  /**
   * Takes the checkout named `folder` for `holder`; throws CheckoutBusyError, naming who has it,
   * when a holder in this process or another process has it.
   */
  lease(folder: string, holder: CheckoutHolder): Promise<CheckoutLease>
}

/** The clone's checkouts as one checkout sees them: a local review's is that checkout's own. */
export interface ReviewCheckouts extends CheckoutsCommon {
  lease(key: ReviewKey, holder: CheckoutHolder): Promise<CheckoutLease>
}

/** `worktree` is the checkout's linked-worktree label; null for the clone's main checkout. */
export function checkoutsFor(store: CheckoutStore, worktree: string | null): ReviewCheckouts {
  return {
    root: store.root,
    list: () => store.list(),
    sweep: options => store.sweep(options),
    size: dir => store.size(dir),
    lease: (key, holder) => store.lease(reviewFolder(key, worktree), holder),
  }
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
}): CheckoutStore {
  const { root, git, now } = opts
  const dirOf = (folder: string): string => path.join(root, folder)
  /** Who holds each checkout leased in this process. */
  const holders = new Map<string, CheckoutHolder>()
  const metaOf = (folder: string): string => `${dirOf(folder)}.json`
  const lockOf = (folder: string): string => `${dirOf(folder)}.lock`

  /** The metadata this module wrote, or null when the checkout has none (or it was cut short). */
  const readMeta = async (folder: string): Promise<CheckoutMeta | null> => {
    try {
      return JSON.parse(await readFile(metaOf(folder), 'utf8')) as CheckoutMeta
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
  const tryLock = async (folder: string): Promise<boolean> => {
    await mkdir(root, { recursive: true })
    const file = lockOf(folder)
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

  const unlock = (folder: string): Promise<void> => rm(lockOf(folder), { force: true })

  const isLocked = async (folder: string): Promise<boolean> =>
    (await exists(lockOf(folder))) && !(await lockIsStale(lockOf(folder)))

  const removeCheckout = async (folder: string): Promise<void> => {
    const dir = dirOf(folder)
    await git.remove(dir)
    // git leaves the folder when the worktree was never registered or was half created.
    await rm(dir, { recursive: true, force: true })
    await rm(metaOf(folder), { force: true })
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
      const folder = name.slice(0, -'.json'.length)
      const review = parseReviewFolder(folder)
      const meta = review === null ? null : await readMeta(folder)
      if (review === null || meta === null) {
        continue
      }
      out.push({ ...review, folder, dir: dirOf(folder), ...meta, locked: await isLocked(folder) })
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
    async lease(folder, holder) {
      // A holder in this process is asked first: its lock file names this very pid, which the
      // stale check cannot tell from a lock this process forgot, so only its age would decide.
      const current = holders.get(folder)
      if (current !== undefined) {
        throw new CheckoutBusyError(folder, current)
      }
      holders.set(folder, holder)
      if (!(await tryLock(folder))) {
        holders.delete(folder)
        throw new CheckoutBusyError(folder, null)
      }
      const dir = dirOf(folder)
      const release = async (): Promise<void> => {
        holders.delete(folder)
        await unlock(folder)
      }
      let head: string | null
      try {
        head = await git.head(dir)
      } catch (err) {
        await release()
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
          await writeFile(metaOf(folder), JSON.stringify({ sha, lastUsedAt: now().toISOString() }))
        },
        release,
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
        if (holders.has(info.folder) || !(await tryLock(info.folder))) {
          skipped.push({ ...info, locked: true })
          continue
        }
        try {
          await removeCheckout(info.folder)
          removed.push(info)
        } finally {
          await unlock(info.folder)
        }
      }
      return { removed, skipped }
    },
  }
}
