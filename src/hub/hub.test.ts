// @vitest-environment node
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ChatBusyError } from '../chat/chat-manager.js'
import type { ChatEvent } from '../contract/chat.js'
import type { ReviewKey } from '../contract/review-key.js'
import { DEFAULT_SETTINGS } from '../contract/settings.js'
import { GenerationBusyError } from '../generate/generation-manager.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import {
  createFakeGh,
  createFakeGit,
  makeTempDir,
  makeTestContext,
  type TestContext,
  type TestContextOptions,
} from '../testing/fakes.js'
import { HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import { readRegistry, writeRegistry } from './home.js'
import { createHub, type Hub, type LoadProject, type Project, type ProjectHooks, projectName } from './hub.js'

/** The checkouts the test loader knows, and the clone whose data dir each one uses. */
const CHECKOUTS: Record<string, { basePath: string; clone: string }> = {
  '/src/widgets': { basePath: '/r/acme/widgets/', clone: 'widgets' },
  '/src/widgets-b': { basePath: '/r/acme/widgets~widgets-b/', clone: 'widgets' },
  // Another clone whose main checkout has the same slug.
  '/elsewhere/widgets': { basePath: '/r/acme/widgets/', clone: 'widgets-elsewhere' },
  '/src/gadgets': { basePath: '/r/acme/gadgets/', clone: 'gadgets' },
  '/src/group': { basePath: '/r/group/proj/', clone: 'group' },
  '/src/subgroup': { basePath: '/r/group/proj/sub/', clone: 'subgroup' },
}

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
let hub: Hub | null
let contexts: TestContext[]
let loads: string[]
let hooksOf: Map<string, ProjectHooks>
let logs: string[]
let swept: string[]
let gate: Promise<void>
let open: () => void
/** Per checkout: context options, and a promise the load waits for before it goes on. */
let extra: Record<string, TestContextOptions & { fixtureCanvasPath?: string }>
let waits: Map<string, Promise<void>>

/**
 * A checkout's real folder under the test's temp root: the hub drops a saved project whose folder
 * is gone, so every checkout the tests use exists. The loader names them by `name`.
 */
function at(name: string): string {
  return path.join(root, name)
}

const load: LoadProject = async (registration, hooks) => {
  const { repoRoot } = registration
  const name = `/${path.relative(root, repoRoot)}`
  loads.push(name)
  hooksOf.set(name, hooks)
  hooks.log(`loading ${name}`)
  await waits.get(name)
  const checkout = CHECKOUTS[name]
  if (checkout === undefined) {
    throw new Error(`${name} is not a git checkout`)
  }
  const { fixtureCanvasPath, ...options } = extra[name] ?? {}
  const t = await makeTestContext({
    basePath: checkout.basePath,
    chatBusyElsewhere: hooks.chatBusyElsewhere,
    runner: createFakeRunner({ ensureGate: gate }),
    git: held(createFakeGit(), gate),
    gh: held(createFakeGh(), gate),
    ...options,
  })
  t.ctx.config.repoRoot = repoRoot
  t.ctx.config.dataDir = path.join(root, checkout.clone)
  t.ctx.config.fixtureCanvasPath = fixtureCanvasPath ?? null
  t.ctx.log = hooks.log
  const sweep = t.ctx.checkouts.sweep
  t.ctx.checkouts.sweep = opts => {
    swept.push(name)
    return sweep(opts)
  }
  contexts.push(t)
  return t.ctx
}

async function servedAt(h: Hub, pathname: string): Promise<Project | null> {
  const resolved = await h.resolve(pathname)
  return resolved?.kind === 'project' ? resolved.project : null
}

async function startHub(): Promise<Hub> {
  hub = await createHub({ home, load, log: line => logs.push(line) })
  return hub
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
  root = await makeTempDir('pr-review-hub-')
  home = path.join(root, 'home')
  hub = null
  contexts = []
  loads = []
  hooksOf = new Map()
  logs = []
  swept = []
  extra = {}
  waits = new Map()
  gate = new Promise(resolve => {
    open = resolve
  })
  for (const name of [...Object.keys(CHECKOUTS), '/src/moved']) {
    await mkdir(at(name), { recursive: true })
  }
})

afterEach(async () => {
  vi.useRealTimers()
  open()
  if (hub !== null) {
    const h = hub
    await vi.waitFor(() => expect(h.running()).toEqual([]))
    h.close()
  }
  for (const t of contexts) {
    await t.cleanup()
  }
  await rm(root, { recursive: true, force: true })
})

describe('projectName', () => {
  it('reads the slug back from a base path', () => {
    expect(projectName('/r/acme/widgets/')).toBe('acme/widgets')
    expect(projectName('/r/acme/widgets~feature-x/')).toBe('acme/widgets~feature-x')
    expect(projectName('/r/acme/my%20widgets/')).toBe('acme/my widgets')
  })
})

describe('createHub', () => {
  it('serves a registered checkout under its base path and saves it', async () => {
    const h = await startHub()
    const { project, kept } = await h.register({ repoRoot: at('/src/widgets') })
    expect(kept).toBe(false)
    expect(project.name).toBe('acme/widgets')
    expect(await h.resolve('/r/acme/widgets/review/42')).toEqual({
      kind: 'project',
      project,
      rest: '/review/42',
    })
    expect(await h.resolve('/r/acme/widgets/')).toMatchObject({ rest: '/' })
    expect(await h.projects()).toEqual([{ basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') }])
    expect(await readRegistry(home)).toEqual(await h.projects())
  })

  it('redirects a base path without its trailing slash, and knows no other path', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    expect(await h.resolve('/r/acme/widgets')).toEqual({ kind: 'redirect', location: '/r/acme/widgets/' })
    expect(await h.resolve('/r/acme/widget/')).toBeNull()
    expect(await h.resolve('/r/acme/widgetsx/')).toBeNull()
    expect(await h.resolve('/')).toBeNull()
  })

  it('sends a path to the longest base it falls under, whatever the order they were saved in', async () => {
    const group = { basePath: '/r/group/proj/', repoRoot: at('/src/group') }
    const subgroup = { basePath: '/r/group/proj/sub/', repoRoot: at('/src/subgroup') }
    for (const saved of [
      [group, subgroup],
      [subgroup, group],
    ]) {
      await writeRegistry(home, saved)
      const h = await startHub()
      expect(await h.resolve('/r/group/proj/sub/review/1')).toMatchObject({
        project: { name: 'group/proj/sub' },
        rest: '/review/1',
      })
      expect(await h.resolve('/r/group/proj/review/1')).toMatchObject({
        project: { name: 'group/proj' },
        rest: '/review/1',
      })
      h.close()
    }
  })

  it('builds a saved project on its first request, once, and lists it before that', async () => {
    await writeRegistry(home, [{ basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') }])
    const h = await startHub()
    expect(await h.projects()).toEqual([{ basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') }])
    expect(loads).toEqual([])
    const [a, b] = await Promise.all([h.resolve('/r/acme/widgets/'), h.resolve('/r/acme/widgets/api/health')])
    expect(a).toMatchObject({ kind: 'project', rest: '/' })
    expect(b).toMatchObject({ kind: 'project', rest: '/api/health' })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(await servedAt(h, '/r/acme/widgets/api/health'))
    await h.resolve('/r/acme/widgets/')
    expect(loads).toEqual(['/src/widgets'])
  })

  it('tries a saved project again on the next request after its build failed', async () => {
    await writeRegistry(home, [{ basePath: '/r/acme/widgets/', repoRoot: at('/src/moved') }])
    const h = await startHub()
    await expect(h.resolve('/r/acme/widgets/')).rejects.toThrow('/src/moved is not a git checkout')
    await expect(h.resolve('/r/acme/widgets/')).rejects.toThrow('/src/moved is not a git checkout')
    expect(loads).toEqual(['/src/moved', '/src/moved'])
  })

  it('names the project in the log lines of its context, and logs where it serves from', async () => {
    extra['/src/widgets'] = {
      fixtureArtifact: syntheticArtifact(),
      projectConfig: {
        config: DEFAULT_PROJECT_CONFIG,
        warnings: ['chat.enabled is not a boolean'],
        source: null,
      },
    }
    extra['/src/gadgets'] = {
      fixtureArtifact: syntheticArtifact(),
      fixtureCanvasPath: '/fixtures/review.json',
    }
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await h.register({ repoRoot: at('/src/gadgets') })
    project.ctx.log('hello')
    expect(logs).toEqual([
      'loading /src/widgets',
      `[acme/widgets] ${at('/src/widgets')} · data dir ${path.join(root, 'widgets')}`,
      '[acme/widgets] fixture canvas  (dev only): every PR reports ready',
      '[acme/widgets] warning: chat.enabled is not a boolean',
      'loading /src/gadgets',
      `[acme/gadgets] ${at('/src/gadgets')} · data dir ${path.join(root, 'gadgets')}`,
      '[acme/gadgets] fixture canvas /fixtures/review.json (dev only): every PR reports ready',
      '[acme/widgets] hello',
    ])
  })

  it('replaces an idle project when its checkout registers again', async () => {
    const h = await startHub()
    const first = await h.register({ repoRoot: at('/src/widgets'), env: { A: '1' } })
    const second = await h.register({ repoRoot: at('/src/widgets'), env: { A: '2' } })
    expect(second.kept).toBe(false)
    expect(second.project).not.toBe(first.project)
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(second.project)
    expect(logs.some(line => line.includes('now serves'))).toBe(false)
  })

  it('keeps a project that is running a chat turn when its checkout registers again', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    const turn = chatTurn(project.ctx, 42)
    expect(await h.register({ repoRoot: at('/src/widgets') })).toEqual({ project, kept: true })
    expect(h.running()).toEqual(['acme/widgets: a chat turn on #42'])
    open()
    expect((await turn).at(-1)).toEqual({ event: 'done', stopReason: 'end_turn' })
    expect(await h.register({ repoRoot: at('/src/widgets') })).toMatchObject({ kept: false })
  })

  it('keeps a project that is generating a canvas when its checkout registers again', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await project.generation.start(7, { force: false })
    expect(await h.register({ repoRoot: at('/src/widgets') })).toEqual({ project, kept: true })
    expect(h.running()).toEqual(['acme/widgets: generating a canvas for #7'])
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
      message: `/r/acme/widgets/ serves ${at('/src/widgets')}, which has a chat turn or a generation running`,
      hint: 'try again when it ends, or rename one of the two worktree folders',
    })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    open()
    await turn
    const moved = await h.register({ repoRoot: at('/elsewhere/widgets') })
    expect(moved.kept).toBe(false)
    expect(logs).toContain(
      `acme/widgets now serves ${at('/elsewhere/widgets')}, in place of ${at('/src/widgets')}`
    )
    expect(await readRegistry(home)).toEqual([
      { basePath: '/r/acme/widgets/', repoRoot: at('/elsewhere/widgets') },
    ])
  })

  it('serves a checkout that takes over the path while the saved one is still failing to build', async () => {
    await writeRegistry(home, [{ basePath: '/r/acme/widgets/', repoRoot: at('/src/moved') }])
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
    // The new context is built; the register now waits on the old build, which fails.
    await vi.waitFor(() => expect(contexts).toHaveLength(1))
    fail()
    expect(await resolving).toBeInstanceOf(Error)
    expect(await registering).toMatchObject({ kept: false, project: { name: 'acme/widgets' } })
    expect(logs).toContain(`acme/widgets now serves ${at('/src/widgets')}, in place of ${at('/src/moved')}`)
  })

  describe('worktrees of one clone', () => {
    it('refuse a chat turn on a review a sibling is chatting about', async () => {
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({ repoRoot: at('/src/widgets-b') })
      await h.register({ repoRoot: at('/src/gadgets') })
      const turn = chatTurn(main.ctx, 42)
      await expect(chatTurn(worktree.ctx, 42)).rejects.toBeInstanceOf(ChatBusyError)
      expect(hooksOf.get('/src/widgets-b')?.chatBusyElsewhere(42)).toBe(true)
      expect(hooksOf.get('/src/widgets-b')?.chatBusyElsewhere(7)).toBe(false)
      expect(hooksOf.get('/src/widgets')?.chatBusyElsewhere(42)).toBe(false)
      expect(hooksOf.get('/src/gadgets')?.chatBusyElsewhere(42)).toBe(false)
      open()
      await turn
      expect(hooksOf.get('/src/widgets-b')?.chatBusyElsewhere(42)).toBe(false)
    })

    it('run one generation at a time across the clone, while another clone runs its own', async () => {
      const h = await startHub()
      const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
      const { project: worktree } = await h.register({ repoRoot: at('/src/widgets-b') })
      const { project: other } = await h.register({ repoRoot: at('/src/gadgets') })
      await worktree.generation.start(7, { force: false })
      const refused = await main.generation.start(42, { force: false }).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(GenerationBusyError)
      expect(refused).toMatchObject({ key: 7 })
      await other.generation.start(42, { force: false })
      expect(h.running()).toEqual([
        'acme/widgets~widgets-b: generating a canvas for #7',
        'acme/gadgets: generating a canvas for #42',
      ])
    })

    it('share one checkout sweep, which stops with the hub', async () => {
      const h = await startHub()
      await h.register({ repoRoot: at('/src/widgets') })
      await h.register({ repoRoot: at('/src/widgets-b') })
      await h.register({ repoRoot: at('/src/gadgets') })
      // Re-registering keeps the sweep the clone already has.
      await h.register({ repoRoot: at('/src/widgets') })
      await vi.waitFor(() => expect(swept).toContain('/src/gadgets'))
      expect(swept.sort()).toEqual(['/src/gadgets', '/src/widgets'])
      h.close()
      h.close()
    })
  })
})

describe('a project whose folder is gone', () => {
  const widgets = (): { basePath: string; repoRoot: string } => ({
    basePath: '/r/acme/widgets/',
    repoRoot: at('/src/widgets'),
  })
  const gadgets = (): { basePath: string; repoRoot: string } => ({
    basePath: '/r/acme/gadgets/',
    repoRoot: at('/src/gadgets'),
  })

  it('leaves the list when the hub starts, and the list is saved without it', async () => {
    // A path through a file stats as ENOTDIR; a missing folder as ENOENT.
    await writeFile(at('/a-file'), '')
    const throughFile = { basePath: '/r/acme/file/', repoRoot: at('/a-file/sub') }
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
      const saved = [{ basePath: '/r/acme/locked/', repoRoot: path.join(locked, 'checkout') }]
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
    expect(await h.projects()).toEqual([widgets()])
    expect(await readRegistry(home)).toEqual([widgets()])
    expect(logs).toContain(`removed acme/gadgets: ${at('/src/gadgets')} no longer exists`)
    expect(await h.resolve('/r/acme/gadgets/')).toBeNull()
    // Listing again finds nothing more to drop.
    expect(await h.projects()).toEqual([widgets()])
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
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await project.generation.start(7, { force: false })
    await rm(at('/src/widgets'), { recursive: true })
    expect(await h.projects()).toEqual([widgets()])
    // A built project keeps answering while it works, whatever happened to its folder.
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    expect(logs.some(line => line.startsWith('removed'))).toBe(false)
    open()
    await vi.waitFor(() => expect(project.generation.running()).toBeNull())
    expect(await h.projects()).toEqual([])
    expect(logs).toContain(`removed acme/widgets: ${at('/src/widgets')} no longer exists`)
    expect(await readRegistry(home)).toEqual([])
  })

  it('stays while it runs a chat turn', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    const turn = chatTurn(project.ctx, 42)
    await rm(at('/src/widgets'), { recursive: true })
    expect(await h.projects()).toEqual([widgets()])
    open()
    await turn
    expect(await h.projects()).toEqual([])
  })
})

describe('remove', () => {
  it('is false for a path no project is served at', async () => {
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    expect(await h.remove('/r/acme/nope/')).toBe(false)
    expect(await h.projects()).toHaveLength(1)
    expect(logs.some(line => line.startsWith('removed'))).toBe(false)
  })

  it('takes a built project off the list and out of the sibling checks, and saves the list', async () => {
    const h = await startHub()
    const { project: main } = await h.register({ repoRoot: at('/src/widgets') })
    const { project: worktree } = await h.register({ repoRoot: at('/src/widgets-b') })
    await h.register({ repoRoot: at('/src/gadgets') })
    expect(await h.remove('/r/acme/widgets~widgets-b/')).toBe(true)
    expect(logs.at(-1)).toBe('removed acme/widgets~widgets-b')
    expect(await h.resolve('/r/acme/widgets~widgets-b/')).toBeNull()
    expect((await h.projects()).map(p => p.basePath)).toEqual(['/r/acme/widgets/', '/r/acme/gadgets/'])
    expect((await readRegistry(home)).map(p => p.basePath)).toEqual(['/r/acme/widgets/', '/r/acme/gadgets/'])
    // Its folder stays: removing takes the project off the list only.
    expect((await stat(at('/src/widgets-b'))).isDirectory()).toBe(true)
    // A generation the removed project still runs no longer holds back its old sibling.
    await worktree.generation.start(7, { force: false })
    await main.generation.start(42, { force: false })
    expect(h.running()).toEqual(['acme/widgets: generating a canvas for #42'])
    open()
    await vi.waitFor(() =>
      expect([worktree.generation.running(), main.generation.running()]).toEqual([null, null])
    )
  })

  it('takes a saved project that was never built off the list', async () => {
    await writeRegistry(home, [
      { basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') },
      { basePath: '/r/acme/gadgets/', repoRoot: at('/src/gadgets') },
    ])
    const h = await startHub()
    expect(await h.remove('/r/acme/gadgets/')).toBe(true)
    expect(await readRegistry(home)).toEqual([{ basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') }])
    expect(loads).toEqual([])
    expect(logs).toEqual(['removed acme/gadgets'])
  })

  it('waits for a build in flight, and removes the project once that build fails', async () => {
    await writeRegistry(home, [{ basePath: '/r/acme/widgets/', repoRoot: at('/src/moved') }])
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
    const removing = h.remove('/r/acme/widgets/')
    fail()
    expect(await resolving).toBeInstanceOf(Error)
    expect(await removing).toBe(true)
    expect(await h.projects()).toEqual([])
    expect(await h.resolve('/r/acme/widgets/')).toBeNull()
  })

  it('refuses a project that runs a chat turn or a generation, and keeps it', async () => {
    const h = await startHub()
    const { project } = await h.register({ repoRoot: at('/src/widgets') })
    await project.generation.start(7, { force: false })
    const refused = await h.remove('/r/acme/widgets/').catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(AppError)
    expect(refused).toMatchObject({
      code: 'BAD_REQUEST',
      status: 409,
      message: 'acme/widgets has a chat turn or a generation running',
      hint: 'remove it once that ends',
    })
    expect(await servedAt(h, '/r/acme/widgets/')).toBe(project)
    expect(await readRegistry(home)).toEqual([{ basePath: '/r/acme/widgets/', repoRoot: at('/src/widgets') }])
    open()
    await vi.waitFor(() => expect(project.generation.running()).toBeNull())
    expect(await h.remove('/r/acme/widgets/')).toBe(true)
  })

  it('waits for a registration in flight, so it removes what that registered', async () => {
    const h = await startHub()
    const [registered, removed] = await Promise.all([
      h.register({ repoRoot: at('/src/widgets') }),
      h.remove('/r/acme/widgets/'),
    ])
    expect(registered.kept).toBe(false)
    expect(removed).toBe(true)
    expect(await h.projects()).toEqual([])
    expect(await readRegistry(home)).toEqual([])
  })

  it("stops the clone's sweep with its last project, and keeps it while a sibling is served", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    open()
    const h = await startHub()
    await h.register({ repoRoot: at('/src/widgets') })
    await h.register({ repoRoot: at('/src/widgets-b') })
    await h.register({ repoRoot: at('/src/gadgets') })
    // One sweep per clone, each waiting for its next run.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(2))
    expect(await h.remove('/r/acme/widgets/')).toBe(true)
    expect(vi.getTimerCount()).toBe(2)
    expect(await h.remove('/r/acme/gadgets/')).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    swept = []
    await vi.advanceTimersByTimeAsync(DEFAULT_SETTINGS.checkoutSweepMinutes * 60 * 1000)
    // The clone's sweep still runs for the worktree left; the other clone's runs no more.
    await vi.waitFor(() => expect(swept).toEqual(['/src/widgets']))
    expect(await h.remove('/r/acme/widgets~widgets-b/')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
