// @vitest-environment node
// One checkout's context over a real throwaway repository: the config comes from git, so this
// file runs the real binary, as every command and the shared server do.
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ConfigError, type RuntimeConfig } from './config.js'
import { execGit, GitError } from './git/git.js'
import { loadContext, loadFixture, ProjectFlagsSchema } from './load-context.js'
import { createCloneShared } from './server/context.js'
import { makeTempDir } from './testing/fakes.js'
import { syntheticArtifact } from './testing/synthetic.js'

let dir: string
let repo: string

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execGit(cwd, args)
  if (r.code !== 0) {
    throw new GitError(args, r.stderr, r.code)
  }
  return r.stdout.toString('utf8').trim()
}

/** A command on a PATH of its own that prints, or logs, the variables it was run with. */
async function onPath(name: string, script: string): Promise<string> {
  const bin = path.join(dir, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`)
  await chmod(path.join(bin, name), 0o755)
  return bin
}

beforeEach(async () => {
  dir = await realpath(await makeTempDir('pr-review-load-context-'))
  repo = path.join(dir, 'widgets')
  await mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git')
})

afterEach(async () => {
  delete process.env['PR_REVIEW_PROCESS_ONLY']
  delete process.env['PR_REVIEW_DATA_DIR']
  await rm(dir, { recursive: true, force: true })
})

describe('ProjectFlagsSchema', () => {
  it('takes the per-project flags and nothing else', () => {
    expect(ProjectFlagsSchema.parse({ dataDir: '/d', chatAgent: 'codex' })).toEqual({
      dataDir: '/d',
      chatAgent: 'codex',
    })
    expect(ProjectFlagsSchema.safeParse({ dataDir: 1 }).success).toBe(false)
  })
})

describe('loadFixture', () => {
  it('reads a fixture canvas, and names a missing one', async () => {
    const file = path.join(dir, 'review.json')
    await writeFile(file, JSON.stringify(syntheticArtifact()))
    expect(await loadFixture(file)).toEqual(syntheticArtifact())
    const missing = await loadFixture(path.join(dir, 'nope.json')).catch((err: unknown) => err)
    expect(missing).toBeInstanceOf(ConfigError)
    expect(missing).toMatchObject({
      code: 'BAD_REQUEST',
      message: `fixture canvas not found: ${dir}/nope.json`,
    })
  })
})

describe('loadContext', () => {
  it("builds the checkout's context from git, under its base path, with its data dir made", async () => {
    const log = (): void => undefined
    const ctx = await loadContext({ repoDir: path.join(repo), cwd: repo, env: {}, port: 4321, log })
    expect(ctx.config).toMatchObject({
      repoRoot: repo,
      commonDir: path.join(repo, '.git'),
      repo: { owner: 'acme', name: 'widgets' },
      slug: 'acme/widgets',
      basePath: '/r/acme/widgets/',
      port: 4321,
      dataDir: path.join(repo, '.pr-review'),
      fixtureCanvasPath: null,
      chatOverrides: {},
    })
    expect((await stat(ctx.config.dataDir)).isDirectory()).toBe(true)
    expect(await readFile(path.join(ctx.config.dataDir, '.gitignore'), 'utf8')).toBe('*\n')
    expect(ctx.fixtureArtifact).toBeNull()
    expect(ctx.log).toBe(log)
  })

  it('names a linked worktree after its folder, and gives it the data dir of its clone', async () => {
    await git(
      repo,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one'
    )
    const tree = path.join(dir, 'fix login')
    await git(repo, 'worktree', 'add', '-q', '--detach', tree)
    const ctx = await loadContext({ repoDir: path.join(tree), cwd: tree, env: {} })
    expect(ctx.config).toMatchObject({
      repoRoot: tree,
      commonDir: path.join(repo, '.git'),
      slug: 'acme/widgets~fix-login',
      basePath: '/r/acme/widgets~fix-login/',
      dataDir: path.join(repo, '.pr-review'),
    })
  })

  it('applies the flags, a fixture canvas relative to the folder the command ran in', async () => {
    const fixture = path.join(dir, 'review.json')
    await writeFile(fixture, JSON.stringify(syntheticArtifact()))
    const ctx = await loadContext({
      repoDir: repo,
      cwd: dir,
      env: {},
      flags: {
        dataDir: path.join(dir, 'data'),
        fixtureCanvas: 'review.json',
        chatAgent: 'codex',
        chatModel: 'gpt-5',
      },
    })
    expect(ctx.config).toMatchObject({
      dataDir: path.join(dir, 'data'),
      fixtureCanvasPath: fixture,
      chatOverrides: { chatAgent: 'codex', chatModel: 'gpt-5' },
    })
    expect(ctx.fixtureArtifact).toEqual(syntheticArtifact())
    expect((await stat(path.join(dir, 'data'))).isDirectory()).toBe(true)
  })

  it('refuses an unknown chat agent and a missing fixture canvas', async () => {
    const agent = await loadContext({ repoDir: repo, cwd: repo, env: {}, flags: { chatAgent: 'gpt' } }).catch(
      (err: unknown) => err
    )
    expect(agent).toBeInstanceOf(ConfigError)
    expect(agent).toMatchObject({ code: 'BAD_REQUEST', message: 'unknown chat agent: gpt' })
    const fixture = await loadContext({
      repoDir: repo,
      cwd: repo,
      env: {},
      flags: { fixtureCanvas: path.join(dir, 'nope.json') },
    }).catch((err: unknown) => err)
    expect(fixture).toBeInstanceOf(ConfigError)
    expect(fixture).toMatchObject({ message: `fixture canvas not found: ${dir}/nope.json` })
  })

  it('makes no data dir for validate and publish, which work in the one prepare made', async () => {
    const canvasDir = path.join(
      dir,
      'sandbox',
      '.pr-review',
      'repos',
      'acme__widgets',
      'canvases',
      'a'.repeat(40)
    )
    const ctx = await loadContext({ repoDir: repo, cwd: repo, env: {}, canvasDir, createDataDir: false })
    expect(ctx.config.dataDir).toBe(path.join(dir, 'sandbox', '.pr-review'))
    await expect(stat(ctx.config.dataDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(repo, '.pr-review'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it("reads its variables, and runs git and the host CLI, under the shell's environment alone", async () => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const calls = path.join(dir, 'git-calls.log')
    await onPath(
      'git',
      `echo "$PR_REVIEW_MARK/\${PR_REVIEW_PROCESS_ONLY:-unset}" >> "${calls}"\nexec "${realGit}" "$@"`
    )
    const bin = await onPath(
      'gh',
      'echo "{\\"mark\\":\\"$PR_REVIEW_MARK/${PR_REVIEW_PROCESS_ONLY:-unset}\\"}"'
    )
    // Set in this process only: the shell that opened the project has neither.
    process.env['PR_REVIEW_PROCESS_ONLY'] = 'leaked'
    process.env['PR_REVIEW_DATA_DIR'] = path.join(dir, 'server-data')
    const dataDir = path.join(dir, 'shell-data')
    const ctx = await loadContext({
      repoDir: repo,
      cwd: repo,
      env: { PATH: `${bin}:/usr/bin:/bin`, PR_REVIEW_MARK: 'from-shell', PR_REVIEW_DATA_DIR: dataDir },
    })
    expect(ctx.config.dataDir).toBe(dataDir)
    // The config came from the shell's git, and so do the context's own git commands.
    const loaded = (await readFile(calls, 'utf8')).split('\n').filter(line => line !== '')
    expect(loaded.length).toBeGreaterThan(0)
    expect(new Set(loaded)).toEqual(new Set(['from-shell/unset']))
    expect(await ctx.git.currentBranch()).toBe('main')
    expect((await readFile(calls, 'utf8')).split('\n').filter(line => line !== '')).toHaveLength(
      loaded.length + 1
    )
    expect(await ctx.gh.api('user')).toEqual({ mark: 'from-shell/unset' })
    // Without an environment of its own, it reads this process's.
    const own = await loadContext({ repoDir: repo, cwd: repo, createDataDir: false })
    expect(own.config.dataDir).toBe(path.join(dir, 'server-data'))
  })

  it('gives the context the part its clone shares, once the config names the clone', async () => {
    const seen: RuntimeConfig[] = []
    let shared: ReturnType<typeof createCloneShared> | null = null
    const ctx = await loadContext({
      repoDir: repo,
      cwd: repo,
      env: {},
      cloneOf: config => {
        seen.push(config)
        shared = createCloneShared(config, () => new Date(0))
        return shared
      },
    })
    expect(seen).toEqual([ctx.config])
    expect(ctx.clone).toBe(shared)
    expect(ctx.checkouts).toBe(ctx.clone.checkouts)
    const alone = await loadContext({ repoDir: repo, cwd: repo, env: {} })
    expect(alone.clone).not.toBe(shared)
  })

  it('refuses a folder that is not a git checkout', async () => {
    const outside = path.join(dir, 'outside')
    await mkdir(outside)
    await expect(loadContext({ repoDir: outside, cwd: outside, env: {} })).rejects.toMatchObject({
      code: 'NOT_A_REPO',
    })
  })
})
