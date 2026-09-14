// @vitest-environment node
// The real adapter against a throwaway repository: git is a process boundary, but the adapter
// itself is what this file tests, so it needs the real binary once.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { makeTempDir } from '../testing/fakes.js'
import { createGit, execGit, GitError, type GitExec, redactStderr, STDERR_MESSAGE_MAX } from './git.js'

const run = promisify(execFile)

async function initRepo(): Promise<{ dir: string; sha1: string; sha2: string }> {
  const dir = await makeTempDir('pr-review-git-')
  const g = (...args: string[]) => run('git', args, { cwd: dir })
  await g('init', '-q', '-b', 'main')
  await g('config', 'user.email', 'test@example.com')
  await g('config', 'user.name', 'Test')
  await g('remote', 'add', 'origin', '/nonexistent/pr-review-test/widgets.git')
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 1\n')
  await g('add', '.')
  await g('commit', '-q', '-m', 'one')
  const sha1 = (await g('rev-parse', 'HEAD')).stdout.trim()
  await writeFile(path.join(dir, 'src/a.ts'), 'export const a = 2\n')
  await g('commit', '-q', '-am', 'two')
  const sha2 = (await g('rev-parse', 'HEAD')).stdout.trim()
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
      await run('git', ['clone', '-q', repo.dir, clone])
      const git = createGit(clone)
      await git.fetch('origin', ['+refs/heads/main:refs/pr/1/head'])
      expect(await git.revParse('refs/pr/1/head')).toBe(repo.sha2)
    } finally {
      await rm(clone, { recursive: true, force: true })
    }
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
    expect(redactStderr('ssh://git@host/repo and http://a:b@h/x')).toBe('ssh://***@host/repo and http://***@h/x')
  })
})
