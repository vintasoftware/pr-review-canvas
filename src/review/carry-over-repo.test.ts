// @vitest-environment node
// The identical-diff rule against a real repository. The fake git answers whatever a test hands
// it, so it can agree with a rule that is wrong about git; here the three heads are built with
// the real binary and the diffs are whatever git actually produces for them.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createGit, execGit, GitError } from '../git/git.js'
import { makeTempDir, makeTestContext, type TestContext } from '../testing/fakes.js'
import { standsForHead } from './carry-over.js'

/** Every git command here runs through the adapter's own runner, so the setup cannot drift. */
async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await execGit(cwd, args)
  if (r.code !== 0) {
    throw new GitError(args, r.stderr, r.code)
  }
  return r.stdout.toString('utf8').trim()
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
  await writeFile(path.join(dir, file), content, 'utf8')
}

const APP_BASE = 'export function run() {\n  return 1\n}\n'
const APP_CHANGED = 'export function run() {\n  return 2\n}\n'

interface Repo {
  dir: string
  /** The commit the canvas was generated for, and the base its diff runs from. */
  canvas: { headSha: string; mergeBaseSha: string }
  /** The base branch moved on without touching the files the pull request changes. */
  merged: { headSha: string; mergeBaseSha: string }
  /** A side branch adding a file was merged into the pull request. */
  withSideFile: { headSha: string; mergeBaseSha: string }
  /** The base branch added lines above the pull request's change, moving its hunk down. */
  shifted: { headSha: string; mergeBaseSha: string }
}

/**
 * One base commit, the pull request's own commit on top of it, and three later heads: the head a
 * base merge produced, the head a side-branch merge produced, and the head a base merge produced
 * after the base touched the same file above the change.
 */
async function buildRepo(): Promise<Repo> {
  const dir = await makeTempDir('pr-review-carry-')
  await g(dir, 'init', '-q', '-b', 'main')
  await g(dir, 'config', 'user.email', 'test@example.com')
  await g(dir, 'config', 'user.name', 'Test')
  await write(dir, 'src/app.ts', APP_BASE)
  await write(dir, 'src/other.ts', 'export const other = 1\n')
  await g(dir, 'add', '.')
  await g(dir, 'commit', '-q', '-m', 'base')
  const base = await g(dir, 'rev-parse', 'HEAD')

  // The pull request: one change, in one file.
  await g(dir, 'checkout', '-q', '-b', 'feature')
  await write(dir, 'src/app.ts', APP_CHANGED)
  await g(dir, 'commit', '-q', '-am', 'the pull request')
  const canvasSha = await g(dir, 'rev-parse', 'HEAD')

  // Three branches off the base, each merged into its own copy of the pull request.
  const branch = async (name: string, file: string, content: string): Promise<string> => {
    await g(dir, 'checkout', '-q', '-b', name, base)
    await write(dir, file, content)
    await g(dir, 'add', '.')
    await g(dir, 'commit', '-q', '-m', name)
    return g(dir, 'rev-parse', 'HEAD')
  }
  const untouched = await branch('base-untouched', 'src/other.ts', 'export const other = 2\n')
  const sideFile = await branch('side-file', 'src/new.ts', 'export const fresh = true\n')
  const shiftedBase = await branch('base-shifted', 'src/app.ts', `// a header line\n${APP_BASE}`)

  const mergeInto = async (name: string, from: string): Promise<string> => {
    await g(dir, 'checkout', '-q', '-b', name, canvasSha)
    await g(dir, 'merge', '-q', '--no-edit', from)
    return g(dir, 'rev-parse', 'HEAD')
  }
  const merged = await mergeInto('merged-base', untouched)
  const withSideFile = await mergeInto('merged-side', sideFile)
  const shifted = await mergeInto('merged-shifted', shiftedBase)

  const git = createGit(dir)
  const at = async (headSha: string, baseSha: string) => ({
    headSha,
    mergeBaseSha: await git.mergeBase(baseSha, headSha),
  })
  return {
    dir,
    canvas: await at(canvasSha, base),
    merged: await at(merged, untouched),
    withSideFile: await at(withSideFile, base),
    shifted: await at(shifted, shiftedBase),
  }
}

describe('the identical-diff rule against a real repository', () => {
  let repo: Repo
  let t: TestContext
  beforeAll(async () => {
    repo = await buildRepo()
  })
  afterAll(async () => rm(repo.dir, { recursive: true, force: true }))
  beforeEach(async () => {
    t = await makeTestContext({ git: createGit(repo.dir) })
  })
  afterEach(() => t.cleanup())

  /** The diff of one commit as the store builds it from the clone. */
  async function patchesOf(commit: { headSha: string; mergeBaseSha: string }) {
    const derived = await t.ctx.derived.readOrBuild(commit.headSha, commit.mergeBaseSha)
    expect(derived).not.toBeNull()
    return derived?.patches ?? {}
  }

  it('carries the canvas over to a head that merged the base without touching the changed files', async () => {
    expect(await standsForHead(t.ctx, repo.merged, repo.canvas)).toBe(true)
  })

  it('does not carry it over to a head that merged a side branch adding a file', async () => {
    expect(await standsForHead(t.ctx, repo.withSideFile, repo.canvas)).toBe(false)
    // The answer comes from comparing two diffs git built, not from a diff that was missing.
    expect(Object.keys(await patchesOf(repo.withSideFile))).toEqual(['src_app_ts', 'src_new_ts'])
  })

  it('does not carry it over when the base moved the change further down the file', async () => {
    expect(await standsForHead(t.ctx, repo.shifted, repo.canvas)).toBe(false)
    const [head, canvas] = [await patchesOf(repo.shifted), await patchesOf(repo.canvas)]
    // The same changed line, in a hunk that starts lower down: another diff.
    expect(Object.keys(head)).toEqual(['src_app_ts'])
    expect(head['src_app_ts']).not.toBe(canvas['src_app_ts'])
  })
})
