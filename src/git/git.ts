import { execFile } from 'node:child_process'
import path from 'node:path'
import { envWithoutRepo } from './environment.mjs'

/**
 * The git operations the tool needs. Routes, stores, and the CLI receive an implementation
 * through AppContext and never spawn git themselves. Tests use an in-memory fake.
 */
export interface Git {
  /** `git rev-parse <ref>`; throws GitError when the ref is unknown. */
  revParse(ref: string): Promise<string>
  mergeBase(a: string, b: string): Promise<string>
  /** True when the commit object exists locally. */
  commitExists(sha: string): Promise<boolean>
  /** `git merge-base --is-ancestor a b`: false when either commit is missing. */
  isAncestor(a: string, b: string): Promise<boolean>
  /** `git rev-list --count a..b`: how many commits b is ahead of a. */
  countCommitsBetween(a: string, b: string): Promise<number>
  /** Full unified diff between two commits, rename detection on, 3 lines of context. */
  diff(base: string, head: string): Promise<string>
  fetch(remote: string, refspecs: string[]): Promise<void>
  /** Content of `<ref>:<path>`; null when the path does not exist at that ref. */
  show(ref: string, path: string): Promise<Buffer | null>
  /** Byte size of `<ref>:<path>`; null when missing. */
  blobSize(ref: string, path: string): Promise<number | null>
  /** Author name of one commit (`git log -1 --format=%an`). */
  commitAuthor(ref: string): Promise<string>
  topLevel(): Promise<string>
  commonDir(): Promise<string>
  remoteUrl(name: string): Promise<string | null>
  /** The checked-out branch, or null on a detached HEAD. */
  currentBranch(): Promise<string | null>
  /** The first of `refs` that resolves, or null when none of them do. */
  firstExistingRef(refs: readonly string[]): Promise<string | null>
  /** What a symbolic ref points at, in its short form; null when it is not one. */
  symbolicRef(name: string): Promise<string | null>
  /** `git config user.name`, the person this clone commits as; null when it is unset. */
  configuredUser(): Promise<string | null>
  /**
   * A commit that holds the working tree as it is right now, or null when it matches HEAD.
   * Nothing the user staged is touched: the snapshot is built in an index of this tool's own.
   */
  snapshotWorktree(): Promise<string | null>
  /** Keeps `sha` reachable for good, whatever the working tree does next. */
  anchorCommit(sha: string): Promise<void>
}

/**
 * The index `snapshotWorktree` stages into, inside this worktree's own git directory rather than
 * the one every worktree shares. It is kept between runs so git's stat cache spares a rehash of
 * the whole tree, and `git worktree remove` takes it away with the worktree it belongs to.
 */
export const SNAPSHOT_INDEX = 'pr-review-canvas.index'

/**
 * Where the newest snapshot commit is anchored, so `git gc` cannot collect it between `prepare`
 * and `publish`. `refs/worktree/` is git's own per-worktree namespace: two worktrees of one clone
 * each keep their own snapshot instead of overwriting the single ref they would otherwise share.
 *
 * It moves with the working tree, so it protects one commit only. A canvas outlives the tree it
 * was drawn from, and `anchorCommit` gives each published one an anchor of its own.
 */
export const SNAPSHOT_REF = 'refs/worktree/pr-review-snapshot'

/** One ref per published snapshot canvas, under the same per-worktree namespace. */
export const CANVAS_ANCHOR_PREFIX = 'refs/worktree/pr-review-canvas'

/**
 * A fixed identity and time, so the same working tree always hashes to the same commit: preparing
 * twice without an edit lands on the canvas that already exists instead of making a second one.
 */
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: 'pr-review',
  GIT_AUTHOR_EMAIL: 'pr-review@localhost',
  GIT_AUTHOR_DATE: '1970-01-01T00:00:00+0000',
  GIT_COMMITTER_NAME: 'pr-review',
  GIT_COMMITTER_EMAIL: 'pr-review@localhost',
  GIT_COMMITTER_DATE: '1970-01-01T00:00:00+0000',
} as const

export const STDERR_MESSAGE_MAX = 300

/**
 * git stderr fit for an error message that reaches the JSON envelope or the CLI: credentials in
 * URLs (`https://user:token@host`) are replaced by `***`, and the text is cut at STDERR_MESSAGE_MAX.
 */
export function redactStderr(stderr: string): string {
  const redacted = stderr.trim().replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
  return redacted.length > STDERR_MESSAGE_MAX ? `${redacted.slice(0, STDERR_MESSAGE_MAX)}…` : redacted
}

export class GitError extends Error {
  readonly args: string[]
  readonly stderr: string
  readonly exitCode: number

  constructor(args: string[], stderr: string, exitCode: number) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${redactStderr(stderr)}`)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

interface ExecResult {
  stdout: Buffer
  stderr: string
  code: number
}

/** Runs git with an argument array; never a shell. `extra` puts back the few repo variables a
 * command needs, such as the snapshot index. */
export function execGit(
  cwd: string,
  args: string[],
  extra: Readonly<Record<string, string>> = {}
): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, env: { ...envWithoutRepo(), ...extra }, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr: stderr.toString('utf8'), code })
      }
    )
  })
}

export type GitExec = typeof execGit

export function createGit(cwd: string, exec: GitExec = execGit): Git {
  async function run(args: string[], env: Readonly<Record<string, string>> = {}): Promise<string> {
    const r = await exec(cwd, args, env)
    if (r.code !== 0) {
      throw new GitError(args, r.stderr, r.code)
    }
    return r.stdout.toString('utf8').replace(/\n$/, '')
  }

  return {
    revParse: ref => run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]),
    mergeBase: (a, b) => run(['merge-base', a, b]),
    commitExists: async sha => {
      const r = await exec(cwd, ['cat-file', '-e', `${sha}^{commit}`])
      return r.code === 0
    },
    isAncestor: async (a, b) => {
      const r = await exec(cwd, ['merge-base', '--is-ancestor', a, b])
      return r.code === 0
    },
    countCommitsBetween: async (a, b) => Number(await run(['rev-list', '--count', `${a}..${b}`])),
    diff: (base, head) => run(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base, head]),
    fetch: async (remote, refspecs) => {
      await run(['fetch', '--no-tags', '--quiet', remote, ...refspecs])
    },
    show: async (ref, file) => {
      const r = await exec(cwd, ['show', `${ref}:${file}`])
      return r.code === 0 ? r.stdout : null
    },
    blobSize: async (ref, file) => {
      const r = await exec(cwd, ['cat-file', '-s', `${ref}:${file}`])
      return r.code === 0 ? Number(r.stdout.toString('utf8').trim()) : null
    },
    commitAuthor: ref => run(['log', '-1', '--format=%an', ref]),
    topLevel: () => run(['rev-parse', '--show-toplevel']),
    commonDir: () => run(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    remoteUrl: async name => {
      const r = await exec(cwd, ['remote', 'get-url', name])
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null
    },
    currentBranch: async () => {
      const r = await exec(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null
    },
    symbolicRef: async name => {
      const r = await exec(cwd, ['symbolic-ref', '--quiet', '--short', name])
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null
    },
    configuredUser: async () => {
      const r = await exec(cwd, ['config', '--get', 'user.name'])
      const value = r.code === 0 ? r.stdout.toString('utf8').trim() : ''
      return value === '' ? null : value
    },
    firstExistingRef: async refs => {
      for (const ref of refs) {
        const r = await exec(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
        if (r.code === 0) {
          return ref
        }
      }
      return null
    },
    snapshotWorktree: async () => {
      const indexEnv = {
        GIT_INDEX_FILE: path.join(
          await run(['rev-parse', '--path-format=absolute', '--git-dir']),
          SNAPSHOT_INDEX
        ),
      }
      // `:/` stages the whole repository whatever the cwd is; ignored files stay out of it.
      await run(['add', '-A', '--', ':/'], indexEnv)
      const tree = await run(['write-tree'], indexEnv)
      if (tree === (await run(['rev-parse', 'HEAD^{tree}']))) {
        return null
      }
      const sha = await run(
        ['commit-tree', tree, '-p', 'HEAD', '-m', 'pr-review: working tree snapshot'],
        SNAPSHOT_ENV
      )
      await run(['update-ref', SNAPSHOT_REF, sha])
      return sha
    },
    anchorCommit: async sha => {
      await run(['update-ref', `${CANVAS_ANCHOR_PREFIX}/${sha}`, sha])
    },
  }
}
