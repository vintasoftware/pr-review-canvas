// @vitest-environment node
// Two checkouts of one clone, as the shared server serves them: the main checkout at /repo and a
// linked worktree at /trees/fix, over one data dir and one clone part. A pull request is one review
// for both; each checkout's local reviews are its own.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { ChatBusyError } from '../chat/chat-manager.js'
import { startCheckoutSweep } from '../chat/checkout-sweep.js'
import { CheckoutBusyError } from '../chat/checkouts.js'
import type { ChatEvent } from '../contract/chat.js'
import { parseReviewFolder, type LocalKey, type ReviewKey } from '../contract/review-key.js'
import { type CheckoutsResponse, DEFAULT_SETTINGS } from '../contract/settings.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { artifactToModelOutput } from '../review/normalize.js'
import { prepare } from '../review/prepare.js'
import { publish } from '../review/publish.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import { createFakeRunner, type FakeRunner } from '../testing/fake-runner.js'
import {
  createFakeCheckoutGit,
  makeTempDir,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  ghFor42,
  gitForLocal,
  HEAD_SHA,
  SYNTHETIC_FILES,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'
import { type CloneShared, createCloneShared } from './context.js'

const LOCAL = { host: 'localhost:3010' }
const POST = { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' }
const MOVED_SHA = 'c'.repeat(40)

let shared: string
let clock: Date
let clone: CloneShared
let opened: TestContext[]

const now = (): Date => clock

/** One checkout's context over the shared data dir and clone part. */
async function checkout(
  repoRoot: '/repo' | '/trees/fix',
  opts: { runner?: FakeRunner | undefined; clone?: CloneShared | null } = {}
): Promise<TestContext> {
  const t = await makeTestContext({
    dataDir: shared,
    repoRoot,
    git: gitForLocal({ head: HEAD_SHA }),
    gh: ghFor42(),
    now,
    ...(opts.clone === null ? {} : { clone: opts.clone ?? clone }),
    ...(opts.runner === undefined ? {} : { runner: opts.runner }),
  })
  opened.push(t)
  return t
}

async function pair(runners: { main?: FakeRunner; fix?: FakeRunner } = {}) {
  return {
    main: await checkout('/repo', { runner: runners.main }),
    fix: await checkout('/trees/fix', { runner: runners.fix }),
  }
}

function target(source: LocalKey) {
  return { kind: 'local', base: 'origin/main', source } as const
}

/** Prepares the branch review and publishes the synthetic model against it, as the CLI does. */
async function publishBranch(t: TestContext): Promise<void> {
  const quiet = { force: false, log: () => undefined }
  const result = await prepare(t.ctx, target('branch'), quiet)
  await writeTextAtomic(
    `${result.canvasDir}/model.json`,
    JSON.stringify(artifactToModelOutput(syntheticArtifact()))
  )
  await publish(t.ctx, result.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
}

/** A chat turn on `key`; resolves with its events once it has ended. */
function chatTurn(t: TestContext, key: ReviewKey): Promise<ChatEvent[]> {
  const stream = t.ctx.chat.send(
    {
      key,
      headSha: HEAD_SHA,
      artifact: syntheticArtifact(),
      files: SYNTHETIC_FILES.map(toFileEntry),
      patches: toPatchMap(SYNTHETIC_FILES),
      derivedDir: path.join(shared, 'derived'),
      readLines: async () => [],
    },
    { message: 'is this covered?', context: { kind: 'pr' } }
  )
  return (async () => {
    const events: ChatEvent[] = []
    for await (const event of stream) {
      events.push(event)
    }
    return events
  })()
}

beforeEach(async () => {
  shared = await makeTempDir('pr-review-worktrees-')
  clock = new Date('2026-09-10T12:00:00.000Z')
  opened = []
  clone = createCloneShared(
    { dataDir: shared, repo: TEST_REPO, commonDir: '/repo/.git' },
    now,
    createFakeCheckoutGit()
  )
})

afterEach(async () => {
  await Promise.all(opened.map(t => t.cleanup()))
  await rm(shared, { recursive: true, force: true })
})

describe('the files of a review', () => {
  it("are a local review's own in each checkout, and a pull request's in both", async () => {
    const { main, fix } = await pair()
    expect([main.ctx.config.worktree, fix.ctx.config.worktree]).toEqual([null, 'fix'])
    const prs = path.join(shared, 'repos', 'acme__widgets', 'prs')
    expect(main.ctx.prs.prDir('branch')).toBe(path.join(prs, 'branch'))
    expect(fix.ctx.prs.prDir('branch')).toBe(path.join(prs, 'branch~fix'))
    expect(fix.ctx.prs.prDir('uncommitted')).toBe(path.join(prs, 'uncommitted~fix'))
    expect(main.ctx.prs.prDir(42)).toBe(path.join(prs, '42'))
    expect(fix.ctx.prs.prDir(42)).toBe(main.ctx.prs.prDir(42))
  })

  it("keep one checkout's local target, meta, and marks out of the other's, while a PR's are shared", async () => {
    const { main, fix } = await pair()
    await prepare(fix.ctx, target('branch'), { force: false, log: () => undefined })
    expect(await fix.ctx.prs.readLocalTarget('branch')).toEqual(target('branch'))
    expect(await fix.ctx.prs.readPr('branch')).toMatchObject({ state: 'branch', headSha: HEAD_SHA })
    expect(await main.ctx.prs.readLocalTarget('branch')).toBeNull()
    expect(await main.ctx.prs.readPr('branch')).toBeNull()

    // A mark through the route lands in the worktree's state alone.
    const put = await createApp(fix.ctx).request('/api/prs/branch/reviewed/layer:l1', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ reviewed: true }),
    })
    expect(put.status).toBe(200)
    const stateOf = async (t: TestContext, key: ReviewKey) => {
      const res = await createApp(t.ctx).request(`/api/prs/${String(key)}/state`, { headers: LOCAL })
      return ((await res.json()) as { state: { reviewed: Record<string, true> } }).state.reviewed
    }
    expect(await stateOf(fix, 'branch')).toEqual({ 'layer:l1': true })
    expect(await stateOf(main, 'branch')).toEqual({})

    // A pull request's marks are the same review from either checkout.
    await main.ctx.state.setReviewed(42, 'layer:l1', true, { canvasSha: HEAD_SHA, carried: {} })
    expect(await stateOf(fix, 42)).toEqual({ 'layer:l1': true })
  })

  it('keeps the worktree target across a reload, and the next write after it', async () => {
    const first = await checkout('/trees/fix', { clone: null })
    await first.ctx.prs.writeLocalTarget('branch', { kind: 'local', base: 'origin/main', source: 'branch' })
    // The server restarts: a fresh context for the same checkout over the same data dir.
    const second = await checkout('/trees/fix', { clone: null })
    expect(await second.ctx.prs.readLocalTarget('branch')).toEqual({
      kind: 'local',
      base: 'origin/main',
      source: 'branch',
    })
    await second.ctx.prs.writeLocalTarget('branch', {
      kind: 'local',
      base: 'origin/release',
      source: 'branch',
    })
    const third = await checkout('/trees/fix', { clone: null })
    expect(await third.ctx.prs.readLocalTarget('branch')).toEqual({
      kind: 'local',
      base: 'origin/release',
      source: 'branch',
    })
    // The main checkout never saw either.
    expect(await (await checkout('/repo', { clone: null })).ctx.prs.readLocalTarget('branch')).toBeNull()
  })
})

describe('the canvases of a local review', () => {
  it("are the checkout's that made them, while one from before worktrees stays the main checkout's", async () => {
    const { main, fix } = await pair()
    await publishBranch(fix)
    const index = async () => (await fix.ctx.canvases.readIndex()).canvases
    expect((await index())[HEAD_SHA]).toMatchObject({ checkout: 'fix' })
    expect((await index())[HEAD_SHA]?.prNumber).toBeUndefined()
    // At another head, only the worktree falls back to its own canvas.
    expect(await fix.ctx.canvases.findForLocal('branch', MOVED_SHA)).toMatchObject({
      status: 'stale',
      headSha: HEAD_SHA,
    })
    expect(await main.ctx.canvases.findForLocal('branch', MOVED_SHA)).toEqual({ status: 'missing' })

    // A local canvas the main checkout writes, the only kind there was before worktrees, has no
    // checkout and is the main checkout's alone.
    const manifest = {
      formatVersion: 1 as const,
      tool: { name: 'pr-review', version: '0.6.0' },
      repo: TEST_REPO,
      headSha: BASE_SHA,
      mergeBaseSha: BASE_SHA,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: '2026-09-11T12:00:00.000Z',
      generator: { agent: 'claude', harness: 'claude-code' as const, attempts: 1 },
    }
    await main.ctx.canvases.write(BASE_SHA, syntheticArtifact(), manifest)
    expect(Object.keys((await index())[BASE_SHA] ?? {})).not.toContain('checkout')
    expect(await main.ctx.canvases.findForLocal('branch', MOVED_SHA)).toMatchObject({
      status: 'stale',
      headSha: BASE_SHA,
    })
    expect(await fix.ctx.canvases.findForLocal('branch', MOVED_SHA)).toMatchObject({
      status: 'stale',
      headSha: HEAD_SHA,
    })
    const entries = await index()
    expect([main, fix].map(t => t.ctx.canvases.belongsTo(entries[BASE_SHA]!, 'branch'))).toEqual([
      true,
      false,
    ])
    expect([main, fix].map(t => t.ctx.canvases.belongsTo(entries[HEAD_SHA]!, 'branch'))).toEqual([
      false,
      true,
    ])
    // A pull request's canvas, from either checkout, is every checkout's.
    await fix.ctx.canvases.write(MOVED_SHA, syntheticArtifact(), { ...manifest, headSha: MOVED_SHA }, 42)
    const pr = (await index())[MOVED_SHA]!
    expect(pr).toMatchObject({ prNumber: 42 })
    expect(Object.keys(pr)).not.toContain('checkout')
    expect([main, fix].map(t => t.ctx.canvases.belongsTo(pr, 42))).toEqual([true, true])
  })

  it('take a mark keyed to them from their own checkout only', async () => {
    const { main, fix } = await pair()
    await publishBranch(fix)
    // Both branch reviews have moved on since the worktree's canvas was made.
    const moved = { ...syntheticArtifact().pr, number: null, state: 'branch' as const, headSha: MOVED_SHA }
    await main.ctx.prs.writePr('branch', moved)
    await fix.ctx.prs.writePr('branch', moved)
    const mark = (t: TestContext) =>
      createApp(t.ctx).request('/api/prs/branch/reviewed/layer:l1', {
        method: 'PUT',
        headers: POST,
        body: JSON.stringify({ reviewed: true, canvasSha: HEAD_SHA }),
      })
    const refused = await mark(main)
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({
      error: {
        code: 'CANVAS_NOT_FOUND',
        message: `${HEAD_SHA.slice(0, 7)} is not a canvas of Branch review`,
      },
    })
    expect((await main.ctx.state.read('branch')).reviewed).toEqual({})
    const accepted = await mark(fix)
    expect(accepted.status).toBe(200)
    expect((await fix.ctx.state.read('branch')).reviewed).toEqual({ 'layer:l1': true })
  })
})

describe('the chat turns of the clone', () => {
  it("are busy for a pull request across checkouts, and never for another checkout's local review", async () => {
    let open = () => {}
    const gate = new Promise<void>(resolve => {
      open = resolve
    })
    const { main, fix } = await pair({
      main: createFakeRunner({ ensureGate: gate }),
      fix: createFakeRunner(),
    })
    const held = chatTurn(main, 'branch')
    await vi.waitFor(() => expect([...clone.chatTurns]).toEqual(['branch']))
    // The worktree's branch review is its own, so its turn runs while the main checkout's holds.
    expect((await chatTurn(fix, 'branch')).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    const pr = chatTurn(main, 42)
    await vi.waitFor(() => expect([...clone.chatTurns].sort()).toEqual(['42', 'branch']))
    await expect(chatTurn(fix, 42)).rejects.toBeInstanceOf(ChatBusyError)
    expect(main.ctx.chat.running().sort()).toEqual([42, 'branch'].sort())
    open()
    for (const events of [await held, await pr]) {
      expect(events.at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    }
    expect([...clone.chatTurns]).toEqual([])
    expect((await chatTurn(fix, 42)).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
  })
})

describe('the review checkouts of the clone', () => {
  it('give each checkout its own branch checkout, and one shared checkout per pull request', async () => {
    const { main, fix } = await pair()
    const [mine, theirs] = await Promise.all([
      main.ctx.checkouts.lease('branch', 'chat'),
      fix.ctx.checkouts.lease('branch', 'chat'),
    ])
    const root = clone.checkouts.root
    expect([mine.dir, theirs.dir]).toEqual([path.join(root, 'branch'), path.join(root, 'branch~fix')])
    await mine.moveTo(HEAD_SHA)
    clock = new Date('2026-09-10T12:05:00.000Z')
    await theirs.moveTo(BASE_SHA)

    const pr = await main.ctx.checkouts.lease(42, 'chat')
    const refused = await fix.ctx.checkouts.lease(42, 'generation').catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(CheckoutBusyError)
    expect(refused).toMatchObject({
      holder: 'chat',
      message: 'a chat answer is using the review checkout of 42',
    })
    await Promise.all([mine.release(), theirs.release(), pr.release()])

    const listed = await clone.checkouts.list()
    expect(listed.map(({ key, worktree, folder, sha }) => ({ key, worktree, folder, sha }))).toEqual([
      { key: 'branch', worktree: 'fix', folder: 'branch~fix', sha: BASE_SHA },
      { key: 'branch', worktree: null, folder: 'branch', sha: HEAD_SHA },
    ])
    for (const info of listed) {
      expect(parseReviewFolder(info.folder)).toEqual({ key: info.key, worktree: info.worktree })
    }
    // The settings dialog of either checkout lists the clone's checkouts, naming the worktree.
    const res = await createApp(fix.ctx).request('/api/checkouts', { headers: LOCAL })
    const body = (await res.json()) as CheckoutsResponse
    expect(body.checkouts.map(c => [c.key, c.worktree, c.locked])).toEqual([
      ['branch', 'fix', false],
      ['branch', null, false],
    ])
  })

  it("are swept by folder, so a linked worktree's goes by its own name", async () => {
    const { main, fix } = await pair()
    for (const t of [main, fix]) {
      const lease = await t.ctx.checkouts.lease('branch', 'chat')
      await lease.moveTo(HEAD_SHA)
      await lease.release()
    }
    clock = new Date('2026-09-20T12:00:00.000Z')
    const fresh = await main.ctx.checkouts.lease('branch', 'chat')
    await fresh.moveTo(BASE_SHA)
    await fresh.release()
    // The idle sweep the hub runs over the clone, at its start, logs the folder it removed.
    const lines: string[] = []
    const sweeper = startCheckoutSweep({
      checkouts: clone.checkouts,
      readSettings: async () => ({ ...DEFAULT_SETTINGS, checkoutIdleDays: 7 }),
      log: line => lines.push(line),
    })
    try {
      await vi.waitFor(() =>
        expect(lines).toEqual([
          'removed the idle review checkout of branch~fix (last used 2026-09-10T12:00:00.000Z)',
        ])
      )
    } finally {
      sweeper.stop()
    }
    expect((await clone.checkouts.list()).map(c => c.folder)).toEqual(['branch'])
    // Then `clean --all` takes the rest.
    const lease = await fix.ctx.checkouts.lease('branch', 'chat')
    await lease.moveTo(HEAD_SHA)
    await lease.release()
    const all = await clone.checkouts.sweep({ all: true })
    expect(all.removed.map(c => c.folder).sort()).toEqual(['branch', 'branch~fix'])
    expect(await clone.checkouts.list()).toEqual([])
  })
})
