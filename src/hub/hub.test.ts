// @vitest-environment node
// The hub over real throwaway repositories: each checkout's name, base path, and data dir come from
// git as `serve` reads them (its origin, its folder, its clone), and the worktrees of one clone get
// their shared part from the hub's own `cloneOf`. Only the forge, the agent, and the git commands a
// request runs are fakes, so a test can hold a chat turn or a generation open.
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ChatBusyError } from '../chat/chat-manager.js'
import type { CheckoutSweeper } from '../chat/checkout-sweep.js'
import type { CheckoutStore } from '../chat/checkouts.js'
import { ConfigError } from '../config.js'
import type { ErrorEnvelope } from '../contract/api.js'
import type { ChatEvent } from '../contract/chat.js'
import type { ReviewKey } from '../contract/review-key.js'
import { GenerationBusyError } from '../generate/generation-manager.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { execGit, type Git, GitError } from '../git/git.js'
import type { HostClient } from '../host/client.js'
import { loadContext } from '../load-context.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import { createFakeGh, createFakeGit, makeTempDir } from '../testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import { readRegistry, writeRegistry } from './home.js'
import { createHub, type Hub, type LoadProject, type Project, type Registered } from './hub.js'

/** Every checkout sweep the hub starts, by the checkouts folder it sweeps, and whether it stopped. */
const sweeps = vi.hoisted(() => [] as { root: string; stopped: boolean }[])

vi.mock('../chat/checkout-sweep.js', async importOriginal => {
  const real = await importOriginal<typeof import('../chat/checkout-sweep.js')>()
  return {
    ...real,
    startCheckoutSweep: (opts: Parameters<typeof real.startCheckoutSweep>[0]): CheckoutSweeper => {
      const sweeper = real.startCheckoutSweep(opts)
      // The hub hands each sweep its clone's whole checkout store.
      const record = { root: (opts.checkouts as CheckoutStore).root, stopped: false }
      sweeps.push(record)
      return {
        runOnce: () => sweeper.runOnce(),
        stop: () => {
          expect(record.stopped).toBe(false)
          record.stopped = true
          sweeper.stop()
        },
      }
    },
  }
})

const LOCAL = { host: '127.0.0.1:3010' }
const POST = { ...LOCAL, origin: 'http://127.0.0.1:3010', 'content-type': 'application/json' }

/** Every call waits for `gate`, so a job that reaches git or the forge keeps running until then. */
function held<T extends object>(target: T, gate: Promise<void>): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop)
      if (typeof value !== 'function') {
        return value
      }
      return async (...args: unknown[]) => {
        await gate
        return (value as (...a: unknown[]) => unknown).apply(obj, args)
      }
    },
  })
}

let root: string
let home: string
let hubs: Hub[]
let contexts: AppContext[]
let loads: string[]
let logs: string[]
let gate: Promise<void>
let open: () => void
/** Per checkout: the git and forge its requests run against; held fakes by default. */
let adapters: Record<string, { git?: Git; gh?: HostClient }>
/** Per checkout: a promise its load waits for before it reads anything. */
let waits: Map<string, Promise<void>>

/** A checkout's folder under the test's temp root; the loader names a checkout by `name`. */
function at(name: string): string {
  return path.join(root, name)
}

function nameOf(dir: string): string {
  return `/${path.relative(root, dir)}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execGit(cwd, args)
  if (r.code !== 0) {
    throw new GitError(args, r.stderr, r.code)
  }
  return r.stdout.toString('utf8').trim()
}

/** A clone at `name` whose origin is `origin`, with one commit so it can have worktrees. */
async function makeClone(name: string, origin: string): Promise<void> {
  await mkdir(at(name), { recursive: true })
  await git(at(name), 'init', '-q', '-b', 'main')
  await git(at(name), 'remote', 'add', 'origin', origin)
  await git(
    at(name),
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one'
  )
}

/**
 * The checkout's context as `serve` builds one, through the real loader: the config from git and
 * the flags, the project config, and the fixture. Only the git a request runs, the forge, and the
 * agent are stand-ins, held at `gate`.
 */
const load: LoadProject = async (registration, hooks) => {
  const name = nameOf(registration.repoRoot)
  loads.push(name)
  hooks.log(`loading ${name}`)
  await waits.get(name)
  const ctx = await loadContext({
    repoDir: registration.repoRoot,
    cwd: registration.repoRoot,
    env: registration.env,
    flags: registration.flags,
    port: 3010,
    log: hooks.log,
    cloneOf: hooks.cloneOf,
    adapters: {
      git: adapters[name]?.git ?? held(createFakeGit(), gate),
      gh: adapters[name]?.gh ?? held(createFakeGh(), gate),
      runner: createFakeRunner({ ensureGate: gate }),
    },
  })
  contexts.push(ctx)
  return ctx
}

async function servedAt(h: Hub, pathname: string): Promise<Project | null> {
  const resolved = await h.resolve(pathname)
  return resolved?.kind === 'project' ? resolved.project : null
}

async function startHub(): Promise<Hub> {
  const hub = await createHub({ registry: home, load, log: line => logs.push(line) })
  hubs.push(hub)
  return hub
}

/** The checkouts with a sweep running, by the clone whose data dir holds them. */
function liveSweeps(): string[] {
  return sweeps
    .filter(sweep => !sweep.stopped)
    .map(sweep => nameOf(sweep.root.slice(0, sweep.root.indexOf('/.pr-review/'))))
    .sort()
}

function isIdle(ctx: AppContext): boolean {
  return ctx.generation.running() === null && ctx.chat.running().length === 0
}

/** Starts a chat turn on `key` that holds until the gate opens; resolves once it has ended. */
function chatTurn(ctx: AppContext, key: ReviewKey): Promise<ChatEvent[]> {
  const stream = ctx.chat.send(
    {
      key,
      headSha: HEAD_SHA,
      artifact: syntheticArtifact(),
      files: SYNTHETIC_FILES.map(toFileEntry),
      patches: toPatchMap(SYNTHETIC_FILES),
      derivedDir: path.join(root, 'derived'),
      readLines: async () => [],
      readerResolves: false,
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

/** A chat question on #42 through the project's own route, after the bundle route built `derived/`. */
async function askThroughRoute(project: Project): Promise<Response> {
  await project.app.request('/api/prs/42', { headers: LOCAL })
  return project.app.request('/api/prs/42/chat', {
    method: 'POST',
    headers: POST,
    body: JSON.stringify({ message: 'why?', context: { kind: 'pr' } }),
  })
}

beforeEach(async () => {
  root = await realpath(await makeTempDir('pr-review-hub-'))
  home = path.join(root, 'home')
  hubs = []
  contexts = []
  loads = []
  logs = []
  adapters = {}
  waits = new Map()
  sweeps.length = 0
  gate = new Promise(resolve => {
    open = resolve
  })
  await makeClone('/src/widgets', 'git@github.com:acme/widgets.git')
  await git(at('/src/widgets'), 'worktree', 'add', '-q', '--detach', at('/src/widgets-b'))
  // Another clone of the same repository, whose main checkout has the same name.
  await makeClone('/elsewhere/widgets', 'git@github.com:acme/widgets.git')
  await makeClone('/src/gadgets', 'git@github.com:acme/gadgets.git')
  // A folder that is no git checkout.
  await mkdir(at('/src/moved'), { recursive: true })
})

afterEach(async () => {
  open()
  for (const ctx of contexts) {
    await vi.waitFor(() => expect(isIdle(ctx)).toBe(true))
  }
  for (const h of hubs) {
    h.close()
  }
  expect(liveSweeps()).toEqual([])
  await rm(root, { recursive: true, force: true })
})

describe('createHub', () => {
  it('serves a registered checkout under its base path and saves it', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    expect(project.ctx.config).toMatchObject({
      slug: 'acme/widgets',
      basePath: '/r/acme/widgets/',
      repoRoot: at('/src/widgets'),
      dataDir: at('/src/widgets/.pr-review'),
    })
    expect(await h.resolve('/r/acme/widgets/review/42')).toEqual({
      kind: 'project',
      project,
      rest: '/review/42',
    })
    expect(await h.resolve('/r/acme/widgets/')).toMatchObject({ rest: '/' })
    expect(await h.projects()).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(await readRegistry(home)).toEqual(await h.projects())
  })

  it('keeps its list in memory when another server owns the saved one, and never writes it', async () => {
    const saved = [{ slug: 'acme/gadgets', repoRoot: at('/src/gadgets'), flags: {} }]
    await writeRegistry(home, saved)
    const before = await readFile(path.join(home, 'projects.json'), 'utf8')
    const second = await createHub({ registry: null, load, log: line => logs.push(line) })
    hubs.push(second)
    // It starts from an empty list, not from the other server's.
    expect(await second.projects()).toEqual([])
    await second.register({ repoRoot: at('/src/widgets'), flags: { chatModel: 'opus' } })
    expect(await second.projects()).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { chatModel: 'opus', dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(await second.remove('acme/widgets')).toBe(true)
    expect(await readFile(path.join(home, 'projects.json'), 'utf8')).toBe(before)
  })

  it('redirects a base path without its trailing slash, and knows no other path', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    expect(await h.resolve('/r/acme/widgets')).toEqual({ kind: 'redirect', location: '/r/acme/widgets/' })
    expect(await h.resolve('/r/acme/widget/')).toBeNull()
    expect(await h.resolve('/r/acme/widgetsx/')).toBeNull()
    expect(await h.resolve('/')).toBeNull()
  })

  it('reaches a worktree whose git name has characters the browser sends encoded, and hands the project the raw rest', async () => {
    await git(at('/src/widgets'), 'worktree', 'add', '-q', '--detach', at('/src/widgets-café'))
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets-café') })
    expect(project.ctx.config).toMatchObject({
      slug: 'acme/widgets~widgets-café',
      basePath: '/r/acme/widgets~widgets-caf%C3%A9/',
    })
    expect(await h.resolve('/r/acme/widgets~widgets-caf%C3%A9/review/42%2F')).toEqual({
      kind: 'project',
      project,
      rest: '/review/42%2F',
    })
    expect(await h.resolve('/r/acme/widgets~widgets-caf%C3%A9')).toEqual({
      kind: 'redirect',
      location: '/r/acme/widgets~widgets-caf%C3%A9/',
    })
    expect(await h.resolve('/r/acme/widgets~widgets-cafe/')).toBeNull()
    expect(await h.resolve('/r/acme/widgets~%E0%A4%A/')).toBeNull()
  })

  it('sends a path to the longest base it falls under, whatever the order they were saved in', async () => {
    await makeClone('/src/group', 'git@gitlab.com:group/proj.git')
    await makeClone('/src/subgroup', 'git@gitlab.com:group/proj/sub.git')
    const group = { slug: 'group/proj', repoRoot: at('/src/group'), flags: {} }
    const subgroup = { slug: 'group/proj/sub', repoRoot: at('/src/subgroup'), flags: {} }
    for (const saved of [
      [group, subgroup],
      [subgroup, group],
    ]) {
      await writeRegistry(home, saved)
      const h = await startHub()
      expect(await h.resolve('/r/group/proj/sub/review/1')).toMatchObject({
        project: { ctx: { config: { slug: 'group/proj/sub' } } },
        rest: '/review/1',
      })
      expect(await h.resolve('/r/group/proj/review/1')).toMatchObject({
        project: { ctx: { config: { slug: 'group/proj' } } },
        rest: '/review/1',
      })
      h.close()
    }
  })

  it('builds a saved project on its first request, once, and lists it before that', async () => {
    const first = await startHub()
    await first.register({ repoRoot: at('/src/widgets') })
    first.close()
    loads = []
    const h = await startHub()
    expect(await h.projects()).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(loads).toEqual([])
    const [a, b] = await Promise.all([h.resolve('/r/acme/widgets/'), h.resolve('/r/acme/widgets/api/health')])
    expect(a).toMatchObject({ kind: 'project', rest: '/' })
    expect(b).toMatchObject({ kind: 'project', rest: '/api/health' })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(await servedAt(h, '/r/acme/widgets/api/health'))
    await h.resolve('/r/acme/widgets/')
    expect(loads).toEqual(['/src/widgets'])
  })

  it('tries a saved project again on the next request after its build failed', async () => {
    await writeRegistry(home, [{ slug: 'acme/widgets', repoRoot: at('/src/moved'), flags: {} }])
    const h = await startHub()
    for (let i = 0; i < 2; i++) {
      const failed = await h.resolve('/r/acme/widgets/').catch((err: unknown) => err)
      expect(failed).toBeInstanceOf(ConfigError)
      expect(failed).toMatchObject({ code: 'NOT_A_REPO' })
    }
    expect(loads).toEqual(['/src/moved', '/src/moved'])
    expect(await h.projects()).toEqual([{ slug: 'acme/widgets', repoRoot: at('/src/moved'), flags: {} }])
  })

  it('names the project in the log lines of its context, and logs where it serves from', async () => {
    await writeFile(at('/src/widgets/pr-review.config.yml'), 'chat: [\n')
    const fixture = at('/review.json')
    await writeFile(fixture, JSON.stringify(syntheticArtifact()))
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets'), env: process.env })
    await h.register({ repoRoot: at('/src/gadgets'), env: process.env, flags: { fixtureCanvas: fixture } })
    project.ctx.log('hello')
    expect(logs).toEqual([
      'loading /src/widgets',
      `[acme/widgets] ${at('/src/widgets')} · data dir ${at('/src/widgets/.pr-review')}`,
      expect.stringMatching(/^\[acme\/widgets\] warning: pr-review\.config\.yml is not valid YAML/),
      'loading /src/gadgets',
      `[acme/gadgets] ${at('/src/gadgets')} · data dir ${at('/src/gadgets/.pr-review')}`,
      `[acme/gadgets] fixture canvas ${fixture} (dev only): every PR reports ready`,
      '[acme/widgets] hello',
    ])
  })

  it('replaces an idle project when its checkout registers again, with the flags it sends now', async () => {
    const h = await startHub()
    const { project: first } = await h.register({
      repoRoot: at('/src/widgets'),
      flags: { chatAgent: 'codex' },
    })
    // A registration with no flags, as `generate` sends, keeps the saved ones, time after time.
    for (let i = 0; i < 2; i++) {
      const { project: kept } = await h.register({ repoRoot: at('/src/widgets'), env: { HOME: '/home/me' } })
      expect(kept.ctx.config.chatOverrides).toEqual({ chatAgent: 'codex' })
      expect((await h.projects())[0]?.flags).toEqual({
        chatAgent: 'codex',
        dataDir: at('/src/widgets/.pr-review'),
      })
    }
    // Flags sent, even none set, as `open` sends them, replace the saved ones.
    const { project: second } = await h.register({ repoRoot: at('/src/widgets'), flags: {} })
    expect(second).not.toBe(first)
    expect(second.ctx.config.chatOverrides).toEqual({})
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(second)
    expect(await h.projects()).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(logs.some(line => line.includes('now serves'))).toBe(false)
    // Both contexts got the clone's one part; one sweep runs for it.
    expect(second.ctx.clone).toBe(first.ctx.clone)
    expect(liveSweeps()).toEqual(['/src/widgets'])
  })

  it('replaces a project that is running a chat turn; the turn goes on, and the new project counts it', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    const turn = chatTurn(project.ctx, 42)
    const { project: replaced } = await h.register({
      repoRoot: at('/src/widgets'),
      flags: { chatAgent: 'codex' },
    })
    expect(replaced).not.toBe(project)
    expect(replaced.ctx.config.chatOverrides).toEqual({ chatAgent: 'codex' })
    expect(await h.projects()).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { chatAgent: 'codex', dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(liveSweeps()).toEqual(['/src/widgets'])
    // The turn is the clone's, so nothing runs unseen: the new project counts it, and could stop it.
    expect(replaced.ctx.chat.running()).toEqual([42])
    open()
    expect((await turn).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    expect(replaced.ctx.chat.running()).toEqual([])
  })

  it('replaces a project that is generating a canvas, and the new project shows and stops the job', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await project.ctx.generation.start(7, { force: false })
    const { project: replaced } = await h.register({ repoRoot: at('/src/widgets') })
    expect(replaced).not.toBe(project)
    expect(replaced.ctx.generation.running()).toBe(7)
    expect(replaced.ctx.generation.status(7)).toMatchObject({ key: 7 })
    expect(await replaced.ctx.generation.cancel(7)).toBe(true)
    open()
    await vi.waitFor(() => expect(replaced.ctx.generation.status(7)?.phase).toBe('cancelled'))
    expect(replaced.ctx.generation.running()).toBeNull()
  })

  it('refuses another checkout the path of a busy project, and gives it the path once idle', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    const turn = chatTurn(project.ctx, 42)
    const refused = await h.register({ repoRoot: at('/elsewhere/widgets') }).catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(AppError)
    expect(refused).toMatchObject({
      code: 'BAD_REQUEST',
      status: 409,
      message: `acme/widgets serves ${at('/src/widgets')}, which has a chat turn or a generation running`,
      hint: 'try again when it ends',
    })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    // The refused checkout's clone had a part and a sweep made for it; neither outlives the refusal.
    expect(sweeps.map(sweep => nameOf(sweep.root.slice(0, sweep.root.indexOf('/.pr-review/'))))).toEqual([
      '/src/widgets',
      '/elsewhere/widgets',
    ])
    expect(liveSweeps()).toEqual(['/src/widgets'])
    open()
    await turn
    await h.register({ repoRoot: at('/elsewhere/widgets') })
    expect(logs).toContain(
      `acme/widgets now serves ${at('/elsewhere/widgets')}, in place of ${at('/src/widgets')}`
    )
    expect(await readRegistry(home)).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/elsewhere/widgets'),
        flags: { dataDir: at('/elsewhere/widgets/.pr-review') },
      },
    ])
    // The old clone has no served project left, so its sweep stops.
    expect(liveSweeps()).toEqual(['/elsewhere/widgets'])
  })

  it('serves a checkout that takes over the path while the saved one is still failing to build', async () => {
    await writeRegistry(home, [{ slug: 'acme/widgets', repoRoot: at('/src/moved'), flags: {} }])
    let fail = (): void => undefined
    waits.set(
      '/src/moved',
      new Promise(resolve => {
        fail = resolve
      })
    )
    const h = await startHub()
    const resolving = h.resolve('/r/acme/widgets/').catch((err: unknown) => err)
    const registering = h.register({ repoRoot: at('/src/widgets') })
    // The registration waits its turn behind the build of the saved project, which fails.
    await vi.waitFor(() => expect(loads).toEqual(['/src/moved']))
    fail()
    expect(await resolving).toBeInstanceOf(ConfigError)
    expect(await registering).toMatchObject({ project: { ctx: { config: { slug: 'acme/widgets' } } } })
    expect(loads).toEqual(['/src/moved', '/src/widgets'])
    expect(logs).toContain(`acme/widgets now serves ${at('/src/widgets')}, in place of ${at('/src/moved')}`)
  })

  it("logs its clone's checkout sweep under the repository's name", async () => {
    // A settings file that cannot be read skips the sweep, which says so.
    await mkdir(at('/src/widgets/.pr-review/settings.yml'), { recursive: true })
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets-b') })
    await vi.waitFor(() =>
      expect(logs).toContainEqual(expect.stringMatching(/^\[acme\/widgets\] review checkout sweep failed: /))
    )
  })

  it('answers nothing for a saved project removed while its first request waited its turn', async () => {
    await writeRegistry(home, [{ slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} }])
    const h = await startHub()
    const removing = h.remove('acme/widgets')
    const resolving = h.resolve('/r/acme/widgets/review/42')
    expect(await removing).toBe(true)
    expect(await resolving).toBeNull()
    expect(loads).toEqual([])
  })

  it('starts no sweep for a checkout whose build fails', async () => {
    const h = await startHub()
    const failed = await h
      .register({ repoRoot: at('/src/gadgets'), flags: { fixtureCanvas: at('/nope.json') } })
      .catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(ConfigError)
    expect(sweeps).toEqual([])
    expect(await h.projects()).toEqual([])
  })

  describe('worktrees of one clone', () => {
    it('share its data dir and one part, while another clone has its own', async () => {
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({ repoRoot: at('/src/widgets-b') })
      expect(worktree.ctx.config).toMatchObject({
        slug: 'acme/widgets~widgets-b',
        dataDir: at('/src/widgets/.pr-review'),
      })
      expect(worktree.ctx.clone).toBe(main.ctx.clone)
      expect(worktree.ctx.clone.checkouts).toBe(main.ctx.clone.checkouts)
      expect(worktree.ctx.checkouts.root).toBe(main.ctx.checkouts.root)
      const { project: gadgets } = await h.register({ repoRoot: at('/src/gadgets') })
      expect(gadgets.ctx.clone).not.toBe(main.ctx.clone)
      expect(liveSweeps()).toEqual(['/src/gadgets', '/src/widgets'])
    })

    it('refuse a chat turn on a review a sibling is chatting about, in the manager and through the route', async () => {
      const fixture = at('/review.json')
      await writeFile(fixture, JSON.stringify(syntheticArtifact()))
      adapters['/src/widgets-b'] = { git: gitFor42(), gh: ghFor42() }
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({
        repoRoot: at('/src/widgets-b'),
        flags: { fixtureCanvas: fixture },
      })
      const { project: other } = await h.register({ repoRoot: at('/src/gadgets') })
      const turn = chatTurn(main.ctx, 42)
      await expect(chatTurn(worktree.ctx, 42)).rejects.toBeInstanceOf(ChatBusyError)
      const refused = await askThroughRoute(worktree)
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as ErrorEnvelope).error).toMatchObject({
        code: 'CHAT_BUSY',
        hint: 'wait for it to finish, or stop it from the page that asked',
      })
      // Another review of the clone, and the same review in another clone, are free.
      const seven = chatTurn(worktree.ctx, 7)
      const elsewhere = chatTurn(other.ctx, 42)
      open()
      for (const events of [await turn, await seven, await elsewhere]) {
        expect(events.at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
      }
      expect((await chatTurn(worktree.ctx, 42)).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    })

    it('run one generation at a time across the clone, while another clone runs its own', async () => {
      adapters['/src/widgets-b'] = { git: gitFor42(), gh: ghFor42() }
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({ repoRoot: at('/src/widgets-b') })
      const { project: other } = await h.register({ repoRoot: at('/src/gadgets') })
      await main.ctx.generation.start(7, { force: false })
      const refused = await worktree.ctx.generation.start(42, { force: false }).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(GenerationBusyError)
      expect(refused).toMatchObject({ key: 7 })
      const res = await worktree.app.request('/api/prs/42/generate', {
        method: 'POST',
        headers: POST,
        body: '{"force":false}',
      })
      expect(res.status).toBe(409)
      expect(((await res.json()) as ErrorEnvelope).error).toEqual({
        code: 'GENERATION_BUSY',
        message: 'a canvas is already being generated for #7, and one runs at a time',
        hint: 'wait for it to finish, or stop it from the review page that started it',
      })
      await other.ctx.generation.start(42, { force: false })
      // A pull request's generation is every worktree's, so the sibling counts it as running too.
      expect([main, worktree, other].map(p => p.ctx.generation.running())).toEqual([7, 7, 42])
      open()
      await vi.waitFor(() => expect(main.ctx.generation.running()).toBeNull())
      await worktree.ctx.generation.start(42, { force: false })
      expect(worktree.ctx.generation.running()).toBe(42)
    })

    it("refuse a chat turn on a review whose checkout a sibling's generation holds, naming the generation", async () => {
      const fixture = at('/review.json')
      await writeFile(fixture, JSON.stringify(syntheticArtifact()))
      // The generation gets past prepare and holds the review checkout until the agent starts.
      adapters['/src/widgets'] = { git: gitFor42(), gh: ghFor42() }
      adapters['/src/widgets-b'] = { git: gitFor42(), gh: ghFor42() }
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({
        repoRoot: at('/src/widgets-b'),
        flags: { fixtureCanvas: fixture },
      })
      await main.ctx.generation.start(42, { force: false })
      await vi.waitFor(() => expect(main.ctx.generation.status(42)?.phase).toBe('checkout'))
      const refused = await askThroughRoute(worktree)
      expect(refused.status).toBe(409)
      expect(((await refused.json()) as ErrorEnvelope).error).toEqual({
        code: 'CHAT_BUSY',
        message: 'a canvas generation is using the review checkout of 42',
        hint: 'ask again once the canvas generation of this review ends, or stop it',
      })
    })

    it('share one checkout sweep per clone, which stops with the hub', async () => {
      const h = await startHub()
      await h.register({ repoRoot: at('/src/widgets') })
      await h.register({ repoRoot: at('/src/widgets-b') })
      await h.register({ repoRoot: at('/src/gadgets') })
      // Registering again keeps the sweep the clone already has.
      await h.register({ repoRoot: at('/src/widgets') })
      expect(sweeps).toHaveLength(2)
      expect(liveSweeps()).toEqual(['/src/gadgets', '/src/widgets'])
      h.close()
      h.close()
      expect(liveSweeps()).toEqual([])
    })
  })
})

describe('a saved project built again', () => {
  /** A saved entry: the server adds the data dir the project resolved to the flags it was given. */
  const widgets = (flags = {}) => ({
    slug: 'acme/widgets',
    repoRoot: at('/src/widgets'),
    flags: { dataDir: at('/src/widgets/.pr-review'), ...flags },
  })

  it('gets the flags it was registered with, after one restart and the next', async () => {
    const dataDir = at('/flag-data')
    const flags = { dataDir, chatAgent: 'codex', chatModel: 'o3' }
    const first = await startHub()
    const { project } = await first.register({ repoRoot: at('/src/widgets'), flags })
    expect(project.ctx.config).toMatchObject({
      dataDir,
      chatOverrides: { chatAgent: 'codex', chatModel: 'o3' },
    })
    await project.ctx.settings.write({ foldLevel: 'moderate' })
    first.close()

    for (let restart = 0; restart < 2; restart++) {
      const h = await startHub()
      expect(await h.projects()).toEqual([widgets(flags)])
      const restored = await servedAt(h, '/r/acme/widgets/review/42')
      expect(restored?.ctx.config).toMatchObject({
        dataDir,
        chatOverrides: { chatAgent: 'codex', chatModel: 'o3' },
      })
      // It reads and writes that data dir, not the checkout's own.
      expect(await restored?.ctx.settings.read()).toMatchObject({ foldLevel: 'moderate' })
      expect(await readRegistry(home)).toEqual([widgets(flags)])
      h.close()
    }
    await expect(stat(at('/src/widgets/.pr-review'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(loads).toEqual(['/src/widgets', '/src/widgets', '/src/widgets'])
  })

  it('gets the flags of its latest registration, which replace the ones before', async () => {
    const first = await startHub()
    await first.register({ repoRoot: at('/src/widgets'), flags: { dataDir: at('/flag-data') } })
    await first.register({ repoRoot: at('/src/widgets'), flags: { chatAgent: 'codex' } })
    first.close()
    const h = await startHub()
    const restored = await servedAt(h, '/r/acme/widgets/')
    expect(restored?.ctx.config).toMatchObject({
      dataDir: at('/src/widgets/.pr-review'),
      chatOverrides: { chatAgent: 'codex' },
    })
    // The move was said when it happened, since the canvases of the old data dir seem gone.
    expect(logs).toContain(
      `acme/widgets now reads ${at('/src/widgets/.pr-review')}, in place of ${at('/flag-data')}`
    )
  })

  it('keeps the data dir and host the shell gave it, which are saved; the environment itself is not', async () => {
    await git(at('/src/widgets'), 'remote', 'set-url', 'origin', 'git@git.company.com:acme/widgets.git')
    const shell = { PR_REVIEW_DATA_DIR: at('/shell-data'), PR_REVIEW_HOST: 'gitlab', GH_TOKEN: 'secret' }
    const savedText = () => readFile(path.join(home, 'projects.json'), 'utf8')
    const first = await startHub()
    const { project } = await first.register({ repoRoot: at('/src/widgets'), env: shell })
    expect(project.ctx.config).toMatchObject({ dataDir: at('/shell-data'), host: { kind: 'gitlab' } })
    first.close()
    const saved = [await savedText()]
    const h = await startHub()
    // Without the saved host, a company origin would not build at all (NO_ORIGIN); without the
    // saved data dir, new marks would go to the checkout's own, apart from the ones so far.
    expect((await servedAt(h, '/r/acme/widgets/'))?.ctx.config).toMatchObject({
      dataDir: at('/shell-data'),
      host: { kind: 'gitlab' },
    })
    saved.push(await savedText())
    await h.register({ repoRoot: at('/src/widgets'), env: shell })
    saved.push(await savedText())
    // The settings reach the file; the environment, and whether a project runs under it, never do.
    for (const text of saved) {
      expect(JSON.parse(text)).toEqual({
        projects: [widgets({ dataDir: at('/shell-data'), host: 'gitlab' })],
      })
      expect(text).not.toContain('secret')
    }
  })

  /** The folder the project's review page tells the reader to run `pr-review open` in, if any. */
  async function reopenIn(project: Project | null): Promise<unknown> {
    const page = await (await project?.app.request('/review/42', { headers: LOCAL }))?.text()
    const bootstrap = /<script id="bootstrap"[^>]*>(.*?)<\/script>/s.exec(page ?? '')?.[1]
    return (JSON.parse(bootstrap ?? 'null') as { reopenIn?: string } | null)?.reopenIn
  }

  it('runs without the shell environment until opened again, and says so once and on its pages', async () => {
    const first = await startHub()
    expect((await first.register({ repoRoot: at('/src/widgets'), env: process.env })).project.shellEnv).toBe(
      true
    )
    first.close()
    const h = await startHub()
    const restored = await servedAt(h, '/r/acme/widgets/')
    expect(restored?.shellEnv).toBe(false)
    expect(await servedAt(h, '/r/acme/widgets/review/42')).toBe(restored)
    expect(logs.filter(line => line.includes("server's environment"))).toEqual([
      `acme/widgets uses the server's environment since the restart; if your terminal sets a token or PATH only for it, run \`pr-review open\` in ${at('/src/widgets')}`,
    ])
    expect(await reopenIn(restored)).toBe(at('/src/widgets'))

    const { project } = await h.register({ repoRoot: at('/src/widgets'), env: process.env })
    expect(project.shellEnv).toBe(true)
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    expect(await reopenIn(project)).toBeUndefined()
  })

  it('is replaced while it runs a chat turn, which the project opened again sees through', async () => {
    const first = await startHub()
    await first.register({ repoRoot: at('/src/widgets'), env: process.env })
    first.close()
    const h = await startHub()
    const restored = await servedAt(h, '/r/acme/widgets/')
    if (restored === null) {
      throw new Error('not restored')
    }
    const turn = chatTurn(restored.ctx, 42)
    const { project: opened } = await h.register({ repoRoot: at('/src/widgets'), env: process.env })
    expect(opened).not.toBe(restored)
    expect(opened.shellEnv).toBe(true)
    expect(await reopenIn(opened)).toBeUndefined()
    expect(opened.ctx.chat.running()).toEqual([42])
    open()
    expect((await turn).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    expect(opened.ctx.chat.running()).toEqual([])
  })

  it('moves to the path its checkout answers under now, and its old path leaves the list', async () => {
    const first = await startHub()
    await first.register({ repoRoot: at('/src/widgets'), flags: { chatAgent: 'codex' } })
    first.close()
    await git(at('/src/widgets'), 'remote', 'set-url', 'origin', 'git@github.com:acme/renamed.git')
    const h = await startHub()
    expect(await h.resolve('/r/acme/widgets/review/42')).toEqual({
      kind: 'redirect',
      location: '/r/acme/renamed/review/42',
    })
    const renamed = {
      slug: 'acme/renamed',
      repoRoot: at('/src/widgets'),
      flags: { chatAgent: 'codex', dataDir: at('/src/widgets/.pr-review') },
    }
    expect(await h.projects()).toEqual([renamed])
    expect(await readRegistry(home)).toEqual([renamed])
    expect(await h.resolve('/r/acme/widgets/')).toBeNull()
    const served = await servedAt(h, '/r/acme/renamed/review/42')
    expect(served?.ctx.config).toMatchObject({ slug: 'acme/renamed', chatOverrides: { chatAgent: 'codex' } })
    expect(loads).toEqual(['/src/widgets', '/src/widgets'])
    expect(liveSweeps()).toEqual(['/src/widgets'])
  })

  it('sends its base path alone to the new base path', async () => {
    const first = await startHub()
    await first.register({ repoRoot: at('/src/widgets') })
    first.close()
    await git(at('/src/widgets'), 'remote', 'set-url', 'origin', 'git@github.com:acme/renamed.git')
    const h = await startHub()
    expect(await h.resolve('/r/acme/widgets/')).toEqual({ kind: 'redirect', location: '/r/acme/renamed/' })
  })

  it.each(['restore first', 'register first'])(
    'is served once when a restore and a registration race (%s), with one part and one sweep',
    async order => {
      const first = await startHub()
      await first.register({ repoRoot: at('/src/widgets') })
      first.close()
      expect(liveSweeps()).toEqual([])
      const h = await startHub()
      let restoring: Promise<unknown>
      let registering: Promise<Registered>
      if (order === 'restore first') {
        restoring = h.resolve('/r/acme/widgets/review/42')
        registering = h.register({ repoRoot: at('/src/widgets') })
      } else {
        registering = h.register({ repoRoot: at('/src/widgets') })
        restoring = h.resolve('/r/acme/widgets/review/42')
      }
      const [restored, registered] = await Promise.all([restoring, registering])
      expect(restored).toMatchObject({ kind: 'project', rest: '/review/42' })
      expect(await servedAt(h, '/r/acme/widgets/')).toBe(registered.project)
      expect(await h.projects()).toEqual([widgets()])
      const built = contexts.slice(1)
      expect(built).toHaveLength(order === 'restore first' ? 2 : 1)
      expect(new Set(built.map(ctx => ctx.clone)).size).toBe(1)
      expect(liveSweeps()).toEqual(['/src/widgets'])
      expect(await h.remove('acme/widgets')).toBe(true)
      expect(liveSweeps()).toEqual([])
    }
  )
})

describe('a project whose folder is gone', () => {
  const widgets = () => ({ slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} })
  const gadgets = () => ({ slug: 'acme/gadgets', repoRoot: at('/src/gadgets'), flags: {} })

  it('leaves the list when the hub starts, and the list is saved without it', async () => {
    // A path through a file stats as ENOTDIR; a missing folder as ENOENT.
    await writeFile(at('/a-file'), '')
    const throughFile = { slug: 'acme/file', repoRoot: at('/a-file/sub'), flags: {} }
    await rm(at('/src/gadgets'), { recursive: true })
    await writeRegistry(home, [widgets(), gadgets(), throughFile])
    const h = await startHub()
    expect(await h.projects()).toEqual([widgets()])
    expect(await readRegistry(home)).toEqual([widgets()])
    expect(logs).toEqual([
      `removed acme/gadgets: ${at('/src/gadgets')} no longer exists`,
      `removed acme/file: ${at('/a-file/sub')} no longer exists`,
    ])
    expect(await h.resolve('/r/acme/gadgets/')).toBeNull()
    expect(loads).toEqual([])
  })

  it('keeps a project whose folder cannot be read, and saves nothing when nothing left', async () => {
    const locked = at('/locked')
    await mkdir(path.join(locked, 'checkout'), { recursive: true })
    await chmod(locked, 0o000)
    try {
      const saved = [{ slug: 'acme/locked', repoRoot: path.join(locked, 'checkout'), flags: {} }]
      // Written by hand, so a rewrite of the list would show in its text.
      await mkdir(home, { recursive: true })
      const text = JSON.stringify({ projects: saved })
      await writeFile(path.join(home, 'projects.json'), text)
      const h = await startHub()
      expect(await h.projects()).toEqual(saved)
      expect(await readFile(path.join(home, 'projects.json'), 'utf8')).toBe(text)
      expect(logs).toEqual([])
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('leaves the list when the project list is read after it was deleted', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    await h.register({ repoRoot: at('/src/gadgets') })
    await rm(at('/src/gadgets'), { recursive: true })
    const registered = { ...widgets(), flags: { dataDir: at('/src/widgets/.pr-review') } }
    expect(await h.projects()).toEqual([registered])
    expect(await readRegistry(home)).toEqual([registered])
    expect(logs).toContain(`removed acme/gadgets: ${at('/src/gadgets')} no longer exists`)
    expect(await h.resolve('/r/acme/gadgets/')).toBeNull()
    expect(liveSweeps()).toEqual(['/src/widgets'])
    // Listing again finds nothing more to drop.
    expect(await h.projects()).toEqual([registered])
    expect(logs.filter(line => line.startsWith('removed'))).toHaveLength(1)
  })

  it('leaves the list on the first request of a saved project that was never built', async () => {
    await writeRegistry(home, [widgets(), gadgets()])
    const h = await startHub()
    await rm(at('/src/gadgets'), { recursive: true })
    expect(await h.resolve('/r/acme/gadgets/review/1')).toBeNull()
    expect(loads).toEqual([])
    expect(logs).toEqual([`removed acme/gadgets: ${at('/src/gadgets')} no longer exists`])
    expect(await readRegistry(home)).toEqual([widgets()])
    expect(await h.projects()).toEqual([widgets()])
  })

  it('stays while it runs a generation, and leaves once it is idle', async () => {
    const h = await startHub()
    const flags = { dataDir: at('/data') }
    const { project } = await h.register({ repoRoot: at('/src/widgets'), flags })
    await project.ctx.generation.start(7, { force: false })
    await rm(at('/src/widgets'), { recursive: true })
    expect(await h.projects()).toEqual([{ ...widgets(), flags }])
    // A built project keeps answering while it works, whatever happened to its folder.
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    expect(logs.some(line => line.startsWith('removed'))).toBe(false)
    open()
    await vi.waitFor(() => expect(project.ctx.generation.running()).toBeNull())
    expect(await h.projects()).toEqual([])
    expect(logs).toContain(`removed acme/widgets: ${at('/src/widgets')} no longer exists`)
    expect(await readRegistry(home)).toEqual([])
    expect(liveSweeps()).toEqual([])
  })

  it('stays while it runs a chat turn', async () => {
    const h = await startHub()
    // The turn writes its thread to the data dir, which is kept out of the folder deleted here.
    const flags = { dataDir: at('/data') }
    const { project } = await h.register({ repoRoot: at('/src/widgets'), flags })
    const turn = chatTurn(project.ctx, 42)
    await rm(at('/src/widgets'), { recursive: true })
    expect(await h.projects()).toEqual([{ ...widgets(), flags }])
    open()
    await turn
    expect(await h.projects()).toEqual([])
  })
})

describe('remove', () => {
  it('is false for a slug no project has', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    expect(await h.remove('acme/nope')).toBe(false)
    expect(await h.remove('/r/acme/widgets/')).toBe(false)
    expect(await h.projects()).toHaveLength(1)
    expect(logs.some(line => line.startsWith('removed'))).toBe(false)
  })

  it('takes a built project off the list, and saves the list', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    await h.register({ repoRoot: at('/src/widgets-b') })
    await h.register({ repoRoot: at('/src/gadgets') })
    expect(await h.remove('acme/widgets~widgets-b')).toBe(true)
    expect(logs.at(-1)).toBe('removed acme/widgets~widgets-b')
    expect(await h.resolve('/r/acme/widgets~widgets-b/')).toBeNull()
    expect((await h.projects()).map(p => p.slug)).toEqual(['acme/widgets', 'acme/gadgets'])
    expect((await readRegistry(home)).map(p => p.slug)).toEqual(['acme/widgets', 'acme/gadgets'])
    // Its folder stays: removing takes the project off the list only.
    expect((await stat(at('/src/widgets-b'))).isDirectory()).toBe(true)
  })

  it('takes a saved project that was never built off the list', async () => {
    const widgets = { slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} }
    await writeRegistry(home, [widgets, { slug: 'acme/gadgets', repoRoot: at('/src/gadgets'), flags: {} }])
    const h = await startHub()
    expect(await h.remove('acme/gadgets')).toBe(true)
    expect(await readRegistry(home)).toEqual([widgets])
    expect(loads).toEqual([])
    expect(logs).toEqual(['removed acme/gadgets'])
  })

  it('waits for a build in flight, and removes the project once that build fails', async () => {
    await writeRegistry(home, [{ slug: 'acme/widgets', repoRoot: at('/src/moved'), flags: {} }])
    let fail = (): void => undefined
    waits.set(
      '/src/moved',
      new Promise(resolve => {
        fail = resolve
      })
    )
    const h = await startHub()
    const resolving = h.resolve('/r/acme/widgets/').catch((err: unknown) => err)
    await vi.waitFor(() => expect(loads).toEqual(['/src/moved']))
    const removing = h.remove('acme/widgets')
    fail()
    expect(await resolving).toBeInstanceOf(ConfigError)
    expect(await removing).toBe(true)
    expect(await h.projects()).toEqual([])
    expect(await h.resolve('/r/acme/widgets/')).toBeNull()
  })

  it('refuses a project that runs a chat turn or a generation, and keeps it', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await project.ctx.generation.start(7, { force: false })
    const refused = await h.remove('acme/widgets').catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(AppError)
    expect(refused).toMatchObject({
      code: 'BAD_REQUEST',
      status: 409,
      message: 'acme/widgets has a chat turn or a generation running',
      hint: 'remove it once that ends',
    })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    expect(await readRegistry(home)).toEqual([
      {
        slug: 'acme/widgets',
        repoRoot: at('/src/widgets'),
        flags: { dataDir: at('/src/widgets/.pr-review') },
      },
    ])
    expect(liveSweeps()).toEqual(['/src/widgets'])
    open()
    await vi.waitFor(() => expect(project.ctx.generation.running()).toBeNull())
    expect(await h.remove('acme/widgets')).toBe(true)
    expect(liveSweeps()).toEqual([])
  })

  it('waits for a registration in flight, so it removes what that registered', async () => {
    const h = await startHub()
    const [registered, removed] = await Promise.all([
      h.register({ repoRoot: at('/src/widgets') }),
      h.remove('acme/widgets'),
    ])
    expect(registered.project.ctx.config.slug).toBe('acme/widgets')
    expect(removed).toBe(true)
    expect(await h.projects()).toEqual([])
    expect(await readRegistry(home)).toEqual([])
    expect(liveSweeps()).toEqual([])
  })

  it("stops the clone's sweep with its last project, and keeps it while a sibling is served", async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    await h.register({ repoRoot: at('/src/widgets-b') })
    await h.register({ repoRoot: at('/src/gadgets') })
    expect(liveSweeps()).toEqual(['/src/gadgets', '/src/widgets'])
    expect(await h.remove('acme/widgets')).toBe(true)
    // The worktree left still uses the clone's part, so its sweep goes on.
    expect(liveSweeps()).toEqual(['/src/gadgets', '/src/widgets'])
    expect(await h.remove('acme/gadgets')).toBe(true)
    expect(liveSweeps()).toEqual(['/src/widgets'])
    expect(await h.remove('acme/widgets~widgets-b')).toBe(true)
    expect(liveSweeps()).toEqual([])
    expect(sweeps).toHaveLength(2)
  })
})
