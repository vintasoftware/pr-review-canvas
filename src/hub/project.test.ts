// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ChatBusyError } from '../chat/chat-manager.js'
import { ConfigError } from '../config.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import type { AppContext } from '../server/context.js'
import { makeTempDir } from '../testing/fakes.js'
import { HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import type { ProjectHooks } from './hub.js'
import { loadFixture, projectLoader } from './project.js'

let dir: string
let repo: string
let logs: string[]
const hooks: ProjectHooks = {
  chatBusyElsewhere: () => false,
  log: line => logs.push(line),
}

beforeEach(async () => {
  dir = await realpath(await makeTempDir('pr-review-project-'))
  repo = path.join(dir, 'widgets')
  logs = []
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The first step of a chat turn on #42, which is where a busy chat refuses it. */
function chatTurn(ctx: AppContext): Promise<unknown> {
  const stream = ctx.chat.send(
    {
      key: 42,
      headSha: HEAD_SHA,
      artifact: syntheticArtifact(),
      files: SYNTHETIC_FILES.map(toFileEntry),
      patches: toPatchMap(SYNTHETIC_FILES),
      derivedDir: path.join(dir, 'derived'),
      readLines: async () => [],
    },
    { message: 'x', context: { kind: 'pr' } }
  )
  return stream[Symbol.asyncIterator]().next()
}

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

describe('projectLoader', () => {
  it("builds the checkout's context under its base path, with the port the server has by then", async () => {
    let port = 0
    const load = projectLoader(() => port)
    port = 4321
    const ctx = await load({ repoRoot: repo }, hooks)
    expect(ctx.config).toMatchObject({
      repoRoot: repo,
      repo: { owner: 'acme', name: 'widgets' },
      basePath: '/r/acme/widgets/',
      port: 4321,
      dataDir: path.join(repo, '.pr-review'),
      openBrowser: false,
      fixtureCanvasPath: null,
    })
    expect((await stat(ctx.config.dataDir)).isDirectory()).toBe(true)
    expect(ctx.fixtureArtifact).toBeNull()
    expect(ctx.log).toBe(hooks.log)
  })

  it('applies the flags the command sent', async () => {
    const fixture = path.join(dir, 'review.json')
    await writeFile(fixture, JSON.stringify(syntheticArtifact()))
    const dataDir = path.join(dir, 'data')
    const ctx = await projectLoader(() => 3010)(
      { repoRoot: repo, flags: { dataDir, fixtureCanvas: fixture, chatAgent: 'codex', chatModel: 'gpt-5' } },
      hooks
    )
    expect(ctx.config).toMatchObject({
      dataDir,
      fixtureCanvasPath: fixture,
      chatOverrides: { chatAgent: 'codex', chatModel: 'gpt-5' },
    })
    expect(ctx.fixtureArtifact).toEqual(syntheticArtifact())
    await expect(
      projectLoader(() => 3010)({ repoRoot: repo, flags: { chatAgent: 'gpt' } }, hooks)
    ).rejects.toBeInstanceOf(ConfigError)
    await expect(
      projectLoader(() => 3010)(
        { repoRoot: repo, flags: { fixtureCanvas: path.join(dir, 'nope.json') } },
        hooks
      )
    ).rejects.toThrow('fixture canvas not found')
  })

  it('runs the config and the host CLI under the environment of the shell that opened it', async () => {
    const bin = path.join(dir, 'bin')
    await mkdir(bin)
    await writeFile(path.join(bin, 'gh'), '#!/bin/sh\necho "{\\"mark\\":\\"$PR_REVIEW_MARK\\"}"\n')
    await chmod(path.join(bin, 'gh'), 0o755)
    const dataDir = path.join(dir, 'shell-data')
    const ctx = await projectLoader(() => 3010)(
      {
        repoRoot: repo,
        env: { PATH: `${bin}:/usr/bin:/bin`, PR_REVIEW_MARK: 'from-shell', PR_REVIEW_DATA_DIR: dataDir },
      },
      hooks
    )
    expect(ctx.config.dataDir).toBe(dataDir)
    expect(await ctx.gh.api('user')).toEqual({ mark: 'from-shell' })
  })

  it("gives the context the server's check for a sibling's chat turn", async () => {
    const ctx = await projectLoader(() => 3010)(
      { repoRoot: repo },
      { ...hooks, chatBusyElsewhere: key => key === 42 }
    )
    await expect(chatTurn(ctx)).rejects.toBeInstanceOf(ChatBusyError)
  })

  it('refuses a folder that is not a git checkout', async () => {
    await expect(projectLoader(() => 3010)({ repoRoot: dir }, hooks)).rejects.toMatchObject({
      code: 'NOT_A_REPO',
    })
  })
})
