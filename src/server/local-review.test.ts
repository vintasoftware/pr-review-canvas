// @vitest-environment node
// The two reviews of work in this clone, from `prepare` through the pages that show them.
import { readFile } from 'node:fs/promises'
import type { PrBundle } from '../contract/api.js'
import { GenerationContextSchema } from '../contract/generation-context.js'
import type { LocalKey } from '../contract/review-key.js'
import { buildManifest, publish } from '../review/publish.js'
import { prepare } from '../review/prepare.js'
import { artifactToModelOutput } from '../review/normalize.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, ghFor42, gitForLocal, HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { createApp } from './app.js'
import { resolveLocalBundle } from './bundle.js'

const LOCAL = { host: 'localhost:3010' }
const POST = { ...LOCAL, origin: 'http://localhost:3010', 'content-type': 'application/json' }

const quiet = { force: false, log: () => undefined }

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function target(source: LocalKey) {
  return { kind: 'local', base: 'origin/main', source } as const
}

/** Prepares one local review and publishes the synthetic model against it. */
async function publishLocal(t: TestContext, source: LocalKey = 'uncommitted'): Promise<void> {
  const result = await prepare(t.ctx, target(source), quiet)
  const model = artifactToModelOutput(syntheticArtifact())
  await writeTextAtomic(`${result.canvasDir}/model.json`, JSON.stringify(model))
  await publish(t.ctx, result.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
}

describe('the local reviews', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  it('prepares the working tree as its own commit and files it under prs/uncommitted', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const phases: string[] = []
    const result = await prepare(t.ctx, target('uncommitted'), {
      force: false,
      log: p => phases.push(p),
    })
    expect(phases).toEqual(['snapshot', 'collect-diffs', 'prompt'])
    expect(result.headSha).toBe(HEAD_SHA)
    expect(result.local).toEqual({
      review: 'uncommitted',
      base: 'origin/main',
      headRef: 'feat/b',
      uncommitted: true,
    })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.target).toEqual(target('uncommitted'))
    // The canvas records the diff it was generated from.
    expect(context.pr).toMatchObject({ additions: 8, deletions: 5, changedFiles: 7 })
    // The cached meta is the target's identity; the page counts the diff it shows for itself.
    expect(await t.ctx.prs.readPr('uncommitted')).toMatchObject({
      number: null,
      title: 'Uncommitted work on feat/b',
      author: 'dev',
      url: '',
      state: 'uncommitted',
      baseRef: 'origin/main',
      headRef: 'feat/b',
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
    })
    expect(await t.ctx.prs.readLocalTarget('uncommitted')).toEqual(target('uncommitted'))
    // Neither the branch review nor any pull request has been touched.
    expect(await t.ctx.prs.readPr('branch')).toBeNull()
    expect(await t.ctx.prs.readPr(42)).toBeNull()
  })

  it('reviews the branch tip alone, whatever the working tree holds', async () => {
    const git = gitForLocal({ head: HEAD_SHA })
    t = await makeTestContext({ git, gh: ghFor42() })
    const result = await prepare(t.ctx, target('branch'), quiet)
    expect(result.local).toEqual({
      review: 'branch',
      base: 'origin/main',
      headRef: 'feat/b',
      uncommitted: false,
    })
    expect(git.calls.some(c => c[0] === 'write-tree')).toBe(false)
    expect(await t.ctx.prs.readPr('branch')).toMatchObject({ title: 'feat/b', state: 'branch' })
    expect(await t.ctx.prs.readPr('uncommitted')).toBeNull()
  })

  it('reads as the branch review when the tree is clean', async () => {
    t = await makeTestContext({ git: gitForLocal({ snapshot: null, head: HEAD_SHA }), gh: ghFor42() })
    await prepare(t.ctx, target('uncommitted'), quiet)
    expect(await t.ctx.prs.readPr('uncommitted')).toMatchObject({ title: 'feat/b', state: 'branch' })
  })

  it('calls a detached HEAD by its name', async () => {
    const git = gitForLocal()
    git.options.branch = null
    t = await makeTestContext({ git, gh: ghFor42() })
    const result = await prepare(t.ctx, target('uncommitted'), quiet)
    expect(result.local).toMatchObject({ headRef: 'HEAD' })
    expect(await t.ctx.prs.readPr('uncommitted')).toMatchObject({ title: 'Uncommitted work on HEAD' })
  })

  it('refuses to publish when the working tree moved while the agent worked', async () => {
    const git = gitForLocal()
    t = await makeTestContext({ git, gh: ghFor42() })
    const result = await prepare(t.ctx, target('uncommitted'), quiet)
    await writeTextAtomic(
      `${result.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    git.options.snapshot = BASE_SHA
    await expect(
      publish(t.ctx, result.canvasDir, { agent: 'claude', harness: 'claude-code', allowStale: false })
    ).rejects.toThrow(/the target moved/)
  })

  it('publishes locally, links its own page, and stamps no pull request on the manifest', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const result = await prepare(t.ctx, target('uncommitted'), quiet)
    await writeTextAtomic(
      `${result.canvasDir}/model.json`,
      JSON.stringify(artifactToModelOutput(syntheticArtifact()))
    )
    const published = await publish(t.ctx, result.canvasDir, {
      agent: 'claude',
      harness: 'claude-code',
      allowStale: false,
    })
    expect(published.sharing).toEqual({ status: 'local' })
    expect(published.reviewUrl).toBe('http://localhost:3010/review/uncommitted')
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(buildManifest(context, syntheticArtifact(), '0.0.0-test').prNumber).toBeUndefined()
  })

  it('keeps a snapshot canvas out of the branch review and out of every pull request', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    expect(await t.ctx.canvases.findForLocal('uncommitted', HEAD_SHA)).toEqual({
      status: 'ready',
      headSha: HEAD_SHA,
    })
    // The snapshot commit sits on no branch, so neither PR #42 nor the branch review claims it.
    expect(await t.ctx.canvases.findForPr(42, BASE_SHA)).toEqual({ status: 'missing' })
    expect(await t.ctx.canvases.findForLocal('branch', BASE_SHA)).toEqual({ status: 'missing' })
  })

  it('falls back to the canvas of a commit the local head was built on', async () => {
    const git = gitForLocal()
    t = await makeTestContext({ git, gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    git.options.ancestors = { [`${HEAD_SHA}..${BASE_SHA}`]: true }
    git.options.counts = { [`${HEAD_SHA}..${BASE_SHA}`]: 1 }
    expect(await t.ctx.canvases.findForLocal('uncommitted', BASE_SHA)).toEqual({
      status: 'stale',
      headSha: HEAD_SHA,
      relation: 'ancestor',
      commitsBehind: 1,
    })
  })

  it.each(['branch', 'uncommitted'] as const)(
    'serves the %s canvas with the forge side of the page turned off',
    async source => {
      const git = source === 'branch' ? gitForLocal({ head: HEAD_SHA }) : gitForLocal()
      t = await makeTestContext({ git, gh: ghFor42() })
      await publishLocal(t, source)
      const app = createApp(t.ctx)

      const page = await app.request(`/review/${source}`, { headers: LOCAL })
      expect(page.status).toBe(200)
      expect(await page.text()).toContain(`data-pr="${source}"`)

      const bundle = await json<PrBundle>(await app.request(`/api/prs/${source}`, { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.local).toBe(source)
      expect(bundle.skillCommand).toBe(`/pr-review-canvas ${source} --force`)
      expect(bundle.derivable).toBe(true)
      expect(bundle.files.length).toBeGreaterThan(0)
      expect(bundle.comments).toMatchObject({ reviewComments: [], issueComments: [] })
      expect(bundle.capabilities.canComment).toBe(false)
      expect(bundle.artifact?.pr.headSha).toBe(HEAD_SHA)
      // The header's diffstat is counted from the files on screen, never from a cached copy.
      expect(bundle.pr).toMatchObject({
        additions: 8,
        deletions: 5,
        changedFiles: bundle.files.length,
      })
    }
  )

  it('lists the reviews on the home page once they exist, and neither before', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const home = async (): Promise<string> => (await createApp(t.ctx).request('/', { headers: LOCAL })).text()
    expect(await home()).toContain('/pr-review-canvas branch')
    await publishLocal(t, 'uncommitted')
    const listed = await home()
    expect(listed).toContain('href="/review/uncommitted"')
    expect(listed).not.toContain('href="/review/branch"')
  })

  it('offers the skill command when the review has not been prepared yet', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const bundle = await resolveLocalBundle(t.ctx, 'branch', { refresh: false })
    expect(bundle.status).toBe('missing')
    expect(bundle.skillCommand).toBe('/pr-review-canvas branch')
    // With nothing on file the head is resolved from the clone, and `branch` never snapshots.
    expect(bundle.pr).toMatchObject({ baseRef: 'origin/main', headSha: BASE_SHA, state: 'branch' })
  })

  it('snapshots nothing until the uncommitted review has been prepared', async () => {
    const git = gitForLocal()
    t = await makeTestContext({ git, gh: ghFor42() })
    // The screen with no canvas is polled every few seconds, so it must cost no snapshot, no
    // commit, and no derived tree of its own, whatever the working tree holds.
    for (const refresh of [false, true, false]) {
      const bundle = await resolveLocalBundle(t.ctx, 'uncommitted', { refresh })
      expect(bundle.status).toBe('missing')
      expect(bundle.pr.headSha).toBe(BASE_SHA)
    }
    expect(git.calls.some(c => c[0] === 'write-tree')).toBe(false)

    // Once it is prepared, the head is the snapshot again, and a moved tree reads as outdated.
    await publishLocal(t, 'uncommitted')
    expect((await resolveLocalBundle(t.ctx, 'uncommitted', { refresh: true })).pr.headSha).toBe(HEAD_SHA)
  })

  it('resolves the head the review was prepared for, not the other review kind', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await prepare(t.ctx, target('branch'), quiet)
    const bundle = await resolveLocalBundle(t.ctx, 'branch', { refresh: true })
    expect(bundle.pr.headSha).toBe(BASE_SHA)
  })

  it('reports the canvas as outdated once the working tree has moved on', async () => {
    const git = gitForLocal()
    t = await makeTestContext({ git, gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    // A later edit hashes to another commit, so the canvas on screen is for the older one.
    git.options.snapshot = BASE_SHA
    for (const opts of [{ refresh: true }, { refresh: false }]) {
      const bundle = await resolveLocalBundle(t.ctx, 'uncommitted', opts)
      expect(bundle.status).toBe('stale')
      expect(bundle.stale).toMatchObject({ canvasHeadSha: HEAD_SHA, currentHeadSha: BASE_SHA })
    }
    // The poller is the one caller that does not: it answers from the head the page was opened
    // with, so an open tab costs no snapshot of the working tree.
    const polled = await resolveLocalBundle(t.ctx, 'uncommitted', { refresh: false, poll: true })
    expect(polled.status).toBe('ready')
    expect(polled.pr.headSha).toBe(HEAD_SHA)
  })

  it('shows the canvas from its own files when the commits have left the clone', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    // Gone from the clone means neither the stored diffs nor the commits to rebuild them.
    t.ctx.derived.readOrBuild = async () => null
    const bundle = await resolveLocalBundle(t.ctx, 'uncommitted', { refresh: false })
    expect(bundle.status).toBe('ready')
    expect(bundle.derivable).toBe(false)
    expect(bundle.files).toEqual(syntheticArtifact().files)
    expect(bundle.warnings).toContain(
      'the commits behind this canvas are not in the clone; diffs are not available'
    )
  })

  it('says why the chat pane is off, and draws no pane at all when the project turns it off', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    t.ctx.preflight.get = async () => ({ installed: false, version: null })
    const withoutAcpx = await resolveLocalBundle(t.ctx, 'uncommitted', { refresh: false })
    expect(withoutAcpx.chat).toMatchObject({ enabled: false, acpx: false })
    expect(withoutAcpx.warnings).toContain(
      'acpx is not on PATH, so the AI Chat pane is off; install acpx to turn it on'
    )

    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...t.ctx.projectConfig.config, chat: { enabled: false } },
    }
    const chatOff = await resolveLocalBundle(t.ctx, 'uncommitted', { refresh: false })
    expect(chatOff.chat).toEqual({ enabled: false, acpx: false })
  })

  it('keeps the reviewed marks of each review apart from the other and from any PR', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    const app = createApp(t.ctx)
    const put = await app.request('/api/prs/uncommitted/reviewed/layer:l1', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ reviewed: true, headSha: HEAD_SHA }),
    })
    expect(put.status).toBe(200)
    expect(await json(put)).toMatchObject({ prNumber: 'uncommitted' })
    expect((await t.ctx.state.read('uncommitted')).reviewed).toEqual({ 'layer:l1': true })
    expect((await t.ctx.state.read('branch')).reviewed).toEqual({})
    expect((await t.ctx.state.read(42)).reviewed).toEqual({})
  })

  it('refuses a mark keyed to a canvas the review will never show', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    await prepare(t.ctx, target('branch'), quiet)
    // The snapshot's canvas is the uncommitted review's alone: marking against it from the branch
    // review would key that review's marks to a commit its own lookup never returns.
    const put = await createApp(t.ctx).request('/api/prs/branch/reviewed/layer:l1', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ reviewed: true, canvasSha: HEAD_SHA }),
    })
    expect(put.status).toBe(404)
    expect(await json<{ error: { code: string } }>(put)).toMatchObject({
      error: { code: 'CANVAS_NOT_FOUND' },
    })
    expect((await t.ctx.state.read('branch')).reviewed).toEqual({})
  })

  it('answers the routes that need a prepared review, and says which one is missing', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const app = createApp(t.ctx)
    const before = await app.request('/api/prs/branch/patches', { headers: LOCAL })
    expect(before.status).toBe(404)
    expect(await json<{ error: { message: string } }>(before)).toMatchObject({
      error: { code: 'CANVAS_NOT_FOUND', message: expect.stringContaining('no branch review') },
    })

    await publishLocal(t, 'uncommitted')
    const patches = await app.request('/api/prs/uncommitted/patches', { headers: LOCAL })
    expect(patches.status).toBe(200)
    expect(await json<{ headSha: string }>(patches)).toMatchObject({ headSha: HEAD_SHA })
    const context = await app.request('/api/prs/uncommitted/context?path=src/app.ts&side=new&from=1&to=2', {
      headers: LOCAL,
    })
    expect(context.status).toBe(200)
  })

  it('exports a local canvas without stamping a pull request number on the zip', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    const res = await createApp(t.ctx).request('/api/prs/uncommitted/export', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('ref-')
  })

  it('answers the capabilities route without asking the forge anything', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const res = await createApp(t.ctx).request('/api/prs/branch/capabilities', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ canComment: false, login: null })
  })

  it('gives each review its own chat threads', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    const app = createApp(t.ctx)
    const created = await app.request('/api/prs/uncommitted/chat/threads', {
      method: 'POST',
      headers: POST,
    })
    expect(created.status).toBe(201)
    const { thread } = await json<{ thread: { name: string } }>(created)
    expect(thread.name).toContain('-uncommitted-')
    const own = await app.request(
      `/api/prs/uncommitted/chat/threads/${encodeURIComponent(thread.name)}/history`,
      { headers: LOCAL }
    )
    expect(own.status).toBe(200)
    // The name says which review it belongs to, so the others cannot read it.
    for (const other of ['branch', '42']) {
      const res = await app.request(
        `/api/prs/${other}/chat/threads/${encodeURIComponent(thread.name)}/history`,
        { headers: LOCAL }
      )
      expect(res.status).toBe(404)
    }
  })

  it('runs a chat turn against the local canvas, and says so when there is none', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42(), runner: createFakeRunner() })
    const send = async (): Promise<Response> =>
      createApp(t.ctx).request('/api/prs/uncommitted/chat', {
        method: 'POST',
        headers: POST,
        body: JSON.stringify({ message: 'why this layer?', context: { kind: 'pr' } }),
      })
    // Prepared but not published: the diff is there, the canvas the chat would quote is not.
    await prepare(t.ctx, target('uncommitted'), quiet)
    const gone = await send()
    expect(gone.status).toBe(404)
    expect(await json<{ error: { code: string } }>(gone)).toMatchObject({
      error: { code: 'CANVAS_NOT_FOUND' },
    })

    await publishLocal(t, 'uncommitted')
    const ok = await send()
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('text/event-stream')
    await ok.text()
  })

  it('says why the routes that need a pull request cannot answer for local work', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    await publishLocal(t, 'uncommitted')
    const app = createApp(t.ctx)
    for (const path of ['/api/prs/uncommitted/comments', '/api/prs/branch/review/body']) {
      const res = await app.request(path, { headers: LOCAL })
      expect(res.status).toBe(400)
      expect(await json<{ error: { message: string } }>(res)).toMatchObject({
        error: { code: 'BAD_REQUEST', message: expect.stringContaining('needs a pull request') },
      })
    }
  })

  it('refuses the canvas transfer routes, which only a pull request can carry', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const app = createApp(t.ctx)
    for (const path of ['/api/prs/branch/import', '/api/prs/uncommitted/shared-canvas/fetch']) {
      const res = await app.request(path, { method: 'POST', headers: POST })
      expect(res.status).toBe(400)
    }
    const hidden = await app.request('/api/prs/uncommitted/threads/7/hidden', {
      method: 'PUT',
      headers: POST,
      body: JSON.stringify({ hidden: true }),
    })
    expect(hidden.status).toBe(400)
  })

  it('rejects a target that is neither a number nor one of the local reviews', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const app = createApp(t.ctx)
    for (const raw of ['nope', 'local']) {
      expect((await app.request(`/review/${raw}`, { headers: LOCAL })).status).toBe(400)
      expect((await app.request(`/api/prs/${raw}`, { headers: LOCAL })).status).toBe(400)
    }
  })
})
