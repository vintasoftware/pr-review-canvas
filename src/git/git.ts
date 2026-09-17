import { execFile } from 'node:child_process'
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
  /**
   * True when head reaches at least one commit beyond the bases and every such commit is a
   * two-parent merge whose tree is the one `git merge-tree` produces for its parents: no ordinary
   * commit, and no edit made while merging. Nothing beyond the bases means head lies inside them.
   * Judging a merge needs git 2.38 (`merge-tree --write-tree`); an older git throws a GitError
   * that says so, but only once a merge has to be judged.
   */
  onlyAutomaticMergesBeyond(head: string, bases: string[]): Promise<boolean>
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
}

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

/** Runs git with an argument array; never a shell. */
export function execGit(cwd: string, args: string[]): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(
      'git',
      args,
      { cwd, env: envWithoutRepo(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
        resolve({ stdout, stderr: stderr.toString('utf8'), code })
      }
    )
  })
}

export type GitExec = typeof execGit

/** The first git whose `merge-tree --write-tree` exists. */
export const MERGE_TREE_MIN_VERSION = '2.38'

/** True when `git version` output names a git at least as new as `min` (major.minor). */
export function versionAtLeast(versionOutput: string, min: string): boolean {
  const found = /(\d+)\.(\d+)/.exec(versionOutput)
  const [minMajor, minMinor] = min.split('.').map(Number)
  if (found === null || minMajor === undefined || minMinor === undefined) {
    return false
  }
  const major = Number(found[1])
  const minor = Number(found[2])
  return major > minMajor || (major === minMajor && minor >= minMinor)
}

export function createGit(cwd: string, exec: GitExec = execGit): Git {
  async function run(args: string[]): Promise<string> {
    const r = await exec(cwd, args)
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
    onlyAutomaticMergesBeyond: async (head, bases) => {
      const listed = await run(['rev-list', '--parents', head, ...bases.map(b => `^${b}`)])
      if (listed === '') {
        return false
      }
      const merges: Array<[sha: string, first: string, second: string]> = []
      for (const line of listed.split('\n')) {
        const [sha, first, second, ...rest] = line.split(' ')
        if (sha === undefined || first === undefined || second === undefined || rest.length > 0) {
          return false
        }
        merges.push([sha, first, second])
      }
      // One check at the boundary, and only now: an ordinary commit needs no merge-tree to be seen.
      const version = await run(['version'])
      if (!versionAtLeast(version, MERGE_TREE_MIN_VERSION)) {
        throw new GitError(
          ['merge-tree', '--write-tree'],
          `needs git ${MERGE_TREE_MIN_VERSION} or newer (this is ${version}); upgrade git or set canvas.ignoreMergeCommits: false`,
          128
        )
      }
      for (const [sha, first, second] of merges) {
        const args = ['merge-tree', '--write-tree', first, second]
        const r = await exec(cwd, args)
        // Exit 1 means conflicts: the tree written then holds conflict markers and cannot match.
        if (r.code > 1) {
          throw new GitError(args, r.stderr, r.code)
        }
        const automatic = r.stdout.toString('utf8').split('\n')[0]
        if (automatic !== (await run(['rev-parse', `${sha}^{tree}`]))) {
          return false
        }
      }
      return true
    },
    diff: (base, head) => run(['diff', '--no-color', '--no-ext-diff', '-M', '-U3', base, head]),
    fetch: async (remote, refspecs) => {
      await run(['fetch', '--no-tags', '--quiet', remote, ...refspecs])
    },
    show: async (ref, path) => {
      const r = await exec(cwd, ['show', `${ref}:${path}`])
      return r.code === 0 ? r.stdout : null
    },
    blobSize: async (ref, path) => {
      const r = await exec(cwd, ['cat-file', '-s', `${ref}:${path}`])
      return r.code === 0 ? Number(r.stdout.toString('utf8').trim()) : null
    },
    commitAuthor: ref => run(['log', '-1', '--format=%an', ref]),
    topLevel: () => run(['rev-parse', '--show-toplevel']),
    commonDir: () => run(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    remoteUrl: async name => {
      const r = await exec(cwd, ['remote', 'get-url', name])
      return r.code === 0 ? r.stdout.toString('utf8').trim() : null
    },
  }
}
