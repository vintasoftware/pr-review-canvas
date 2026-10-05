// @vitest-environment node
import { mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Hono } from 'hono'
import { execGit, GitError } from '../git/git.js'
import { loadContext } from '../load-context.js'
import { type AppContext, STATIC_DIR } from '../server/context.js'
import type { AppEnv } from '../server/env.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import { createFakeGh, createFakeGit, makeTempDir } from '../testing/fakes.js'
import { readAppearance, readRegistry, type RegistryEntry, writeAppearance, writeRegistry } from './home.js'
import { createHub, type Hub, type ProjectRegistration } from './hub.js'
import { createHubApp, shortPath } from './hub-app.js'
import { groupProjects } from '../server/html.js'

const LOCAL = { host: 'localhost:3010' }
const TOKEN = 'secret-token'
const AUTH = { ...LOCAL, authorization: `Bearer ${TOKEN}` }
const POST = { ...AUTH, 'content-type': 'application/json' }
/** What the project list's own scripts send: same origin, no token. */
const PAGE = { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' }

/** Every call waits for `gate`, so a generation stays running until the test opens it. */
function held<T extends object>(target: T, gate: Promise<void>): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value: unknown = Reflect.get(obj, prop)
      return typeof value === 'function'
        ? async (...args: unknown[]) => {
            await gate
            return (value as (...a: unknown[]) => unknown).apply(obj, args)
          }
        : value
    },
  })
}

let root: string
let home: string
let hub: Hub
let app: Hono<AppEnv>
let contexts: AppContext[]
let registrations: ProjectRegistration[]
let logs: string[]
let failure: unknown
let open: () => void
let gate: Promise<void>

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/**
 * A checkout's real folder under the test's temp root: the hub drops a saved project whose folder
 * is gone. The loader names them by `name`.
 */
function at(name: string): string {
  return path.join(root, name)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execGit(cwd, args)
  if (r.code !== 0) {
    throw new GitError(args, r.stderr, r.code)
  }
  return r.stdout.toString('utf8').trim()
}

/** A real clone at `name` whose origin is `origin`: the config the hub serves it under comes from git. */
async function makeClone(name: string, origin: string): Promise<void> {
  await mkdir(at(name), { recursive: true })
  await git(at(name), 'init', '-q', '-b', 'main')
  await git(at(name), 'remote', 'add', 'origin', origin)
}

async function start(saved: RegistryEntry[] = []): Promise<void> {
  await writeRegistry(home, saved)
  hub = await createHub({
    home,
    log: () => undefined,
    // The checkout's context as `serve` builds it, through the real loader; the forge and the git
    // a request runs are held fakes, so a generation stays running until the test opens the gate.
    load: async (registration, hooks) => {
      registrations.push(registration)
      if (failure !== undefined) {
        throw failure
      }
      const ctx = await loadContext({
        repoDir: registration.repoRoot,
        cwd: registration.repoRoot,
        env: registration.env,
        flags: registration.flags,
        port: 3010,
        log: hooks.log,
        cloneOf: hooks.cloneOf,
        adapters: {
          git: held(createFakeGit(), gate),
          gh: held(createFakeGh(), gate),
          runner: createFakeRunner(),
        },
      })
      contexts.push(ctx)
      return ctx
    },
  })
  app = createHubApp({
    hub,
    home,
    token: TOKEN,
    version: '1.2.3',
    port: () => 3010,
    staticDir: STATIC_DIR,
    vendorRoots: {
      diff: '/nonexistent/diff',
      marked: '/nonexistent/marked.js',
      dompurify: '/nonexistent/purify.js',
      hljs: '/nonexistent/hljs.js',
      mermaid: '/nonexistent/mermaid',
    },
    log: line => logs.push(line),
  })
}

const removeProject = (body: unknown, headers: Record<string, string> = PAGE) =>
  app.request('/api/projects/remove', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const putAppearance = (body: unknown, headers: Record<string, string> = PAGE) =>
  app.request('/api/appearance', {
    method: 'PUT',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const register = (body: unknown, headers: Record<string, string> = POST) =>
  app.request('/api/hub/projects', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

beforeEach(async () => {
  root = await realpath(await makeTempDir('pr-review-hub-app-'))
  home = path.join(root, 'home')
  await makeClone('/src/widgets', 'git@github.com:acme/widgets.git')
  // Another clone of the same repository, whose main checkout has the same name.
  await makeClone('/elsewhere/widgets', 'git@github.com:acme/widgets.git')
  // A saved worktree the tests list but never build.
  await mkdir(at('/src/gadgets-feature'), { recursive: true })
  contexts = []
  registrations = []
  logs = []
  failure = undefined
  gate = new Promise(resolve => {
    open = resolve
  })
})

afterEach(async () => {
  open()
  for (const ctx of contexts) {
    await vi.waitFor(() => expect(ctx.generation.running()).toBeNull())
  }
  hub.close()
  await rm(root, { recursive: true, force: true })
})

describe('createHubApp', () => {
  describe('project paths', () => {
    beforeEach(async () => {
      await start([{ slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} }])
    })

    it("serves a project's pages with the prefix taken off and its links under the prefix", async () => {
      const res = await app.request('/r/acme/widgets/', { headers: LOCAL })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('<h1>acme/widgets</h1>')
      expect(html).toContain('action="/r/acme/widgets/review"')
      const health = await app.request('/r/acme/widgets/api/nope', { headers: LOCAL })
      expect(health.status).toBe(404)
      expect(await json(health)).toEqual({
        error: { code: 'NOT_FOUND', message: 'no route for GET /api/nope' },
      })
    })

    it("keeps the project page's own policy, whose nonce is the one on the page", async () => {
      const res = await app.request('/r/acme/widgets/review/42', { headers: LOCAL })
      const policy = res.headers.get('content-security-policy') ?? ''
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1]
      expect(nonce).toBeDefined()
      const html = await res.text()
      expect(html).toContain(`nonce="${nonce ?? ''}"`)
      expect([...html.matchAll(/nonce="([^"]+)"/g)].every(m => m[1] === nonce)).toBe(true)
    })

    it('passes the query string and a request body on to the project', async () => {
      const redirect = await app.request('/r/acme/widgets/review?n=42&generate=1', { headers: LOCAL })
      expect(redirect.status).toBe(303)
      expect(redirect.headers.get('location')).toBe('/r/acme/widgets/review/42?generate=1')
      const saved = await app.request('/r/acme/widgets/api/appearance', {
        method: 'PUT',
        headers: { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' }),
      })
      expect(saved.status).toBe(200)
      expect(await json(saved)).toEqual({ skin: 'github', theme: 'dark' })
      expect(await contexts[0]?.settings.read()).toMatchObject({ theme: 'dark' })
    })

    it('redirects a project path without its trailing slash, keeping the query', async () => {
      const res = await app.request('/r/acme/widgets?theme=dark', { headers: LOCAL })
      expect(res.status).toBe(308)
      expect(res.headers.get('location')).toBe('/r/acme/widgets/?theme=dark')
    })

    it('refuses a Host that is not loopback before building the project', async () => {
      const res = await app.request('/r/acme/widgets/', { headers: { host: 'evil.example' } })
      expect(res.status).toBe(403)
      expect(await res.text()).toContain('FORBIDDEN_HOST')
      expect(res.headers.get('content-security-policy')).toMatch(/nonce-/)
      expect(registrations).toEqual([])
    })

    it('answers 404 with a hint for a path no project is served at', async () => {
      const res = await app.request('/r/acme/nope/', { headers: LOCAL })
      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).toContain('no project is served at /r/acme/nope/')
      expect(html).toContain('to add it')
      expect(registrations).toEqual([])
    })

    it('answers 404 with a hint when the project cannot be built', async () => {
      await rm(at('/src/widgets/.git'), { recursive: true })
      const notRepo = await (await app.request('/r/acme/widgets/', { headers: LOCAL })).text()
      expect(notRepo).toContain('could not open this project: not inside a git repository')
      failure = new Error('/src/widgets is gone')
      const res = await app.request('/r/acme/widgets/', { headers: LOCAL })
      expect(res.status).toBe(404)
      const html = await res.text()
      expect(html).toContain('could not open this project: /src/widgets is gone')
      expect(html).toContain('pr-review open')
      failure = 'not an error'
      expect(await (await app.request('/r/acme/widgets/', { headers: LOCAL })).text()).toContain(
        'could not open this project: not an error'
      )
    })
  })

  describe('/api/hub', () => {
    beforeEach(async () => {
      await start()
    })

    it('tells a command holding the token which server it is talking to', async () => {
      const res = await app.request('/api/hub', { headers: AUTH })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await json(res)).toEqual({ version: '1.2.3', pid: process.pid, port: 3010 })
    })

    it('refuses a missing or wrong token', async () => {
      for (const authorization of [undefined, 'Bearer nope', `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
        const headers = authorization === undefined ? LOCAL : { ...LOCAL, authorization }
        const res = await app.request('/api/hub', { headers })
        expect([authorization, res.status]).toEqual([authorization, 403])
        expect(await json(res)).toEqual({
          error: { code: 'SERVER_TOKEN_INVALID', message: 'this call needs the token in server.json' },
        })
      }
      const unregistered = await register(
        { repoRoot: at('/src/widgets') },
        { ...LOCAL, 'content-type': 'application/json' }
      )
      expect(unregistered.status).toBe(403)
      expect(registrations).toEqual([])
    })

    it('refuses a Host that is not loopback even with the token', async () => {
      const res = await app.request('/api/hub', { headers: { ...AUTH, host: 'evil.example' } })
      expect(res.status).toBe(403)
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe('FORBIDDEN_HOST')
    })

    it('registers a checkout with its environment and flags, and serves it', async () => {
      const env = { GH_TOKEN: 'from-shell' }
      const flags = { chatAgent: 'codex', dataDir: at('/data') }
      const res = await register({ repoRoot: at('/src/widgets'), env, flags })
      expect(res.status).toBe(200)
      expect(await json(res)).toEqual({ slug: 'acme/widgets', basePath: '/r/acme/widgets/', kept: false })
      expect(registrations).toEqual([{ repoRoot: at('/src/widgets'), env, flags }])
      expect(contexts[0]?.config).toMatchObject({
        dataDir: at('/data'),
        chatOverrides: { chatAgent: 'codex' },
      })
      expect((await app.request('/r/acme/widgets/', { headers: LOCAL })).status).toBe(200)
      // The flags are saved with the project; the environment is not.
      expect(await readRegistry(home)).toEqual([
        { slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags },
      ])
    })

    it('refuses a body that is not JSON or names no absolute folder', async () => {
      for (const body of [
        'not json',
        {},
        { repoRoot: 'src/widgets' },
        { repoRoot: at('/src'), env: { A: 1 } },
      ]) {
        const res = await register(body)
        expect([body, res.status]).toEqual([body, 400])
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('BAD_REQUEST')
      }
      const relative = await json<{ error: { hint?: string } }>(await register({ repoRoot: 'src/widgets' }))
      expect(relative.error.hint).toBe('an absolute path')
      expect(registrations).toEqual([])
    })

    it('answers 400 for a checkout the config refuses, and 500 with a log line for anything else', async () => {
      const notRepo = await register({ repoRoot: at('/src/gadgets-feature') })
      expect(notRepo.status).toBe(400)
      expect(await json(notRepo)).toEqual({
        error: {
          code: 'NOT_A_REPO',
          message: 'not inside a git repository',
          hint: 'run from a clone or pass --repo <dir>',
        },
      })
      const badFlag = await register({ repoRoot: at('/src/widgets'), flags: { chatAgent: 'gpt' } })
      expect(badFlag.status).toBe(400)
      expect(await json(badFlag)).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'unknown chat agent: gpt',
          hint: 'use --chat-agent claude or --chat-agent codex',
        },
      })
      expect(await readRegistry(home)).toEqual([])
      failure = new Error('disk unavailable')
      const broken = await register({ repoRoot: at('/src/widgets') })
      expect(broken.status).toBe(500)
      expect(await json(broken)).toEqual({ error: { code: 'INTERNAL', message: 'disk unavailable' } })
      expect(logs.some(line => line.startsWith('[serve] POST /api/hub/projects 500 INTERNAL'))).toBe(true)
    })

    it('sends a saved project whose checkout answers under another path now there, keeping the query', async () => {
      await hub.register({ repoRoot: at('/src/widgets'), flags: { chatAgent: 'codex' } })
      hub.close()
      await git(at('/src/widgets'), 'remote', 'set-url', 'origin', 'git@github.com:acme/renamed.git')
      await start(await readRegistry(home))
      const res = await app.request('/r/acme/widgets/review/42?theme=dark', { headers: LOCAL })
      expect(res.status).toBe(308)
      expect(res.headers.get('location')).toBe('/r/acme/renamed/review/42?theme=dark')
      expect(await readRegistry(home)).toEqual([
        { slug: 'acme/renamed', repoRoot: at('/src/widgets'), flags: { chatAgent: 'codex' } },
      ])
      expect((await app.request('/r/acme/widgets/', { headers: LOCAL })).status).toBe(404)
      const renamed = await app.request('/r/acme/renamed/', { headers: LOCAL })
      expect(renamed.status).toBe(200)
      expect(await renamed.text()).toContain('<h1>acme/renamed</h1>')
      expect(registrations.map(r => r.flags)).toEqual([{ chatAgent: 'codex' }, { chatAgent: 'codex' }])
    })

    it('answers 409 when another checkout holds the path with a generation running', async () => {
      const { project } = await hub.register({ repoRoot: at('/src/widgets') })
      await project.ctx.generation.start(7, { force: false })
      const res = await register({ repoRoot: at('/elsewhere/widgets') })
      expect(res.status).toBe(409)
      expect(await json(res)).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: `acme/widgets serves ${at('/src/widgets')}, which has a chat turn or a generation running`,
          hint: 'try again when it ends, or rename one of the two worktree folders',
        },
      })
      open()
      await vi.waitFor(() => expect(project.ctx.generation.running()).toBeNull())
    })
  })

  describe('the server pages', () => {
    it('lists every saved project at the root, built or not', async () => {
      await start([
        { slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} },
        { slug: 'acme/gadgets~feature', repoRoot: at('/src/gadgets-feature'), flags: {} },
      ])
      const res = await app.request('/', { headers: LOCAL })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toMatch(/nonce-/)
      const html = await res.text()
      // One panel per repository, its checkouts in rows: the main checkout first, a worktree by its
      // folder name.
      expect(html).toContain('<h2>acme/gadgets</h2><span class="muted">1 checkout</span>')
      expect(html).toContain('<h2>acme/widgets</h2><span class="muted">1 checkout</span>')
      expect(html.indexOf('<h2>acme/gadgets</h2>')).toBeLessThan(html.indexOf('<h2>acme/widgets</h2>'))
      expect(html).toContain('<a class="project-name" href="/r/acme/widgets/">main checkout</a>')
      expect(html).toContain(
        '<a class="project-name" href="/r/acme/gadgets~feature/">feature</a> <span class="pill">worktree</span>'
      )
      expect(html).toContain(`title="${at('/src/gadgets-feature')}"`)
      expect(html).toContain('localhost:3010')
      expect(html).toContain('<a class="cmd" id="health" href="/api/health"')
      // A remove command per project, run by the page's own script.
      expect(html).toContain('<button class="cmd project-remove" type="button" data-remove="acme/widgets"')
      expect(html).toContain(
        '<button class="cmd project-remove" type="button" data-remove="acme/gadgets~feature"'
      )
      expect(html).not.toContain('<form')
      expect(html).toContain('<a class="brand-wordmark" href="/" title="All projects">')
      expect(html).toContain('id="skin-toggle"')
      expect(html).toContain('>skin: github</button>')
      expect(html).toContain('id="theme-toggle"')
      expect(html).toContain('>theme: auto</button>')
      expect(html).toContain('{"base":"/","version":"1.2.3"}</script>')
      expect(html).toContain('<script type="module" src="/static/js/page-appearance.js"></script>')
      expect(html).toContain('<script type="module" src="/static/js/projects-page.js"></script>')
      expect(html).not.toContain('/static/js/app.js')
      expect(registrations).toEqual([])
    })

    it('leaves out a saved project whose folder is gone, and saves the list without it', async () => {
      await start([
        { slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} },
        { slug: 'acme/gadgets~feature', repoRoot: at('/src/gadgets-feature'), flags: {} },
      ])
      await rm(at('/src/gadgets-feature'), { recursive: true })
      const html = await (await app.request('/', { headers: LOCAL })).text()
      expect(html).toContain('acme/widgets')
      expect(html).not.toContain('acme/gadgets~feature')
      expect(await readRegistry(home)).toEqual([
        { slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} },
      ])
    })

    it('paints the list and its error page as saved, and the query wins for one load', async () => {
      await start()
      await writeAppearance(home, { skin: 'terminal', theme: 'dark' })
      const list = await (await app.request('/', { headers: LOCAL })).text()
      expect(list).toContain('data-skin="terminal" data-theme="dark"')
      expect(list).toContain('>skin: terminal</button>')
      expect(list).toContain('>theme: dark</button>')
      const error = await (await app.request('/nope', { headers: LOCAL })).text()
      expect(error).toContain('data-skin="terminal" data-theme="dark"')
      expect(error).toContain('<a class="brand-wordmark" href="/" title="All projects">')
      expect(error).toContain('{"error":{"code":"NOT_FOUND"')
      expect(error).toContain('"base":"/"')
      const once = await (await app.request('/?skin=olive&theme=light', { headers: LOCAL })).text()
      expect(once).toContain('data-skin="olive" data-theme="light"')
      expect(once).toContain('>theme: light</button>')
      expect(await (await app.request('/nope?theme=light', { headers: LOCAL })).text()).toContain(
        'data-skin="terminal" data-theme="light"'
      )
      // Neither load saved the query's choice.
      expect(await readAppearance(home)).toEqual({ skin: 'terminal', theme: 'dark' })
    })

    it('says there is nothing yet, painted as the query asks', async () => {
      await start()
      const html = await (await app.request('/?theme=dark', { headers: LOCAL })).text()
      expect(html).toContain('No projects yet')
      expect(html).toContain('data-theme="dark"')
    })

    it('serves the static files every project page loads, and a page or envelope for the rest', async () => {
      await start()
      const css = await app.request('/static/styles.css', { headers: LOCAL })
      expect(css.status).toBe(200)
      expect(css.headers.get('content-type')).toMatch(/text\/css/)
      for (const script of ['/static/js/page-appearance.js', '/static/js/projects-page.js']) {
        const js = await app.request(script, { headers: LOCAL })
        expect([script, js.status]).toEqual([script, 200])
      }
      const page = await app.request('/nope', { headers: LOCAL })
      expect(page.status).toBe(404)
      expect(await page.text()).toContain('NOT_FOUND')
      const api = await app.request('/api/nope', { headers: LOCAL })
      expect(await json(api)).toEqual({ error: { code: 'NOT_FOUND', message: 'no route for GET /api/nope' } })
    })
  })

  describe('/api/appearance', () => {
    beforeEach(async () => {
      await start()
    })

    it('reads the defaults, then saves each half on its own without the token', async () => {
      const read = await app.request('/api/appearance', { headers: LOCAL })
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      expect(await json(read)).toEqual({ skin: 'github', theme: 'auto' })
      const saved = await putAppearance({ theme: 'dark' })
      expect(saved.status).toBe(200)
      expect(await json(saved)).toEqual({ skin: 'github', theme: 'dark' })
      expect(await json(await putAppearance({ skin: 'olive' }))).toEqual({ skin: 'olive', theme: 'dark' })
      expect(await json(await app.request('/api/appearance', { headers: LOCAL }))).toEqual({
        skin: 'olive',
        theme: 'dark',
      })
      expect(await readAppearance(home)).toEqual({ skin: 'olive', theme: 'dark' })
    })

    it('refuses a body that is not JSON or names no known skin or theme', async () => {
      for (const body of ['not json', {}, { skin: 'neon' }, { theme: 'sepia' }]) {
        const res = await putAppearance(body)
        expect([body, res.status]).toEqual([body, 400])
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('BAD_REQUEST')
      }
      expect(await readAppearance(home)).toEqual({ skin: 'github', theme: 'auto' })
    })

    it('refuses a save from another site', async () => {
      const crossSite = await putAppearance({ theme: 'dark' }, { ...PAGE, 'sec-fetch-site': 'cross-site' })
      expect(crossSite.status).toBe(403)
      expect((await json<{ error: { code: string } }>(crossSite)).error.code).toBe('CROSS_ORIGIN')
      const foreign = await putAppearance({ theme: 'dark' }, { ...PAGE, origin: 'https://evil.example' })
      expect(foreign.status).toBe(403)
      expect(await readAppearance(home)).toEqual({ skin: 'github', theme: 'auto' })
    })
  })

  describe('/api/projects/remove', () => {
    beforeEach(async () => {
      await start([{ slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} }])
    })

    it('takes a project off the list without the token, and stops serving it', async () => {
      expect((await app.request('/r/acme/widgets/', { headers: LOCAL })).status).toBe(200)
      const res = await removeProject({ slug: 'acme/widgets' })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await json(res)).toEqual({ removed: true })
      expect(await readRegistry(home)).toEqual([])
      expect(await (await app.request('/', { headers: LOCAL })).text()).toContain('No projects yet')
      expect((await app.request('/r/acme/widgets/', { headers: LOCAL })).status).toBe(404)
    })

    it('answers 404 for a slug no project has', async () => {
      const res = await removeProject({ slug: 'acme/nope' })
      expect(res.status).toBe(404)
      expect(await json(res)).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'no project acme/nope is served here',
          hint: 'reload the project list',
        },
      })
      expect(await readRegistry(home)).toHaveLength(1)
    })

    it('refuses a body that is not JSON or names no slug', async () => {
      for (const body of ['not json', {}, { slug: 7 }, { basePath: '/r/acme/widgets/' }]) {
        const res = await removeProject(body)
        expect([body, res.status]).toEqual([body, 400])
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('BAD_REQUEST')
      }
      expect(await readRegistry(home)).toHaveLength(1)
    })

    it('answers 409 while the project runs a generation, and keeps it', async () => {
      const { project } = await hub.register({ repoRoot: at('/src/widgets') })
      await project.ctx.generation.start(7, { force: false })
      const res = await removeProject({ slug: 'acme/widgets' })
      expect(res.status).toBe(409)
      expect(await json(res)).toEqual({
        error: {
          code: 'BAD_REQUEST',
          message: 'acme/widgets has a chat turn or a generation running',
          hint: 'remove it once that ends',
        },
      })
      expect(await readRegistry(home)).toHaveLength(1)
      open()
      await vi.waitFor(() => expect(project.ctx.generation.running()).toBeNull())
    })

    it('refuses a request from another site', async () => {
      const crossSite = await removeProject(
        { slug: 'acme/widgets' },
        { ...PAGE, 'sec-fetch-site': 'cross-site' }
      )
      expect(crossSite.status).toBe(403)
      expect((await json<{ error: { code: string } }>(crossSite)).error.code).toBe('CROSS_ORIGIN')
      const foreign = await removeProject({ slug: 'acme/widgets' }, { ...PAGE, origin: 'null' })
      expect(foreign.status).toBe(403)
      expect(await readRegistry(home)).toHaveLength(1)
    })
  })
})

describe('the server health', () => {
  it('names the version, the port, and where each project checks its own health', async () => {
    await start([{ slug: 'acme/widgets', repoRoot: at('/src/widgets'), flags: {} }])
    const res = await app.request('/api/health', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      ok: true,
      version: '1.2.3',
      port: 3010,
      projects: [
        { slug: 'acme/widgets', repoRoot: at('/src/widgets'), health: '/r/acme/widgets/api/health' },
      ],
    })
  })
})

describe('shortPath', () => {
  it('writes a path under the home folder from ~, and leaves any other as it is', () => {
    expect(shortPath('/home/me/code/widgets', '/home/me')).toBe('~/code/widgets')
    expect(shortPath('/home/me', '/home/me')).toBe('~')
    expect(shortPath('/home/meadow/widgets', '/home/me')).toBe('/home/meadow/widgets')
    expect(shortPath('/srv/widgets', '/home/me')).toBe('/srv/widgets')
  })
})

describe('groupProjects', () => {
  const listed = (slug: string) => ({ slug, repoRoot: `/x/${slug}`, shownPath: slug })

  it('groups checkouts by repository, the main checkout first and worktrees by folder name', () => {
    const groups = groupProjects([
      listed('acme/widgets~zeta'),
      listed('acme/gadgets'),
      listed('acme/widgets~alpha'),
      listed('acme/widgets'),
    ])
    expect(groups.map(g => [g.repo, g.checkouts.map(c => c.worktree)])).toEqual([
      ['acme/gadgets', [null]],
      ['acme/widgets', [null, 'alpha', 'zeta']],
    ])
  })
})
