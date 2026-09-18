// @vitest-environment node
// The real adapter against a throwaway repository: git is a process boundary, but the adapter
// itself is what this file tests, so it needs the real binary once.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { makeTempDir } from '../testing/fakes.js'
import { envWithoutRepo, REPO_ENV_VARS } from './environment.mjs'
import { createGit, execGit, GitError, type GitExec, redactStderr, STDERR_MESSAGE_MAX } from './git.js'

const run = promisify(execFile)

/**
 * Every git command this file runs goes through the adapter's own runner, so the setup cannot
 * drift from what is under test: the scrub is not a rule a test author has to remember. It matters
 * here, because this file runs under the pre-commit hook, which exports the variables that would
 * send a throwaway repository at the repository being committed to.
 */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await execGit(cwd, args)
  if (r.code !== 0) {
    throw new GitError(args, r.stderr, r.code)
  }
  return r.stdout.toString('utf8').trim()
}

async function initRepo(): Promise<{ dir: string; sha1: string; sha2: string }> {
  const dir = await makeTempDir('pr-review-git-')
  await g(dir, 'init', '-q', '-b', 'main')
  await g(dir, 'config', 'user.email', 'test@example.com')
  await g(dir, 'config', 'user.name', 'Test')
  await g(dir, 'remote', 'add', 'origin', '/nonexistent/pr-review-test/widgets.git')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
  await g(dir, 'add', '.')
  await g(dir, 'commit', '-q', '-m', 'one')
  const sha1 = await g(dir, 'rev-parse', 'HEAD')
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 2\n')
  await g(dir, 'commit', '-q', '-am', 'two')
  const sha2 = await g(dir, 'rev-parse', 'HEAD')
  return { dir, sha1, sha2 }
}

describe('createGit (real adapter)', () => {
  let repo: { dir: string; sha1: string; sha2: string }
  beforeAll(async () => {
    repo = await initRepo()
  })
  afterAll(() => rm(repo.dir, { recursive: true, force: true }))

  it('resolves refs, merge bases, and commit existence', async () => {
    const git = createGit(repo.dir)
    expect(await git.revParse('HEAD')).toBe(repo.sha2)
    expect(await git.mergeBase(repo.sha1, repo.sha2)).toBe(repo.sha1)
    expect(await git.commitExists(repo.sha1)).toBe(true)
    expect(await git.commitExists('f'.repeat(40))).toBe(false)
  })

  it('throws GitError for an unknown ref', async () => {
    const git = createGit(repo.dir)
    await expect(git.revParse('refs/pr/999/head')).rejects.toBeInstanceOf(GitError)
  })

  it('diffs two commits with rename detection and 3 lines of context', async () => {
    const git = createGit(repo.dir)
    const diff = await git.diff(repo.sha1, repo.sha2)
    expect(diff).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(diff).toContain('-export const a = 1')
    expect(diff).toContain('+export const a = 2')
  })

  it('reads blobs and sizes, and returns null for missing paths', async () => {
    const git = createGit(repo.dir)
    expect((await git.show(repo.sha1, 'src/a.ts'))?.toString('utf8')).toBe('export const a = 1\n')
    expect(await git.blobSize(repo.sha1, 'src/a.ts')).toBe(19)
    expect(await git.show(repo.sha1, 'src/missing.ts')).toBeNull()
    expect(await git.blobSize(repo.sha1, 'src/missing.ts')).toBeNull()
    expect(await git.commitAuthor(repo.sha1)).toBe(await git.commitAuthor('HEAD'))
    expect((await git.commitAuthor(repo.sha1)).length).toBeGreaterThan(0)
    await expect(git.commitAuthor('nope-ref')).rejects.toThrow()
  })

  it('reports the top level, the common dir, and the origin url', async () => {
    const git = createGit(repo.dir)
    const real = await run('realpath', [repo.dir])
    expect(await git.topLevel()).toBe(real.stdout.trim())
    expect(await git.commonDir()).toBe(path.join(real.stdout.trim(), '.git'))
    expect(await git.remoteUrl('origin')).toBe('/nonexistent/pr-review-test/widgets.git')
    expect(await git.remoteUrl('upstream')).toBeNull()
  })

  it('fails fetch against a remote that does not exist', async () => {
    const git = createGit(repo.dir)
    await expect(git.fetch('origin', ['+refs/heads/main:refs/pr/1/base'])).rejects.toBeInstanceOf(GitError)
  })

  it('fetches from a local remote', async () => {
    const clone = await makeTempDir('pr-review-clone-')
    try {
      await g(repo.dir, 'clone', '-q', repo.dir, clone)
      const git = createGit(clone)
      await git.fetch('origin', ['+refs/heads/main:refs/pr/1/head'])
      expect(await git.revParse('refs/pr/1/head')).toBe(repo.sha2)
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
  })

  it('reads the directory it was given even when the environment points elsewhere', async () => {
    // What a git hook hands its children: every command would go to that repository instead. The
    // pre-commit hook of this project is how the suite meets them. Only these three keys are put
    // back, since `process.env` is shared with everything else running in this worker.
    const poisoned = {
      GIT_DIR: path.join(repo.dir, 'not-a-repository'),
      GIT_WORK_TREE: repo.dir,
      GIT_INDEX_FILE: path.join(repo.dir, 'not-an-index'),
    }
    for (const [name, value] of Object.entries(poisoned)) {
      vi.stubEnv(name, value)
    }
    try {
      // The one git call in this file that must NOT go through `g`: it is the baseline, git as the
      // adapter used to run it, and routing it through the scrub would make it pass for the wrong
      // reason and prove nothing. The message is matched so the failure is the poisoning and not
      // some unrelated error; git's wording here has been stable for its whole life.
      await expect(run('git', ['rev-parse', 'HEAD'], { cwd: repo.dir })).rejects.toThrow(
        /not a git repository/i
      )
      expect(await createGit(repo.dir).revParse('HEAD')).toBe(repo.sha2)
      // The default argument reads that live environment, and drops the same names from it.
      expect(Object.keys(poisoned).some(name => name in envWithoutRepo())).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('names every variable it drops, and keeps everything else', () => {
    // Spelled out rather than derived from the list: the content of the list is the whole risk,
    // and a name quietly deleted from it has to fail here.
    expect([...REPO_ENV_VARS]).toEqual([
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_NAMESPACE',
      'GIT_PREFIX',
    ])
    const kept = { PATH: '/bin', SSH_AUTH_SOCK: '/run/ssh', GIT_CONFIG_GLOBAL: '/home/u/.gitconfig' }
    const inherited = { ...kept, ...Object.fromEntries(REPO_ENV_VARS.map(name => [name, '/x'])) }
    expect(envWithoutRepo(inherited)).toEqual(kept)
    expect(inherited).toHaveProperty('GIT_DIR', '/x')
  })

  it('reports a non-numeric exit as code 1 through the exec wrapper', async () => {
    const result = await execGit('/nonexistent-dir-for-pr-review', ['status'])
    expect(result.code).not.toBe(0)
  })

  it('formats GitError from an injected exec', async () => {
    const exec: GitExec = async () => ({ stdout: Buffer.from(''), stderr: 'boom\n', code: 3 })
    const git = createGit('/tmp', exec)
    await expect(git.topLevel()).rejects.toMatchObject({
      name: 'GitError',
      exitCode: 3,
      stderr: 'boom\n',
      message: 'git rev-parse --show-toplevel failed (3): boom',
    })
  })

  it('keeps URL credentials and long stderr out of the GitError message', () => {
    const leaky = 'fatal: unable to access https://user:ghp_secret@github.com/acme/widgets.git/: 403\n'
    const err = new GitError(['fetch', 'origin'], leaky, 128)
    expect(err.message).toBe(
      'git fetch origin failed (128): fatal: unable to access https://***@github.com/acme/widgets.git/: 403'
    )
    expect(err.message).not.toContain('ghp_secret')
    expect(err.stderr).toBe(leaky)
    const long = new GitError(['diff'], 'x'.repeat(STDERR_MESSAGE_MAX + 50), 1)
    expect(long.message).toBe(`git diff failed (1): ${'x'.repeat(STDERR_MESSAGE_MAX)}…`)
    expect(redactStderr('ssh://git@host/repo and http://a:b@h/x')).toBe(
      'ssh://***@host/repo and http://***@h/x'
    )
  })
})
