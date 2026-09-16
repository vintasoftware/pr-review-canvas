import { execFile } from 'node:child_process'

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

/**
 * The repository state git hands to the processes a hook starts. Every one of them wins over the
 * working directory, so a tool run from a hook — or from a shell that exported GIT_DIR — would
 * otherwise read and write a repository nobody asked for. Dropping them is what lets the directory
 * the caller passes name the repository.
 *
 * Other variables can redirect git too, and are deliberately kept. GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_SYSTEM relocate the files config is read from; unsetting them does not strip the
 * credential helpers and proxies `fetch` needs, it sends git back to ~/.gitconfig and
 * /etc/gitconfig, which is what breaks anyone who moved them on purpose — a container with no
 * HOME, a CI image. GIT_CEILING_DIRECTORIES and GIT_DISCOVERY_ACROSS_FILESYSTEM are usually a
 * deliberate fence around slow mounts; obeying one costs a clear "not a git repository", while
 * overriding it sends git walking somewhere the user shut off. The inline config of
 * GIT_CONFIG_COUNT needs no exception: git never hands it to a hook, so the rule above leaves it.
 */
export const REPO_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const

/**
 * `env` without those variables. Everything else is kept, so ssh agents, credential helpers,
 * proxies, and PATH still reach `fetch`.
 */
export function envWithoutRepo(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env }
  for (const name of REPO_ENV_VARS) {
    delete clean[name]
  }
  return clean
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
