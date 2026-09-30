// @vitest-environment node
// The tour page, its API, and its scene frames, end to end through Hono.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ErrorEnvelope } from '../contract/api.js'
import type { TourBundle, TourFinishResponse, TourReaderState } from '../contract/tour-api.js'
import { freshReaderState } from '../contract/tour-api.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import { readTourComment } from '../tour/comment.js'
import { prepareTour } from '../tour/prepare.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import {
  ghHandler,
  ghPost,
  ghPostError,
  makeTestContext,
  moveFakeHead,
  type TestContext,
  type TestContextOptions,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_ISSUE_COMMENTS,
  GH_REVIEW_COMMENTS,
  ghFor42,
  gitFor42,
  gitForLocal,
  HEAD_SHA,
  SYNTHETIC_DIFF,
} from '../testing/synthetic.js'
import { syntheticTour, syntheticTourModel } from '../testing/synthetic-tour.js'
import { createApp } from './app.js'
import { sceneFramePolicy } from './security.js'

const LOCAL = { host: '127.0.0.1:3010' }
const WRITE = { ...LOCAL, origin: 'http://127.0.0.1:3010', 'content-type': 'application/json' }
const OTHER_SHA = 'c'.repeat(40)

let t: TestContext
afterEach(() => t?.cleanup())

/** GitHub for PR #42 that accepts the tour comment and lists it afterwards. */
function ghSharing(postRoutes: Record<string, ReturnType<typeof ghPost>> = {}): {
  gh: ReturnType<typeof ghFor42>
  posted: () => Array<Record<string, unknown>>
} {
  const posted: Array<Record<string, unknown>> = []
  const share = ghPost(body => {
    const comment = {
      ...GH_ISSUE_COMMENTS[0],
      ...(body as object),
      id: 6001 + posted.length,
      html_url: `https://github.com/acme/widgets/pull/42#issuecomment-${6001 + posted.length}`,
    }
    posted.push(comment)
    return comment
  })
  return {
    gh: ghFor42({
      routes: {
        'repos/acme/widgets/issues/42/comments': ghHandler(() => [...GH_ISSUE_COMMENTS, ...posted]),
      },
      postRoutes: {
        'repos/acme/widgets/issues/42/comments': share,
        'repos/acme/widgets/issues/comments/6001': share,
        ...postRoutes,
      },
    }),
    posted: () => posted,
  }
}

async function context(extra: Partial<TestContextOptions> = {}): Promise<TestContext> {
  return makeTestContext({ git: gitFor42(), gh: ghFor42(), ...extra })
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function get(route: string): Promise<Response> {
  return createApp(t.ctx).request(route, { headers: LOCAL })
}

async function send(route: string, method: 'PUT' | 'POST', body: unknown): Promise<Response> {
  return createApp(t.ctx).request(route, { method, headers: WRITE, body: JSON.stringify(body) })
}

function settledReader(over: Partial<TourReaderState> = {}): TourReaderState {
  return {
    ...freshReaderState(),
    step: 5,
    picks: { 'sum-over-product': { pick: 'keep', approved: true, place: 'pr' } },
    quiz: { 'q-run': { answered: 1, right: true } },
    notes: { world: 'Rename b later.' },
    ...over,
  }
}

describe('GET /api/tours/:n', () => {
  it('says missing, with the skill command, until a tour is published', async () => {
    t = await context()
    const bundle = await json<TourBundle>(await get('/api/tours/42'))
    expect(bundle).toMatchObject({
      status: 'missing',
      key: 42,
      pr: { number: 42, headSha: HEAD_SHA },
      reviewer: { login: 'octocat', author: true },
      preview: false,
      shares: true,
      skillCommand: '/pr-tour 42',
      options: { finalQuiz: 'on', reverseQuiz: 'on', grill: 'change', audio: 'on' },
    })
    expect(bundle.tour).toBeUndefined()
    expect(bundle.reader.step).toBe(0)
  })

  it('serves the tour without its scene HTML, with the reader state and who is reading', async () => {
    t = await context()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const bundle = await json<TourBundle>(await get('/api/tours/42'))
    expect(bundle.status).toBe('ready')
    expect(bundle.tour?.landmarks.map(l => [l.id, l.scene, l.micro])).toEqual([
      ['before', true, false],
      ['world', true, false],
      ['sum', true, false],
      ['respect', true, false],
    ])
    expect(JSON.stringify(bundle)).not.toContain('<div class="scene">')
    expect(bundle.reviewer).toEqual({ login: 'octocat', author: true })
    expect(bundle.reader).toEqual(freshReaderState())
  })

  it('seeds the author with the picks the record carried, and a reviewer with none', async () => {
    t = await context()
    const [decision] = syntheticTour().decisions
    if (decision === undefined) throw new Error('synthetic tour')
    const restatement = { what: 'w', where: ['x'], unchanged: 'u' }
    await t.ctx.tours.write(
      HEAD_SHA,
      syntheticTour({
        decisions: [
          decision,
          { ...decision, key: 'second' },
          { ...decision, key: 'third' },
          { ...decision, key: 'new' },
        ],
        record: {
          touredBy: [],
          author: {
            finishedAt: '2026-09-01T00:00:00.000Z',
            picks: {
              'sum-over-product': { pick: 'keep', place: 'code' },
              second: { pick: 'change', restatement },
              third: { pick: 'keep' },
              gone: { pick: 'keep' },
            },
            prompt: 'old',
          },
        },
      })
    )
    const author = await json<TourBundle>(await get('/api/tours/42'))
    expect(author.reader.picks).toEqual({
      'sum-over-product': { pick: 'keep', approved: true, place: 'code' },
      second: { pick: 'change', approved: true, restatement },
      third: { pick: 'keep', approved: true },
    })
    await t.cleanup()
    t = await context({
      capabilities: { get: async () => ({ canComment: true, tokenKind: 'x', login: 'reviewer' }) },
    })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const reviewer = await json<TourBundle>(await get('/api/tours/42'))
    expect(reviewer.reviewer).toEqual({ login: 'reviewer', author: false })
    expect(reviewer.reader.picks).toEqual({})
  })

  it('falls back to the newest older tour when the head moved, and says how far', async () => {
    const git = gitFor42()
    t = await context({ git })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    moveFakeHead(git, {
      headRef: 'pull/42/head',
      baseRef: 'refs/pr/42/base',
      headSha: OTHER_SHA,
      mergeBaseSha: BASE_SHA,
      diff: SYNTHETIC_DIFF,
      ahead: { [HEAD_SHA]: 2 },
    })
    const bundle = await json<TourBundle>(await get('/api/tours/42?refresh=1'))
    expect(bundle.status).toBe('stale')
    expect(bundle.stale).toEqual({
      tourHeadSha: HEAD_SHA,
      currentHeadSha: OTHER_SHA,
      relation: 'ancestor',
      commitsBehind: 2,
    })
    expect(bundle.tour?.headSha).toBe(HEAD_SHA)
  })

  it('serves a local review with no login, as its own author, and never shares', async () => {
    t = await context({ git: gitForLocal({ snapshot: null, head: HEAD_SHA }) })
    await t.ctx.prs.writePr('branch', { ...syntheticTour().pr, number: null })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour({ pr: { ...syntheticTour().pr, number: null } }))
    const bundle = await json<TourBundle>(await get('/api/tours/branch'))
    expect(bundle).toMatchObject({
      status: 'ready',
      local: 'branch',
      reviewer: { login: null, author: true },
      shares: false,
      skillCommand: '/pr-tour branch',
    })
  })

  it('refuses a key that is not a review target, and says when a filed tour cannot be read', async () => {
    t = await context()
    expect((await get('/api/tours/nope')).status).toBe(400)
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    // The index files it, and the file is gone.
    await rm(path.join(t.ctx.tours.tourDir(HEAD_SHA), 'tour.json'))
    const res = await get('/api/tours/42')
    expect(res.status).toBe(500)
    expect((await json<ErrorEnvelope>(res)).error.code).toBe('CANVAS_INVALID')
    expect((await get(`/tour-scene/42/world/scene?headSha=${HEAD_SHA}`)).status).toBe(404)
  })
})

describe('GET /api/tours/:n?preview', () => {
  async function prepared(): Promise<{ tourDir: string; scenesDir: string }> {
    const result = await prepareTour(
      t.ctx,
      { kind: 'pr', number: 42 },
      { force: false, log: () => undefined }
    )
    return { tourDir: result.tourDir, scenesDir: result.scenesDir }
  }

  it('reads tour-model.json and the scene files as written, saves nothing, and warns', async () => {
    t = await context()
    const { tourDir, scenesDir } = await prepared()
    const model = syntheticTourModel()
    await writeFile(
      path.join(tourDir, 'tour-model.json'),
      JSON.stringify({ ...model, landmarks: model.landmarks.map(({ scene: _s, ...l }) => l) })
    )
    await mkdir(scenesDir, { recursive: true })
    for (const l of model.landmarks)
      await writeFile(path.join(scenesDir, `${l.id}.scene.html`), l.scene ?? '')
    const bundle = await json<TourBundle>(await get('/api/tours/42?preview=1'))
    expect(bundle.status).toBe('ready')
    expect(bundle.preview).toBe(true)
    expect(bundle.shares).toBe(false)
    expect(bundle.tour?.generator.agent).toBe('preview')
    expect(bundle.tour?.landmarks.map(l => l.scene)).toEqual([true, true, true, true])
    expect(bundle.warnings).toContain('previewing tour-model.json as written: nothing is saved')
    expect(await t.ctx.tours.exists(HEAD_SHA)).toBe(false)
    // The frame reads the model too.
    const frame = await get(`/tour-scene/42/world/scene?preview=1`)
    expect(frame.status).toBe(200)
    expect(await frame.text()).toContain('run() = a() + b()')
  })

  it('reports the problems of a model that does not validate, or does not parse, one line each', async () => {
    t = await context()
    const { tourDir } = await prepared()
    await writeFile(path.join(tourDir, 'tour-model.json'), JSON.stringify({ landmarks: [] }))
    const res = await get('/api/tours/42?preview=1')
    expect(res.status).toBe(422)
    const body = await json<ErrorEnvelope>(res)
    expect(body.error.code).toBe('MODEL_INVALID')
    expect(body.error.issues?.[0]).toMatch(/^SCHEMA /)
    expect((await get('/tour-scene/42/world/scene?preview=1')).status).toBe(422)
    await writeFile(path.join(tourDir, 'tour-model.json'), '{ not json')
    const broken = await json<ErrorEnvelope>(await get('/api/tours/42?preview=1'))
    expect(broken.error.issues?.[0]).toMatch(/^SCHEMA tour-model.json is not valid JSON/)
  })

  it('shows the stored tour when nothing is being written for the head', async () => {
    t = await context()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const bundle = await json<TourBundle>(await get('/api/tours/42?preview=1'))
    expect(bundle.preview).toBe(false)
    expect(bundle.status).toBe('ready')
  })

  it('says missing in preview when neither the model nor a tour exists', async () => {
    t = await context()
    expect((await json<TourBundle>(await get('/api/tours/42?preview=1'))).status).toBe('missing')
    expect((await get('/tour-scene/42/world/scene?preview=1')).status).toBe(404)
  })
})

describe('PUT /api/tours/:n/reader', () => {
  it('saves the reader state beside the tour and serves it back with the bundle', async () => {
    t = await context()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const reader = settledReader()
    const res = await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader })
    expect(res.status).toBe(200)
    expect(await json<TourReaderState>(res)).toEqual(reader)
    expect((await json<TourBundle>(await get('/api/tours/42'))).reader).toEqual(reader)
    expect(
      JSON.parse(await readFile(path.join(t.ctx.tours.tourDir(HEAD_SHA), 'reader.json'), 'utf8'))
    ).toEqual(reader)
  })

  it('refuses a body for another commit, a missing tour, and a malformed state', async () => {
    t = await context()
    expect((await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: {} })).status).toBe(404)
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const stale = await send('/api/tours/42/reader', 'PUT', { headSha: OTHER_SHA, reader: {} })
    expect(stale.status).toBe(409)
    expect((await json<ErrorEnvelope>(stale)).error.code).toBe('CANVAS_STALE')
    const bad = await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: { step: -1 } })
    expect(bad.status).toBe(400)
  })

  it('keeps a finish a later save leaves out', async () => {
    t = await context({ gh: ghSharing().gh })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    const saved = await json<TourReaderState>(
      await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader({ step: 2 }) })
    )
    expect(saved.step).toBe(2)
    expect(saved.finished?.prompt).toContain('# Keep PR #42')
  })
})

describe('POST /api/tours/:n/finish', () => {
  it('writes the prompt, records the author with their picks, shares the record once, and marks the reader finished', async () => {
    const sharing = ghSharing()
    // Nothing fakes the inline post here: the reason is not posted, and the finish says so.
    t = await context({ gh: sharing.gh })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const res = await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    expect(res.status).toBe(200)
    const body = await json<TourFinishResponse>(res)
    const promptPath = path.join(t.ctx.tours.tourDir(HEAD_SHA), 'prompt.md')
    expect(body.finished).toEqual({
      at: '2026-09-10T12:00:00.000Z',
      promptPath,
      prompt: expect.stringContaining('- sum-over-product: Sum. Sum is what the spec says.'),
      sharing: { status: 'shared', url: 'https://github.com/acme/widgets/pull/42#issuecomment-6001' },
      posted: 0,
      warnings: [expect.stringContaining('The reason for "Sum over product?" was not posted')],
    })
    expect(await readFile(promptPath, 'utf8')).toBe(`${body.finished.prompt}\n`)
    expect(body.record).toEqual({
      touredBy: [{ login: 'octocat', at: '2026-09-10T12:00:00.000Z' }],
      author: {
        finishedAt: '2026-09-10T12:00:00.000Z',
        picks: { 'sum-over-product': { pick: 'keep', place: 'pr' } },
        prompt: body.finished.prompt,
      },
    })
    expect(body.reader.finished).toEqual(body.finished)
    // The stored tour carries the record and the revision time; the comment carries the record.
    const stored = await t.ctx.tours.read(HEAD_SHA)
    expect(stored?.record).toEqual(body.record)
    expect(stored?.revisedAt).toBe('2026-09-10T12:00:00.000Z')
    expect(sharing.posted()).toHaveLength(1)
    const posted = String(sharing.posted()[0]?.['body'])
    expect(readTourComment(posted)?.name).toMatch(/-tour\.zip$/)
    expect(posted).toContain('octocat')
    // Finishing again lists the reader once and updates the same comment.
    await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    expect((await t.ctx.tours.read(HEAD_SHA))?.record.touredBy).toHaveLength(1)
    expect(sharing.posted()).toHaveLength(2)
  })

  it('records a reviewer without picks, and reports a failed share with the exported zip', async () => {
    t = await context({
      gh: ghFor42({
        postRoutes: { 'repos/acme/widgets/issues/42/comments': ghPostError(new Error('boom')) },
      }),
      capabilities: { get: async () => ({ canComment: true, tokenKind: 'x', login: 'reviewer' }) },
    })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const body = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(body.record.author).toBeUndefined()
    expect(body.record.touredBy).toEqual([{ login: 'reviewer', at: '2026-09-10T12:00:00.000Z' }])
    expect(body.finished.sharing).toMatchObject({
      status: 'failed',
      zipPath: expect.stringMatching(/-tour\.zip$/),
    })
  })

  it('does not share when the setting says so, nor for a local review', async () => {
    t = await context()
    // The personal sharing keys are edited by hand in the settings file, never by the page.
    await writeTextAtomic(t.ctx.settings.file, 'tourComment: false\n')
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const pr = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(pr.finished.sharing).toEqual({ status: 'off' })
    await t.cleanup()
    t = await context({ git: gitForLocal({ snapshot: null, head: HEAD_SHA }) })
    await t.ctx.prs.writePr('branch', { ...syntheticTour().pr, number: null })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour({ pr: { ...syntheticTour().pr, number: null } }))
    await send('/api/tours/branch/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const local = await json<TourFinishResponse>(
      await send('/api/tours/branch/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(local.finished.sharing).toEqual({ status: 'local' })
    expect(local.record.touredBy).toEqual([])
    expect(local.finished.prompt).toContain('# Keep the branch change')
  })

  it('refuses while a decision is open, or while the quiz is required and unanswered', async () => {
    t = await context()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const open = await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    expect(open.status).toBe(409)
    expect((await json<ErrorEnvelope>(open)).error.message).toBe(
      '1 decision is not settled: Sum over product?'
    )
    await t.cleanup()
    t = await context({
      projectConfig: {
        config: {
          ...DEFAULT_PROJECT_CONFIG,
          tour: { ...DEFAULT_PROJECT_CONFIG.tour, finalQuiz: 'required' },
        },
        warnings: [],
        source: null,
      },
    })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader({ quiz: {} }) })
    const quiz = await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    expect(quiz.status).toBe(409)
    expect((await json<ErrorEnvelope>(quiz)).error.message).toBe('1 quiz question still to answer right')
    expect((await send('/api/tours/42/finish', 'POST', { headSha: OTHER_SHA })).status).toBe(409)
  })
})

describe('GET /tour-scene/:n/:landmark/:kind', () => {
  it('draws the scene in a sandboxed frame with the kit, the runtime, and its icons inlined', async () => {
    t = await context()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const res = await get(`/tour-scene/42/world/scene?headSha=${HEAD_SHA}&skin=olive&theme=dark`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(sceneFramePolicy())
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('data-skin="olive" data-theme="dark"')
    expect(html).toContain('.scene-root')
    expect(html).toContain("postMessage({ scene: 'size', height }")
    expect(html).toContain('<svg')
    expect(html).not.toContain('data-icon')
    expect(html).toContain('run() = a() + b()')
  })

  it('draws the terminal skin as github, and refuses what it cannot name', async () => {
    t = await context()
    await t.ctx.settings.write({ skin: 'terminal' })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    expect(await (await get(`/tour-scene/42/world/scene?headSha=${HEAD_SHA}`)).text()).toContain(
      'data-skin="github"'
    )
    expect((await get(`/tour-scene/42/world/movie?headSha=${HEAD_SHA}`)).status).toBe(400)
    expect((await get('/tour-scene/42/world/scene')).status).toBe(400)
    expect((await get(`/tour-scene/42/world/micro?headSha=${HEAD_SHA}`)).status).toBe(404)
    expect((await get(`/tour-scene/42/nope/scene?headSha=${HEAD_SHA}`)).status).toBe(404)
    expect((await get(`/tour-scene/42/world/scene?headSha=${OTHER_SHA}`)).status).toBe(404)
    expect((await get(`/tour-scene/7/world/scene?headSha=${HEAD_SHA}`)).status).toBe(404)
    expect((await get(`/tour-scene/nope/world/scene?headSha=${HEAD_SHA}`)).status).toBe(400)
    // An error in a frame is the envelope, never a page.
    const missing = await get(`/tour-scene/42/nope/scene?headSha=${HEAD_SHA}`)
    expect((await json<ErrorEnvelope>(missing)).error.code).toBe('NOT_FOUND')
  })
})

describe('GET /tour/:n and the home page', () => {
  it('renders the tour shell with its own module and bootstrap, and frames allowed', async () => {
    t = await context()
    const res = await get('/tour/42?preview&landmark=world')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("frame-src 'self'")
    const html = await res.text()
    expect(html).toContain('<pr-tour class="page tour-page" data-pr="42">')
    expect(html).toContain('<script type="module" src="/static/js/tour/tour.js"></script>')
    expect(html).not.toContain('<link rel="modulepreload" href="/vendor/')
    expect(html).toContain(
      '{"key":42,"owner":"acme","repo":"widgets","version":"0.0.0-test","host":{"kind":"github","label":"GitHub","webBase":"https://github.com"},"preview":true,"landmark":"world"}</script>'
    )
    expect(html).toContain('<title>Tour · PR #42 · acme/widgets</title>')
    const local = await (await get('/tour/branch')).text()
    expect(local).toContain('"key":"branch"')
    expect(local).toContain('"preview":false}')
    expect(local).toContain('Loading the tour of Branch review')
    expect((await get('/tour/nope')).status).toBe(400)
  })

  it('draws the terminal skin as github on the tour page alone', async () => {
    t = await context()
    await t.ctx.settings.write({ skin: 'terminal' })
    expect(await (await get('/tour/42')).text()).toContain('data-skin="github"')
    expect(await (await get('/tour/42?skin=olive')).text()).toContain('data-skin="olive"')
    expect(await (await get('/review/42')).text()).toContain('data-skin="terminal"')
  })

  it('links the home page to the tours that exist', async () => {
    t = await context()
    const app = createApp(t.ctx)
    await app.request('/api/prs/42', { headers: LOCAL })
    const before = await (await get('/')).text()
    expect(before).not.toContain('href="/tour/42"')
    expect(before).toContain('/pr-tour &lt;number&gt;')
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    await t.ctx.tours.write(
      OTHER_SHA,
      syntheticTour({ headSha: OTHER_SHA, pr: { ...syntheticTour().pr, number: null } })
    )
    await t.ctx.prs.writePr('branch', { ...syntheticTour().pr, number: null })
    const after = await (await get('/')).text()
    expect(after).toContain('href="/tour/42"')
    expect(after).toContain('href="/tour/branch"')
  })
})

describe('the grilling routes', () => {
  const CHAT_ON = {
    config: { ...DEFAULT_PROJECT_CONFIG, chat: { ...DEFAULT_PROJECT_CONFIG.chat, enabled: true } },
    warnings: [],
    source: null,
  }
  const RESTATEMENT =
    '```restatement\n{ "what": "Multiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }\n```'

  async function grill(body: unknown): Promise<Response> {
    return createApp(t.ctx).request('/api/tours/42/grill', {
      method: 'POST',
      headers: { ...WRITE, accept: 'text/event-stream' },
      body: JSON.stringify(body),
    })
  }

  it('grills in the tour thread with the tour seed, streams the answer, and keeps the transcript', async () => {
    const runner = createFakeRunner({
      script: [
        { type: 'chunk', text: 'Thanks. ' },
        { type: 'chunk', text: RESTATEMENT },
        { type: 'done', stopReason: 'end_turn' },
      ],
    })
    t = await context({ projectConfig: CHAT_ON, runner })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    expect((await json<TourBundle>(await get('/api/tours/42'))).chat).toEqual({
      enabled: true,
      acpx: true,
      agent: 'claude',
      model: null,
    })
    const res = await grill({
      message: 'I want to change this',
      context: { kind: 'tour-decision', key: 'sum-over-product' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const body = await res.text()
    expect(body).toContain('event: turn')
    expect(body).toContain('"thread":"pr-review-acme-widgets-42-claude-t0"')
    expect(body).toContain('Multiply.')
    expect(body).toContain('event: done')
    const prompt = runner.runs[0]?.prompt ?? ''
    expect(prompt).toContain('# Grilling a change with the reader of a tour')
    expect(prompt).toContain('## Context: decision `sum-over-product` — Sum over product?')
    expect(prompt).toContain('## Question\n\nI want to change this')
    const history = await json<{ name: string; turns: Array<{ role: string; text: string }> }>(
      await get('/api/tours/42/grill/history')
    )
    expect(history.name).toBe('pr-review-acme-widgets-42-claude-t0')
    expect(history.turns.map(turn => turn.role)).toEqual(['user', 'assistant'])
    expect(history.turns[1]?.text).toContain(RESTATEMENT)
    expect(await json<{ cancelled: boolean }>(await send('/api/tours/42/grill/cancel', 'POST', {}))).toEqual({
      cancelled: false,
    })
  })

  it('refuses without chat, without a tour, with a canvas context, and answers an unknown decision as a refusal', async () => {
    t = await context({
      projectConfig: {
        config: { ...DEFAULT_PROJECT_CONFIG, chat: { ...DEFAULT_PROJECT_CONFIG.chat, enabled: false } },
        warnings: [],
        source: null,
      },
    })
    expect((await grill({ message: 'x', context: { kind: 'tour-plan' } })).status).toBe(404)
    expect((await get('/api/tours/42/grill/history')).status).toBe(404)
    expect((await send('/api/tours/42/grill/cancel', 'POST', {})).status).toBe(404)
    await t.cleanup()
    t = await context({ projectConfig: CHAT_ON })
    const missing = await grill({ message: 'x', context: { kind: 'tour-plan' } })
    expect(missing.status).toBe(404)
    expect((await json<ErrorEnvelope>(missing)).error.code).toBe('CANVAS_NOT_FOUND')
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    expect((await grill({ message: 'x', context: { kind: 'pr' } })).status).toBe(400)
    const unknown = await grill({ message: 'x', context: { kind: 'tour-decision', key: 'nope' } })
    expect(unknown.status).toBe(400)
    expect((await json<ErrorEnvelope>(unknown)).error.message).toBe('this tour has no decision nope')
    expect(await json<{ name: string; turns: unknown[] }>(await get('/api/tours/42/grill/history'))).toEqual({
      name: 'pr-review-acme-widgets-42-claude-t0',
      turns: [],
    })
  })
})

describe('finishing on the pull request', () => {
  const POSTED = ghPost(body => ({
    ...GH_REVIEW_COMMENTS[0],
    ...(body as Record<string, unknown>),
    id: 5001,
    html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
  }))

  it("posts the author's kept reasons that belong on the pull request, once each", async () => {
    const posted: unknown[] = []
    const sharing = ghSharing({
      'repos/acme/widgets/pulls/42/comments': ghPost(body => {
        posted.push(body)
        return {
          ...GH_REVIEW_COMMENTS[0],
          ...(body as Record<string, unknown>),
          id: 5001,
          html_url: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
        }
      }),
    })
    t = await context({ gh: sharing.gh })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    // The line is checked against the head's diff, which the bundle route builds.
    await get('/api/prs/42')
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const first = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(first.finished.posted).toBe(1)
    expect(first.finished.queued).toBeUndefined()
    expect(first.record.author?.picks['sum-over-product']).toEqual({
      pick: 'keep',
      place: 'pr',
      commentUrl: 'https://github.com/acme/widgets/pull/42#discussion_r5001',
    })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ path: 'src/app.ts', line: 4, side: 'RIGHT' })
    expect(String((posted[0] as Record<string, unknown>)['body'])).toContain('**Kept in the tour:** Sum')
    // Finishing again posts nothing new and keeps the comment.
    const again = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(again.finished.posted).toBe(0)
    expect(again.record.author?.picks['sum-over-product']?.commentUrl).toContain('discussion_r5001')
    expect(posted).toHaveLength(1)
  })

  it("queues a reviewer's approved changes in their pending review, once each", async () => {
    t = await context({
      gh: ghFor42({ postRoutes: { 'repos/acme/widgets/pulls/42/comments': POSTED } }),
      capabilities: { get: async () => ({ canComment: true, tokenKind: 'x', login: 'reviewer' }) },
    })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const changed = settledReader({
      picks: {
        'sum-over-product': {
          pick: 'change',
          approved: true,
          restatement: { what: 'Multiply.', where: ['src/app.ts:4'], unchanged: 'Callers.' },
        },
      },
    })
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: changed })
    const first = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(first.finished.queued).toBe(1)
    expect(first.finished.posted).toBeUndefined()
    const pending = (await t.ctx.state.read(42)).pending
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      proposalFingerprint: 'tour:sum-over-product',
      headSha: HEAD_SHA,
    })
    expect(pending[0]?.body).toContain('**Change requested in the tour:** Sum over product?')
    expect(pending[0]?.body).toContain('Stays the same: Callers.')
    const again = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(again.finished.queued).toBe(0)
    expect((await t.ctx.state.read(42)).pending).toHaveLength(1)
  })

  it('posts nothing from the tour of an older commit', async () => {
    const git = gitFor42()
    t = await context({ git })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    moveFakeHead(git, {
      headRef: 'pull/42/head',
      baseRef: 'refs/pr/42/base',
      headSha: OTHER_SHA,
      mergeBaseSha: BASE_SHA,
      diff: SYNTHETIC_DIFF,
      ahead: { [HEAD_SHA]: 1 },
    })
    await get('/api/tours/42?refresh=1')
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    const body = await json<TourFinishResponse>(
      await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    )
    expect(body.finished.posted).toBeUndefined()
    expect(body.finished.queued).toBeUndefined()
  })
})

describe('pr-review tour plan', () => {
  async function plan(...argv: string[]): Promise<Record<string, unknown>> {
    const out: string[] = []
    const { runTour } = await import('../tour/commands.js')
    await runTour(t.ctx, ['plan', ...argv], { stdout: l => out.push(l), stderr: () => undefined, json: true })
    return JSON.parse(out.at(-1) ?? '{}') as Record<string, unknown>
  }

  it('prints the confirmed plan for the apply skill, or says the tour is not finished', async () => {
    t = await context()
    await writeTextAtomic(t.ctx.settings.file, 'tourComment: false\n')
    const { runTour } = await import('../tour/commands.js')
    await expect(
      runTour(t.ctx, ['plan', '--pr', '42'], { stdout: () => undefined, stderr: () => undefined, json: true })
    ).rejects.toThrow('no tour of 42')
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    expect(await plan('--pr', '42')).toEqual({
      status: 'unfinished',
      headSha: HEAD_SHA,
      tourDir: t.ctx.tours.tourDir(HEAD_SHA),
      tourUrl: 'http://localhost:3010/tour/42',
    })
    await send('/api/tours/42/reader', 'PUT', { headSha: HEAD_SHA, reader: settledReader() })
    await send('/api/tours/42/finish', 'POST', { headSha: HEAD_SHA })
    const done = await plan('--pr', '42')
    expect(done).toMatchObject({
      status: 'finished',
      headSha: HEAD_SHA,
      promptPath: path.join(t.ctx.tours.tourDir(HEAD_SHA), 'prompt.md'),
      finishedAt: '2026-09-10T12:00:00.000Z',
      changes: 0,
      kept: 1,
      stale: false,
    })
    expect(String(done['prompt'])).toContain('# Keep PR #42')
    await expect(plan('--base', 'x', '--head', 'y')).rejects.toThrow()
  })

  it('reads a local review by its key', async () => {
    t = await context({ git: gitForLocal({ snapshot: null, head: HEAD_SHA }) })
    await t.ctx.prs.writePr('branch', { ...syntheticTour().pr, number: null })
    await t.ctx.tours.write(HEAD_SHA, syntheticTour({ pr: { ...syntheticTour().pr, number: null } }))
    expect(await plan('--branch')).toMatchObject({
      status: 'unfinished',
      tourUrl: 'http://localhost:3010/tour/branch',
    })
  })
})
