// @vitest-environment node
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PrBundle } from '../contract/api.js'
import { emptyState } from '../contract/state.js'
import { GitHubApiError } from '../github/gh.js'
import {
  createFakeGh,
  createFakeGit,
  ghError,
  makeTempDir,
  makeTestContext,
  type TestContext,
} from '../testing/fakes.js'
import { BASE_SHA, ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { createApp } from './app.js'
import { rekeyFixture } from './bundle.js'
import { jsonForScript } from './html.js'
import { CONTEXT_MAX_LINES } from './routes/api.js'
import { contentTypeFor, resolveUnder, resolveVendor } from './routes/static.js'

const LOCAL = { host: 'localhost:3010' }
const PUT = { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' }

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

describe('createApp', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  describe('security', () => {
    beforeEach(async () => {
      t = await makeTestContext()
    })

    it('answers 403 to a Host that is not loopback', async () => {
      const app = createApp(t.ctx)
      const res = await app.request('/', { headers: { host: 'evil' } })
      expect(res.status).toBe(403)
      expect(res.headers.get('content-type')).toMatch(/text\/html/)
      const api = await app.request('/api/health', { headers: { host: 'evil' } })
      expect(api.status).toBe(403)
      expect(await json(api)).toEqual({
        error: { code: 'FORBIDDEN_HOST', message: 'this server only answers to localhost' },
      })
    })

    it('rejects cross-site and cross-origin non-GET requests, and allows same-origin ones', async () => {
      const app = createApp(t.ctx)
      const crossSite = await app.request('/api/prs/42/comments', {
        method: 'POST',
        headers: { ...LOCAL, 'sec-fetch-site': 'cross-site' },
      })
      expect(await json(crossSite)).toEqual({
        error: { code: 'CROSS_ORIGIN', message: 'cross-site request rejected' },
      })
      const badOrigin = await app.request('/api/prs/42/comments', {
        method: 'POST',
        headers: { ...LOCAL, origin: 'https://evil.example' },
      })
      expect(badOrigin.status).toBe(403)
      expect(await json(badOrigin)).toEqual({
        error: { code: 'CROSS_ORIGIN', message: 'cross-origin request rejected' },
      })
      const ok = await app.request('/api/prs/42/comments', {
        method: 'POST',
        headers: { ...LOCAL, origin: 'http://localhost:3010', 'sec-fetch-site': 'same-origin' },
      })
      // Past the security check, the route itself answers: this POST carries no comment.
      expect(ok.status).toBe(400)
      const none = await app.request('/api/prs/42/comments', {
        method: 'POST',
        headers: { ...LOCAL, 'sec-fetch-site': 'none' },
      })
      expect(none.status).toBe(400)
    })

    it('answers unknown routes with the envelope under /api and a page elsewhere', async () => {
      const app = createApp(t.ctx)
      const api = await app.request('/api/nope', { headers: LOCAL })
      expect(api.status).toBe(404)
      expect(await json(api)).toEqual({ error: { code: 'NOT_FOUND', message: 'no route for GET /api/nope' } })
      const page = await app.request('/nope', { headers: LOCAL })
      expect(page.status).toBe(404)
      expect(await page.text()).toContain('NOT_FOUND')
    })
  })

  describe('pages', () => {
    beforeEach(async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    })

    it('renders the home page with recent PRs after one was loaded', async () => {
      const app = createApp(t.ctx)
      const empty = await app.request('/', { headers: LOCAL })
      expect(empty.status).toBe(200)
      expect(await empty.text()).toContain('No pull requests opened yet.')
      await app.request('/api/prs/42', { headers: LOCAL })
      const html = await (await app.request('/', { headers: LOCAL })).text()
      expect(html).toContain('href="/review/42"')
      expect(html).toContain('feat: add b')
      expect(html).toContain('acme/widgets')
    })

    it('renders the review shell with bootstrap JSON, the import map, and no patch data', async () => {
      const app = createApp(t.ctx)
      const res = await app.request('/review/42', { headers: LOCAL })
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('<pr-app class="page" data-pr="42">')
      expect(html).toContain(
        '{"prNumber":42,"owner":"acme","repo":"widgets","version":"0.0.0-test"}</script>'
      )
      expect(html).toContain('<script type="importmap" nonce="')
      expect(html).toContain('/vendor/diff/index.js')
      // Mermaid is in the map so `diagram.js` can import it, and is not preloaded: most pages have
      // no diagram.
      expect(html).toContain('"mermaid":"/vendor/mermaid/mermaid.esm.min.mjs"')
      expect(html).not.toContain('<link rel="modulepreload" href="/vendor/mermaid/mermaid.esm.min.mjs">')
      expect(html).toContain('<script type="module" src="/static/js/app.js"></script>')
      // The skin and the theme come from the settings file, so the server paints both onto the
      // tag itself and the page carries no script that picks them.
      expect(html).toContain('<html lang="en" data-skin="terminal" data-theme="auto">')
      expect(html).not.toContain('localStorage')
      expect(html).not.toContain('@@ -')
    })

    it('renders the appearance the settings file holds, and lets the query pick one for a load', async () => {
      const app = createApp(t.ctx)
      await app.request('/api/appearance', {
        method: 'PUT',
        headers: PUT,
        body: JSON.stringify({ skin: 'github', theme: 'dark' }),
      })
      const painted = 'data-skin="github" data-theme="dark"'
      expect(await (await app.request('/review/42', { headers: LOCAL })).text()).toContain(painted)
      expect(await (await app.request('/', { headers: LOCAL })).text()).toContain(painted)
      // The query wins for that response alone and changes nothing in the file.
      expect(
        await (await app.request('/review/42?skin=terminal&theme=light', { headers: LOCAL })).text()
      ).toContain('data-skin="terminal" data-theme="light"')
      // A name the tool does not know is ignored rather than refused.
      expect(await (await app.request('/?skin=neon&theme=sepia', { headers: LOCAL })).text()).toContain(
        painted
      )
      // The error page wears it too, so a wrong URL does not flash the other look.
      const missing = await app.request('/nope', { headers: LOCAL })
      expect(missing.status).toBe(404)
      expect(await missing.text()).toContain(painted)
    })

    it('answers 400 for a non-numeric PR', async () => {
      const app = createApp(t.ctx)
      const res = await app.request('/review/abc', { headers: LOCAL })
      expect(res.status).toBe(400)
      expect(await res.text()).toContain('BAD_REQUEST')
    })
  })

  describe('/api/appearance', () => {
    beforeEach(async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    })

    it('reads the saved appearance, writes each half on its own, and leaves the chat settings alone', async () => {
      const app = createApp(t.ctx)
      const put = (body: unknown) =>
        app.request('/api/appearance', { method: 'PUT', headers: PUT, body: JSON.stringify(body) })
      expect(await json(await app.request('/api/appearance', { headers: LOCAL }))).toEqual({
        skin: 'terminal',
        theme: 'auto',
      })
      const saved = await put({ skin: 'github' })
      expect(saved.status).toBe(200)
      expect(await json(saved)).toEqual({ skin: 'github', theme: 'auto' })
      // Saving the theme keeps the skin that was already there.
      expect(await json(await put({ theme: 'dark' }))).toEqual({ skin: 'github', theme: 'dark' })
      expect(await json(await app.request('/api/appearance', { headers: LOCAL }))).toEqual({
        skin: 'github',
        theme: 'dark',
      })
      expect(await t.ctx.settings.read()).toMatchObject({
        skin: 'github',
        theme: 'dark',
        agent: 'claude',
        chatTimeoutSec: 600,
      })
    })

    it('refuses a body that names no skin and no theme', async () => {
      const app = createApp(t.ctx)
      const bodies = ['not json', JSON.stringify({ skin: 'neon' }), JSON.stringify({ theme: 'sepia' }), '{}']
      for (const body of bodies) {
        const res = await app.request('/api/appearance', { method: 'PUT', headers: PUT, body })
        expect([body, res.status]).toEqual([body, 400])
        expect((await json<{ error: { code: string } }>(res)).error.code).toBe('BAD_REQUEST')
      }
      expect(await t.ctx.settings.read()).toMatchObject({ skin: 'terminal', theme: 'auto' })
    })
  })

  describe('/api/health', () => {
    it('reports every check', async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
      const res = await createApp(t.ctx).request('/api/health', { headers: LOCAL })
      expect(await json(res)).toEqual({
        ok: true,
        version: '0.0.0-test',
        checks: {
          git: { ok: true },
          origin: { ok: true, detail: 'acme/widgets' },
          gh: { ok: true },
          ghAuth: { ok: true },
          acpx: { ok: true, detail: '0.13.2' },
          agentInstalled: { ok: true },
          agentAuth: { ok: true },
        },
        repo: { owner: 'acme', name: 'widgets' },
        dataDir: t.dataDir,
        chat: { enabled: true, acpx: true, agent: 'claude', model: null },
      })
    })

    it('reports failures without throwing', async () => {
      t = await makeTestContext({
        git: createFakeGit(),
        gh: createFakeGh({ auth: { installed: false, authenticated: false, detail: 'gh is not on PATH' } }),
      })
      const body = await json<{ ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> }>(
        await createApp(t.ctx).request('/api/health', { headers: LOCAL })
      )
      expect(body.ok).toBe(false)
      const { git: gitCheck, gh: ghCheck, ghAuth } = body.checks
      expect(gitCheck?.ok).toBe(false)
      expect(gitCheck?.detail).toMatch(/not a git repository/)
      expect(ghCheck).toEqual({ ok: false, detail: 'gh is not on PATH' })
      expect(ghAuth).toEqual({ ok: false, detail: 'gh is not on PATH' })
    })
  })

  describe('/api/prs/:n', () => {
    it('reports missing with the skill command and live PR data when no canvas exists', async () => {
      const git = gitFor42()
      const gh = ghFor42()
      t = await makeTestContext({ git, gh })
      const app = createApp(t.ctx)
      const bundle = await json<PrBundle>(await app.request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('missing')
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42')
      expect(bundle.pr).toEqual(syntheticArtifact().pr)
      expect(bundle.files.map(f => f.key)).toEqual([
        'src_app_ts',
        'src_new_ts',
        'src_gone_ts',
        'src_new_name_ts',
        'assets_logo_png',
        'bin_run_sh',
        'src_app_test_ts',
      ])
      expect(bundle.derivable).toBe(true)
      expect(bundle.artifact).toBeUndefined()
      expect(bundle.comments.reviewComments.map(c => [c.id, c.resolved])).toEqual([
        [1001, true],
        [1002, true],
        [1003, false],
      ])
      expect(bundle.state).toEqual(emptyState('2026-09-10T12:00:00.000Z'))
      expect(bundle.capabilities).toEqual({ canComment: true, tokenKind: 'classic', login: 'octocat' })
      expect(bundle.chat).toEqual({ enabled: true, acpx: true, agent: 'claude', model: null })
      expect(bundle.warnings).toEqual([])
      // Second call: served from the cache, no new GitHub call, no new fetch.
      const ghCalls = gh.calls.length
      const fetches = git.calls.filter(c => c[0] === 'fetch').length
      await app.request('/api/prs/42', { headers: LOCAL })
      expect(gh.calls.length).toBe(ghCalls)
      expect(git.calls.filter(c => c[0] === 'fetch').length).toBe(fetches)
      await app.request('/api/prs/42?refresh=1', { headers: LOCAL })
      expect(gh.calls.length).toBeGreaterThan(ghCalls)
      // A deleted cache file forces a refetch even without refresh=1.
      const { rm } = await import('node:fs/promises')
      await rm(path.join(t.ctx.prs.prDir(42), 'pr.json'))
      const afterRefresh = gh.calls.length
      await app.request('/api/prs/42', { headers: LOCAL })
      expect(gh.calls.length).toBeGreaterThan(afterRefresh)
    })

    it('keeps serving the old canvas while a forced regeneration is in progress', async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
      const artifact = syntheticArtifact()
      const manifest = {
        formatVersion: 1 as const,
        tool: { name: 'pr-review', version: '0.1.0' },
        repo: { owner: 'acme', name: 'widgets' },
        prNumber: 42,
        headSha: HEAD_SHA,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: artifact.generatedAt,
        generator: artifact.generator,
      }
      await t.ctx.canvases.write(HEAD_SHA, artifact, manifest)
      const { prepare } = await import('../review/prepare.js')
      const prepared = await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
      expect(prepared.status).toBe('prepared')
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.artifact).toEqual(artifact)
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42 --force')
    })

    it('reports ready from the local canvas store with the manifest and --force in the command', async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
      const artifact = {
        ...syntheticArtifact(),
        importedAt: '2026-09-10T11:30:00.000Z',
        source: 'import' as const,
      }
      const manifest = {
        formatVersion: 1 as const,
        tool: { name: 'pr-review', version: '0.1.0' },
        repo: { owner: 'acme', name: 'widgets' },
        prNumber: 42,
        headSha: HEAD_SHA,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: artifact.generatedAt,
        generator: artifact.generator,
      }
      await t.ctx.canvases.write(HEAD_SHA, artifact, manifest)
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.artifact).toEqual(artifact)
      expect(bundle.canvas).toEqual({
        headSha: HEAD_SHA,
        source: 'import',
        manifest,
        importedAt: '2026-09-10T11:30:00.000Z',
      })
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42 --force')
    })

    it('reports missing with a warning when the indexed canvas has an old format', async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
      const dir = t.ctx.canvases.canvasDir(HEAD_SHA)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'review.json'), JSON.stringify({ version: 1, findings: [] }))
      await writeFile(
        path.join(t.ctx.canvases.root, 'index.json'),
        JSON.stringify({ canvases: { [HEAD_SHA]: { generatedAt: 'x', source: 'local' } } })
      )
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('missing')
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42 --force')
      expect(bundle.warnings).toEqual([
        `the canvas for ${HEAD_SHA.slice(0, 7)} does not match the current format; regenerate it`,
      ])
    })

    it('fails loudly when the index lists a canvas whose review.json is gone', async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
      await mkdir(path.join(t.ctx.canvases.root), { recursive: true })
      await writeFile(
        path.join(t.ctx.canvases.root, 'index.json'),
        JSON.stringify({ canvases: { [HEAD_SHA]: { generatedAt: 'x', source: 'local' } } })
      )
      const res = await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
      expect(res.status).toBe(500)
      expect(await json(res)).toEqual({
        error: { code: 'CANVAS_INVALID', message: `index lists ${HEAD_SHA} but review.json is missing` },
      })
    })

    it('serves the fixture canvas re-keyed to the live head when --fixture-canvas is set', async () => {
      const fixture = {
        ...syntheticArtifact(),
        pr: { ...syntheticArtifact().pr, headSha: 'd'.repeat(40), number: 999 },
      }
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42(), fixtureArtifact: fixture })
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.artifact?.pr).toEqual(syntheticArtifact().pr)
      expect(bundle.canvas).toEqual({ headSha: HEAD_SHA, source: 'fixture', manifest: null })
      expect(bundle.warnings).toEqual(['showing the --fixture-canvas artifact (dev only)'])
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42 --force')
      expect(rekeyFixture(fixture, syntheticArtifact().pr)).toEqual({
        ...fixture,
        pr: syntheticArtifact().pr,
        source: 'local',
      })
    })

    it('falls back to the fixture files when the diff is not derivable', async () => {
      const git = gitFor42()
      git.commitExists = async () => false
      t = await makeTestContext({ git, gh: ghFor42(), fixtureArtifact: syntheticArtifact() })
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.derivable).toBe(false)
      expect(bundle.files).toEqual(syntheticArtifact().files)
      expect(bundle.warnings).toEqual([
        'the PR head or merge base is not in the local clone; diffs are not available',
        'showing the --fixture-canvas artifact (dev only)',
      ])
    })

    it('maps GitHub and input errors to envelopes', async () => {
      t = await makeTestContext({
        git: gitFor42(),
        gh: createFakeGh({
          routes: { 'repos/acme/widgets/pulls/7': ghError(new GitHubApiError('x', 'HTTP 401', 1)) },
        }),
      })
      const app = createApp(t.ctx)
      expect(await json(await app.request('/api/prs/42', { headers: LOCAL }))).toEqual({
        error: {
          code: 'PR_NOT_FOUND',
          message: 'pull request #42 not found',
          hint: 'check the number and that origin is the right repository',
        },
      })
      const unauth = await app.request('/api/prs/7', { headers: LOCAL })
      expect(unauth.status).toBe(401)
      expect(await json(unauth)).toMatchObject({ error: { code: 'GH_UNAUTHENTICATED' } })
      const bad = await app.request('/api/prs/x', { headers: LOCAL })
      expect(bad.status).toBe(400)
      expect(await json(bad)).toEqual({
        error: { code: 'BAD_REQUEST', message: 'not a pull request number: x' },
      })
    })

    it('maps a git failure while fetching refs to GIT_ERROR', async () => {
      const git = gitFor42()
      git.fetch = async () => {
        const { GitError } = await import('../git/git.js')
        throw new GitError(['fetch'], 'could not read from remote', 128)
      }
      t = await makeTestContext({ git, gh: ghFor42() })
      const res = await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
      expect(res.status).toBe(500)
      expect(await json(res)).toMatchObject({ error: { code: 'GIT_ERROR' } })
    })

    it('reports project config warnings and the chat switch on the bundle', async () => {
      const { DEFAULT_PROJECT_CONFIG } = await import('../project-config.js')
      t = await makeTestContext({
        git: gitFor42(),
        gh: ghFor42(),
        projectConfig: {
          config: { ...DEFAULT_PROJECT_CONFIG, chat: { enabled: false } },
          warnings: ['bad layers'],
          source: null,
        },
      })
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.warnings).toEqual(['bad layers'])
      expect(bundle.chat).toEqual({ enabled: false, acpx: false })
    })
  })

  describe('/api/prs/:n/patches, /comments, /context', () => {
    beforeEach(async () => {
      t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    })

    it('serves patches as JSON after the bundle built them, and 404 before', async () => {
      const app = createApp(t.ctx)
      const before = await app.request(`/api/prs/42/patches?headSha=${'e'.repeat(40)}`, { headers: LOCAL })
      expect(before.status).toBe(404)
      expect(await json(before)).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'diffs for this head are not available locally',
          hint: 'fetch the PR head and reload',
        },
      })
      const badSha = await app.request('/api/prs/42/patches?headSha=zzz', { headers: LOCAL })
      expect(badSha.status).toBe(400)
      expect(await json(badSha)).toEqual({
        error: { code: 'BAD_REQUEST', message: 'headSha must be a 40-character lowercase hex sha' },
      })
      // The bundle builds derived/; patches are read from it.
      const notBuilt = await app.request('/api/prs/42/patches', { headers: LOCAL })
      expect(notBuilt.status).toBe(404)
      await app.request('/api/prs/42', { headers: LOCAL })
      const res = await app.request('/api/prs/42/patches', { headers: LOCAL })
      expect(res.status).toBe(200)
      const body = await json<{ headSha: string; patches: Record<string, string> }>(res)
      expect(body.headSha).toBe(HEAD_SHA)
      expect(Object.values(body.patches).some(p => p.includes('</script>'))).toBe(true)
    })

    it('refreshes comments on demand', async () => {
      const app = createApp(t.ctx)
      const body = await json<{ headSha: string; reviewComments: unknown[]; issueComments: unknown[] }>(
        await app.request('/api/prs/42/comments', { headers: LOCAL })
      )
      expect(body.headSha).toBe(HEAD_SHA)
      expect(body.reviewComments).toHaveLength(3)
      expect(body.issueComments).toHaveLength(2)
    })

    it('serves context lines from head and base with validation', async () => {
      const app = createApp(t.ctx)
      await app.request('/api/prs/42', { headers: LOCAL })
      const ok = await app.request('/api/prs/42/context?path=src/app.ts&side=new&from=3&to=4', {
        headers: LOCAL,
      })
      expect(await json(ok)).toEqual({
        path: 'src/app.ts',
        side: 'new',
        from: 3,
        to: 4,
        lines: ['export function run() {', '  return a() + b()'],
      })
      const old = await app.request('/api/prs/42/context?path=src/app.ts&side=old&from=1&to=1', {
        headers: LOCAL,
      })
      expect(await json(old)).toEqual({
        path: 'src/app.ts',
        side: 'old',
        from: 1,
        to: 1,
        lines: ["import { a } from './a'"],
      })
      const missing = await app.request('/api/prs/42/context?path=src/app.ts&side=new', { headers: LOCAL })
      expect(missing.status).toBe(400)
      const tooMany = await app.request(
        `/api/prs/42/context?path=src/app.ts&side=new&from=1&to=${CONTEXT_MAX_LINES + 1}`,
        {
          headers: LOCAL,
        }
      )
      expect(await json(tooMany)).toEqual({
        error: { code: 'BAD_REQUEST', message: `request between 1 and ${CONTEXT_MAX_LINES} lines` },
      })
      const reversed = await app.request('/api/prs/42/context?path=src/app.ts&side=new&from=5&to=2', {
        headers: LOCAL,
      })
      expect(reversed.status).toBe(400)
      const unknown = await app.request('/api/prs/42/context?path=src/zzz.ts&side=new&from=1&to=2', {
        headers: LOCAL,
      })
      expect(unknown.status).toBe(404)
    })
  })

  describe('static and vendor files', () => {
    it('serves the stylesheet and modules with content types, and blocks traversal', async () => {
      const vendorDir = await makeTempDir()
      await mkdir(path.join(vendorDir, 'diff', 'sub'), { recursive: true })
      await mkdir(path.join(vendorDir, 'mermaid', 'chunks'), { recursive: true })
      await writeFile(path.join(vendorDir, 'diff', 'index.js'), 'export const diff = 1')
      await writeFile(path.join(vendorDir, 'diff', 'sub', 'x.js'), 'export const x = 1')
      await writeFile(path.join(vendorDir, 'diff', 'secret.txt'), 'no')
      await writeFile(path.join(vendorDir, 'marked.js'), 'export const marked = 1')
      await writeFile(path.join(vendorDir, 'mermaid', 'mermaid.esm.min.mjs'), 'export default { render: 1 }')
      await writeFile(path.join(vendorDir, 'mermaid', 'chunks', 'c.mjs'), 'export const chunk = 1')
      await writeFile(path.join(vendorDir, 'mermaid', 'mermaid.esm.min.mjs.map'), '{}')
      t = await makeTestContext({
        vendorRoots: {
          diff: path.join(vendorDir, 'diff'),
          marked: path.join(vendorDir, 'marked.js'),
          dompurify: path.join(vendorDir, 'missing.js'),
          hljs: path.join(vendorDir, 'missing.js'),
          mermaid: path.join(vendorDir, 'mermaid'),
        },
      })
      const app = createApp(t.ctx)
      const css = await app.request('/static/styles.css', { headers: LOCAL })
      expect(css.status).toBe(200)
      expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
      expect(css.headers.get('cache-control')).toBe('no-cache')
      const js = await app.request('/static/js/app.js', { headers: LOCAL })
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect((await app.request('/static/js/', { headers: LOCAL })).status).toBe(404)
      expect((await app.request('/static/%2e%2e/package.json', { headers: LOCAL })).status).toBe(404)
      expect((await app.request('/static/js/%00.js', { headers: LOCAL })).status).toBe(404)
      const malformed = await app.request('/static/js/%E0%A4%A.js', { headers: LOCAL })
      expect(malformed.status).toBe(404)
      expect(await json(malformed)).toEqual({
        error: { code: 'NOT_FOUND', message: 'no static file js/%E0%A4%A.js' },
      })
      const marked = await app.request('/vendor/marked.js', { headers: LOCAL })
      expect(await marked.text()).toBe('export const marked = 1')
      expect(marked.headers.get('cache-control')).toBe('public, max-age=86400')
      expect(await (await app.request('/vendor/diff/index.js', { headers: LOCAL })).text()).toBe(
        'export const diff = 1'
      )
      expect(await (await app.request('/vendor/diff/sub/x.js', { headers: LOCAL })).text()).toBe(
        'export const x = 1'
      )
      expect((await app.request('/vendor/diff/secret.txt', { headers: LOCAL })).status).toBe(404)
      // URL normalization folds `..` before routing, so this lands on the allowlisted marked.js.
      expect((await app.request('/vendor/diff/%2e%2e/marked.js', { headers: LOCAL })).status).toBe(200)
      expect((await app.request('/vendor/purify.js', { headers: LOCAL })).status).toBe(404)
      expect((await app.request('/vendor/other.js', { headers: LOCAL })).status).toBe(404)
      // Mermaid is a directory too: the entry and the chunk it imports at render time, JS only.
      const mermaid = await app.request('/vendor/mermaid/mermaid.esm.min.mjs', { headers: LOCAL })
      expect(await mermaid.text()).toBe('export default { render: 1 }')
      expect(mermaid.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(await (await app.request('/vendor/mermaid/chunks/c.mjs', { headers: LOCAL })).text()).toBe(
        'export const chunk = 1'
      )
      expect((await app.request('/vendor/mermaid/mermaid.esm.min.mjs.map', { headers: LOCAL })).status).toBe(
        404
      )
      expect((await app.request('/vendor/mermaid/', { headers: LOCAL })).status).toBe(404)
    })

    it('has helpers for content types and safe resolution', async () => {
      expect(contentTypeFor('a.css')).toBe('text/css; charset=utf-8')
      expect(contentTypeFor('a.mjs')).toBe('text/javascript; charset=utf-8')
      expect(contentTypeFor('a.bin')).toBe('application/octet-stream')
      const dir = await makeTempDir()
      expect(await resolveUnder(dir, '../x')).toBeNull()
      expect(await resolveUnder(dir, 'missing')).toBeNull()
      expect(await resolveUnder(dir, '%')).toBeNull()
      const roots = { diff: dir, marked: 'm', dompurify: 'd', hljs: 'h', mermaid: dir }
      expect(await resolveVendor(roots, 'diff/../x.js')).toBeNull()
      expect(await resolveVendor(roots, 'mermaid/../x.mjs')).toBeNull()
    })
  })

  describe('jsonForScript', () => {
    it('escapes characters that could close the script element', () => {
      expect(jsonForScript({ s: '</script><b>&\u2028\u2029' })).toBe(
        '{"s":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028\\u2029"}'
      )
    })
  })
})
