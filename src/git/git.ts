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
   * `git rev-list --count --no-merges a..b --not base`: the commits b gained since a that are
   * neither merges nor part of base. Zero means b only merged base onto a.
   */
  countOwnCommitsSince(a: string, b: string, base: string): Promise<number>
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
    countOwnCommitsSince: async (a, b, base) =>
      Number(await run(['rev-list', '--count', '--no-merges', `${a}..${b}`, '--not', base])),
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
