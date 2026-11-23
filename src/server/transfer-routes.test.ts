// @vitest-environment node
// The three transfer routes and the two bundle paths they feed: a stale canvas and a canvas
// discovered on the pull request.
import { buildCanvasComment } from '../canvas/comment.js'
import type { CanvasTally } from '../review/self-review.js'
import { buildCanvasZip, CANVAS_ZIP_MAX_BYTES, readCanvasZip } from '../canvas/zip.js'
import type { ImportResult, PrBundle, SharedCanvasFetchResponse } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import {
  createFakeGit,
  createFakeGh,
  ghJson,
  type FakeGitOptions,
  type FakeGhOptions,
  makeTestContext,
  TEST_REPO,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_ISSUE_COMMENTS,
  GH_PULL,
  GH_REVIEW_COMMENTS,
  GH_THREADS_PAGE,
  HEAD_SHA,
  SYNTHETIC_BLOBS,
  SYNTHETIC_DIFF,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { createApp } from './app.js'

const NO_POINTS: CanvasTally = { reviewer: { decide: 0, check: 0, fyi: 0 }, authorOpen: 0, settled: 0 }
const LOCAL = { host: 'localhost:3010' }
const SAME_ORIGIN = { ...LOCAL, origin: 'http://localhost:3010', 'sec-fetch-site': 'same-origin' }
const OLD_SHA = 'e'.repeat(40)
const FILE_URL =
  'https://github.com/user-attachments/files/12345/pr-42-20260910T110000Z-eeeeeeee-acme-widgets-canvas.zip'

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function manifest(headSha: string): CanvasManifest {
  return {
    formatVersion: 1,
    tool: { name: 'pr-review', version: '0.1.0' },
    repo: TEST_REPO,
    prNumber: 42,
    headSha,
    mergeBaseSha: BASE_SHA,
    baseRef: 'main',
    headRef: 'feat/b',
    generatedAt: '2026-09-10T11:00:00.000Z',
    generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
  }
}

function artifactFor(headSha: string): ReviewArtifact {
  const base = syntheticArtifact()
  return { ...base, pr: { ...base.pr, headSha }, generatedAt: '2026-09-10T11:00:00.000Z' }
}

/** The older commit changed a different file, so its patches cannot be confused with the head's. */
const OLD_DIFF = [
  'diff --git a/src/old-only.ts b/src/old-only.ts',
  'index 1111111..2222222 100644',
  '--- a/src/old-only.ts',
  '+++ b/src/old-only.ts',
  '@@ -1,2 +1,2 @@',
  '-export const version = 1',
  '+export const version = 2',
  ' export const keep = true',
  '',
].join('\n')

/** PR #42 whose head is HEAD_SHA, with OLD_SHA one commit behind it. */
function gitWithHistory(extra: FakeGitOptions = {}) {
  return createFakeGit({
    refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA, old: OLD_SHA },
    mergeBases: { [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA, [`${BASE_SHA}..${OLD_SHA}`]: BASE_SHA },
    diffs: { [`${BASE_SHA}..${HEAD_SHA}`]: SYNTHETIC_DIFF, [`${BASE_SHA}..${OLD_SHA}`]: OLD_DIFF },
    blobs: SYNTHETIC_BLOBS,
    ancestors: { [`${OLD_SHA}..${HEAD_SHA}`]: true },
    counts: { [`${OLD_SHA}..${HEAD_SHA}`]: 1 },
    topLevel: '/repo',
    ...extra,
  })
}

function ghWithBody(body: string) {
  return {
    routes: {
      'repos/acme/widgets/pulls/42': { kind: 'json' as const, body: { ...GH_PULL, body } },
      'repos/acme/widgets/pulls/42/comments': { kind: 'json' as const, body: GH_REVIEW_COMMENTS },
      'repos/acme/widgets/pulls/42/reviews': { kind: 'json' as const, body: [] },
      'repos/acme/widgets/issues/42/comments': { kind: 'json' as const, body: GH_ISSUE_COMMENTS },
    },
    graphql: [GH_THREADS_PAGE, GH_THREADS_PAGE, GH_THREADS_PAGE, GH_THREADS_PAGE],
  }
}

/** A fetch that always answers with the same body. */
function alwaysFetch(make: () => Response): { impl: typeof fetch; count: () => number } {
  let count = 0
  return {
    impl: async () => {
      count++
      return make()
    },
    count: () => count,
  }
}

describe('transfer routes', () => {
  let t: TestContext
  afterEach(async () => {
    await t?.cleanup()
  })

  async function contextFor(body = 'no attachment here', fetchImpl?: typeof fetch): Promise<TestContext> {
    const opts: Parameters<typeof makeTestContext>[0] = {
      git: gitWithHistory(),
      gh: createFakeGh(ghWithBody(body)),
    }
    if (fetchImpl !== undefined) {
      opts.fetch = fetchImpl
    }
    return makeTestContext(opts)
  }

  describe('GET /api/prs/:n/export', () => {
    it('sends the zip of the current canvas with a canvas file name', async () => {
      t = await contextFor()
      await t.ctx.canvases.write(HEAD_SHA, artifactFor(HEAD_SHA), manifest(HEAD_SHA))
      const res = await createApp(t.ctx).request('/api/prs/42/export', { headers: LOCAL })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
      expect(res.headers.get('content-disposition')).toBe(
        'attachment; filename="pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip"'
      )
      const read = readCanvasZip(new Uint8Array(await res.arrayBuffer()))
      expect(read.artifact).toEqual(artifactFor(HEAD_SHA))
    })

    it('exports the canvas of another head when asked, and refuses a bad sha', async () => {
      t = await contextFor()
      await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA))
      const res = await createApp(t.ctx).request(`/api/prs/42/export?headSha=${OLD_SHA}`, { headers: LOCAL })
      expect(res.headers.get('content-disposition')).toContain(
        'pr-42-20260910T110000Z-eeeeeeee-acme-widgets-canvas.zip'
      )
      const bad = await createApp(t.ctx).request('/api/prs/42/export?headSha=nope', { headers: LOCAL })
      expect(bad.status).toBe(400)
    })

    it('answers CANVAS_NOT_FOUND when the PR has no canvas at all', async () => {
      t = await contextFor()
      const res = await createApp(t.ctx).request('/api/prs/42/export', { headers: LOCAL })
      expect(res.status).toBe(404)
      expect(await json<{ error: { code: string } }>(res)).toMatchObject({
        error: { code: 'CANVAS_NOT_FOUND' },
      })
    })
  })

  describe('POST /api/prs/:n/import', () => {
    function upload(bytes: Uint8Array, extra: Record<string, string> = {}): FormData {
      const form = new FormData()
      form.append('file', new File([bytes.slice().buffer as ArrayBuffer], 'canvas.zip'))
      for (const [k, v] of Object.entries(extra)) {
        form.append(k, v)
      }
      return form
    }

    it('stores an uploaded canvas and answers with its status', async () => {
      t = await contextFor()
      const res = await createApp(t.ctx).request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))),
      })
      expect(res.status).toBe(200)
      expect(await json<ImportResult>(res)).toEqual({
        status: 'ready',
        headSha: HEAD_SHA,
        currentHeadSha: HEAD_SHA,
        derivable: true,
        warnings: [],
      })
    })

    it('answers 400 CANVAS_INVALID with the issues, and 400 CANVAS_REPO_MISMATCH without force', async () => {
      t = await contextFor()
      const app = createApp(t.ctx)
      const invalid = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(new Uint8Array([1, 2, 3])),
      })
      expect(invalid.status).toBe(400)
      expect(await json<{ error: { code: string; hint: string; issues: string[] } }>(invalid)).toEqual({
        error: {
          code: 'CANVAS_INVALID',
          message: 'this file is not a zip',
          hint: 'the file does not start with the zip signature',
          issues: ['the file does not start with the zip signature'],
        },
      })
      const foreign = buildCanvasZip(
        { ...manifest(HEAD_SHA), repo: { owner: 'other', name: 'repo' } },
        artifactFor(HEAD_SHA)
      )
      const mismatch = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(foreign),
      })
      expect(mismatch.status).toBe(400)
      expect(await json<{ error: { code: string } }>(mismatch)).toMatchObject({
        error: { code: 'CANVAS_REPO_MISMATCH' },
      })
      const forced = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(foreign, { force: '1' }),
      })
      expect(forced.status).toBe(200)
    })

    it('answers 400 CANVAS_PR_MISMATCH for a canvas of another pull request, force or not', async () => {
      t = await contextFor()
      const app = createApp(t.ctx)
      const otherPr = buildCanvasZip(
        { ...manifest(HEAD_SHA), prNumber: 7 },
        {
          ...artifactFor(HEAD_SHA),
          pr: { ...artifactFor(HEAD_SHA).pr, number: 7 },
        }
      )
      const refused = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(otherPr),
      })
      expect(refused.status).toBe(400)
      expect(await json<{ error: { code: string; hint: string } }>(refused)).toEqual({
        error: {
          code: 'CANVAS_PR_MISMATCH',
          message: 'this canvas was exported for #7, and it is being imported for #42',
          hint: 'import it without --pr to store it under #7, or generate a canvas for #42',
        },
      })
      expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
      const forced = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(otherPr, { force: '1' }),
      })
      expect(forced.status).toBe(400)
      expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    })

    it('rejects a file over the ZIP limit even when the multipart envelope is within its limit', async () => {
      t = await contextFor()
      const res = await createApp(t.ctx).request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: upload(new Uint8Array(CANVAS_ZIP_MAX_BYTES + 1)),
      })
      expect(res.status).toBe(413)
      expect(await res.json()).toMatchObject({ error: { code: 'CANVAS_TOO_LARGE' } })
    })

    it('refuses a body that is not multipart, and one that grows past the cap while streaming', async () => {
      t = await contextFor()
      const app = createApp(t.ctx)
      const notForm = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(notForm.status).toBe(400)
      // A body with no declared length that keeps coming is stopped while it is read.
      let sent = 0
      const endless = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1
          controller.enqueue(new Uint8Array(1024 * 1024))
        },
      })
      const streamed = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'content-type': 'multipart/form-data; boundary=x' },
        body: endless,
        // @ts-expect-error duplex is required for a streamed request body and is not in the DOM types
        duplex: 'half',
      })
      expect(streamed.status).toBe(413)
      expect(sent).toBeLessThan(64)
    })

    it('answers 413 for an upload past the size cap and 400 without a file field', async () => {
      t = await contextFor()
      const app = createApp(t.ctx)
      const big = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: { ...SAME_ORIGIN, 'content-length': String(64 * 1024 * 1024) },
        body: upload(new Uint8Array([1])),
      })
      expect(big.status).toBe(413)
      expect(await json<{ error: { code: string } }>(big)).toMatchObject({
        error: { code: 'CANVAS_TOO_LARGE' },
      })
      const noFile = await app.request('/api/prs/42/import', {
        method: 'POST',
        headers: SAME_ORIGIN,
        body: new FormData(),
      })
      expect(noFile.status).toBe(400)
    })
  })

  describe('bundle with a stale canvas', () => {
    it('rebuilds the stale canvas diffs when the clone has its commits but no cache', async () => {
      t = await contextFor()
      await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA))
      // Nothing under derived/ for that commit: the bundle builds it from the local clone.
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('stale')
      expect(bundle.derivable).toBe(true)
      expect(bundle.files.map(f => f.path)).toEqual(['src/old-only.ts'])
    })

    it('keeps an imported stale canvas readable when its commits are absent from the clone', async () => {
      t = await makeTestContext({
        git: gitWithHistory({
          refs: { 'pull/42/head': HEAD_SHA, 'refs/heads/main': BASE_SHA, main: BASE_SHA },
          ancestors: {},
        }),
        gh: createFakeGh(ghWithBody('no attachment here')),
      })
      await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA))
      const res = await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL })
      expect(res.status).toBe(200)
      const bundle = await json<PrBundle>(res)
      expect(bundle.status).toBe('stale')
      expect(bundle.files).toEqual(artifactFor(OLD_SHA).files)
      expect(bundle.artifact).toEqual(artifactFor(OLD_SHA))
      expect(bundle.stale).not.toHaveProperty('commitsBehind')
    })

    it('reports stale with the distance, carries the old artifact, and serves its patches', async () => {
      t = await contextFor()
      await t.ctx.canvases.write(OLD_SHA, artifactFor(OLD_SHA), manifest(OLD_SHA))
      await t.ctx.derived.ensure({ headSha: OLD_SHA, mergeBaseSha: BASE_SHA })
      const app = createApp(t.ctx)
      const bundle = await json<PrBundle>(await app.request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('stale')
      expect(bundle.stale).toEqual({
        canvasHeadSha: OLD_SHA,
        currentHeadSha: HEAD_SHA,
        relation: 'ancestor',
        commitsBehind: 1,
      })
      expect(bundle.artifact).toEqual(artifactFor(OLD_SHA))
      expect(bundle.skillCommand).toBe('/pr-review-canvas 42')
      // The files and the diffs describe the canvas's own commit, not today's head.
      expect(bundle.files.map(f => f.path)).toEqual(['src/old-only.ts'])
      expect(bundle.derivable).toBe(true)
      const patches = await json<{ headSha: string; patches: Record<string, string> }>(
        await app.request(`/api/prs/42/patches?headSha=${OLD_SHA}`, { headers: LOCAL })
      )
      expect(patches.headSha).toBe(OLD_SHA)
      expect(Object.keys(patches.patches)).toEqual(['src_old_only_ts'])
      expect(Object.values(patches.patches)[0]).toContain('export const version = 2')
      const current = await json<{ headSha: string; patches: Record<string, string> }>(
        await app.request('/api/prs/42/patches', { headers: LOCAL })
      )
      expect(Object.keys(current.patches)).toContain('src_app_ts')
    })
  })

  describe('shared canvas discovery', () => {
    function zipResponse(bytes: Uint8Array): Response {
      return new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
    }

    it('imports the attachment named in the PR body and reports ready', async () => {
      const bytes = buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))
      const fetches = alwaysFetch(() => zipResponse(bytes))
      t = await contextFor(`canvas: ${FILE_URL}`, fetches.impl)
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.canvas?.source).toBe('import')
      expect(bundle.sharedCanvas).toEqual({
        url: FILE_URL,
        name: 'pr-42-20260910T110000Z-eeeeeeee-acme-widgets-canvas.zip',
        namesHead: false,
        downloadable: true,
      })
    })

    it('scans once for the same PR text and again when the caller asks', async () => {
      const fetches = alwaysFetch(() => new Response('', { status: 404 }))
      t = await contextFor(`canvas: ${FILE_URL}`, fetches.impl)
      const app = createApp(t.ctx)
      const first = await json<PrBundle>(await app.request('/api/prs/42', { headers: LOCAL }))
      expect(first.sharedCanvas?.downloadable).toBe(false)
      expect(first.sharedCanvas?.reason).toBe('auth-required')
      await app.request('/api/prs/42', { headers: LOCAL })
      expect(fetches.count()).toBe(1)
      await app.request('/api/prs/42?refresh=1', { headers: LOCAL })
      expect(fetches.count()).toBe(2)
    })

    it('re-runs discovery on demand and says whether it imported anything', async () => {
      const bytes = buildCanvasZip(manifest(HEAD_SHA), artifactFor(HEAD_SHA))
      let answer = new Response('', { status: 404 })
      t = await contextFor(`canvas: ${FILE_URL}`, async () => answer)
      const app = createApp(t.ctx)
      await app.request('/api/prs/42', { headers: LOCAL })
      answer = new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 })
      const res = await app.request('/api/prs/42/shared-canvas/fetch', {
        method: 'POST',
        headers: SAME_ORIGIN,
      })
      expect(res.status).toBe(200)
      const body = await json<SharedCanvasFetchResponse>(res)
      expect(body.imported).toBe(true)
      expect(body.status).toBe('ready')
      expect(body.sharedCanvas?.downloadable).toBe(true)
    })

    it('refresh imports a newer compressed canvas for the same head', async () => {
      const previous = artifactFor(HEAD_SHA)
      const updated = { ...previous, generatedAt: '2026-09-11T12:00:00.000Z', summary: 'Updated explanation' }
      const body = buildCanvasComment(
        {
          name: `pr-42-20260911T120000Z-${HEAD_SHA.slice(0, 8)}-acme-widgets-canvas.zip`,
          headSha: HEAD_SHA,
          prNumber: 42,
          bytes: buildCanvasZip({ ...manifest(HEAD_SHA), generatedAt: updated.generatedAt }, updated),
        },
        NO_POINTS,
        65_536
      )
      t = await contextFor()
      const options: FakeGhOptions = ghWithBody('')
      options.routes = {
        ...options.routes,
        'repos/acme/widgets/issues/42/comments': ghJson([
          {
            id: 1,
            // The pull request's author, who may republish its canvas.
            user: { login: 'octocat' },
            body,
            created_at: updated.generatedAt,
            html_url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
          },
        ]),
      }
      t.ctx.gh = createFakeGh(options)
      await t.ctx.canvases.write(HEAD_SHA, previous, manifest(HEAD_SHA))
      const app = createApp(t.ctx)
      const before = await json<PrBundle>(await app.request('/api/prs/42', { headers: LOCAL }))
      expect(before.artifact?.summary).toBe(previous.summary)
      const after = await json<PrBundle>(await app.request('/api/prs/42?refresh=1', { headers: LOCAL }))
      expect(after.status).toBe('ready')
      expect(after.artifact?.summary).toBe('Updated explanation')
    })

    describe('two pull requests with one head commit', () => {
      // #99 is a stranger's pull request with #42's head commit, and their own canvas for it.
      const own = artifactFor(HEAD_SHA)
      const FUTURE = '2099-01-01T00:00:00.000Z'
      const theirs = (generatedAt: string): ReviewArtifact => ({
        ...own,
        pr: { ...own.pr, number: 99 },
        generatedAt,
        summary: 'Safe to merge',
      })

      function canvasComment(prNumber: number, author: string, artifact: ReviewArtifact) {
        const stamp = `${artifact.generatedAt.slice(0, 19).replace(/[-:]/g, '')}Z`
        const zip = {
          name: `pr-${prNumber}-${stamp}-${HEAD_SHA.slice(0, 8)}-acme-widgets-canvas.zip`,
          headSha: HEAD_SHA,
          prNumber,
          bytes: buildCanvasZip(
            { ...manifest(HEAD_SHA), prNumber, generatedAt: artifact.generatedAt },
            artifact
          ),
        }
        return {
          id: prNumber,
          user: { login: author },
          body: buildCanvasComment(zip, NO_POINTS, 65_536),
          created_at: '2026-09-11T12:00:00Z',
          html_url: `https://github.com/acme/widgets/pull/${prNumber}#issuecomment-${prNumber}`,
        }
      }

      /** Both pull requests on the forge; `ownShared` puts #42's canvas in a comment of its author. */
      async function twoPrs(shared: ReviewArtifact, ownShared: boolean) {
        const options: FakeGhOptions = ghWithBody('')
        options.routes = {
          ...options.routes,
          ...(ownShared
            ? { 'repos/acme/widgets/issues/42/comments': ghJson([canvasComment(42, 'octocat', own)]) }
            : {}),
          'repos/acme/widgets/pulls/99': ghJson({
            ...GH_PULL,
            number: 99,
            body: '',
            user: { login: 'mallory' },
          }),
          'repos/acme/widgets/pulls/99/comments': ghJson([]),
          'repos/acme/widgets/pulls/99/reviews': ghJson([]),
          'repos/acme/widgets/issues/99/comments': ghJson([canvasComment(99, 'mallory', shared)]),
        }
        options.graphql = Array.from({ length: 12 }, () => GH_THREADS_PAGE)
        t = await makeTestContext({
          git: gitWithHistory({
            refs: { 'pull/42/head': HEAD_SHA, 'pull/99/head': HEAD_SHA, 'refs/heads/main': BASE_SHA },
            mergeBases: {
              [`refs/pr/42/base..${HEAD_SHA}`]: BASE_SHA,
              [`refs/pr/99/base..${HEAD_SHA}`]: BASE_SHA,
            },
          }),
          gh: createFakeGh(options),
        })
        const app = createApp(t.ctx)
        const bundle = async (n: number, refresh = false) =>
          json<PrBundle>(await app.request(`/api/prs/${n}${refresh ? '?refresh=1' : ''}`, { headers: LOCAL }))
        return { app, bundle }
      }

      const stored = async () => (await t.ctx.canvases.readIndex()).canvases[HEAD_SHA]

      it('leaves a pull request the canvas it imported when the other shares one for the commit', async () => {
        const { bundle } = await twoPrs(theirs(FUTURE), true)
        expect((await bundle(42)).artifact?.summary).toBe(own.summary)
        const other = await bundle(99)
        expect([other.status, other.artifact, other.sharedCanvas?.reason]).toEqual([
          'missing',
          undefined,
          'commit-taken',
        ])
        expect(other.warnings).toContain(
          `the canvas stored for ${HEAD_SHA.slice(0, 7)} is the one of #42, so the one shared on #99 was not imported`
        )
        expect((await bundle(42, true)).artifact?.summary).toBe(own.summary)
        expect(await stored()).toMatchObject({ prNumber: 42, source: 'import' })
      })

      it('shows a pull request no canvas imported for the other, until the reader hands it its own', async () => {
        const { app, bundle } = await twoPrs(theirs(FUTURE), true)
        expect((await bundle(99)).artifact?.summary).toBe('Safe to merge')
        // The commit is #42's head too. The canvas stored for it is not #42's to read, and the
        // one its author shared does not replace what was imported for #99.
        const victim = await bundle(42)
        expect([victim.status, victim.artifact, victim.sharedCanvas?.reason]).toEqual([
          'missing',
          undefined,
          'commit-taken',
        ])
        const settled = await app.request(`/api/prs/42/settled?headSha=${HEAD_SHA}`, { headers: LOCAL })
        expect(settled.status).toBe(404)
        expect((await bundle(99)).artifact?.summary).toBe('Safe to merge')

        // The reader drops #42's canvas in, which replaces the one #42 could not read, however
        // new that one claims to be, and is never handed back to #99.
        const form = new FormData()
        const zip = buildCanvasZip(manifest(HEAD_SHA), own)
        form.append('file', new File([zip.slice().buffer as ArrayBuffer], 'canvas.zip'))
        const imported = await app.request('/api/prs/42/import', {
          method: 'POST',
          headers: SAME_ORIGIN,
          body: form,
        })
        expect((await json<ImportResult>(imported)).status).toBe('ready')
        expect((await bundle(42)).artifact?.summary).toBe(own.summary)
        expect((await bundle(99)).artifact).toBeUndefined()
      })

      it.each([
        ['numbered for the other pull request, against a later canvas', manifest(HEAD_SHA), FUTURE],
        [
          'numbered for the other pull request, against an earlier canvas',
          manifest(HEAD_SHA),
          '2020-01-01T00:00:00.000Z',
        ],
        ['with no number, against a later canvas', { ...manifest(HEAD_SHA), prNumber: undefined }, FUTURE],
        [
          'with no number, against an earlier canvas',
          { ...manifest(HEAD_SHA), prNumber: undefined },
          '2020-01-01T00:00:00.000Z',
        ],
      ])('leaves a canvas generated on this machine as it is: %s', async (_case, generated, sharedAt) => {
        const { prNumber, ...unnumbered } = generated
        const { bundle } = await twoPrs(theirs(sharedAt), false)
        await t.ctx.canvases.write(HEAD_SHA, own, prNumber === undefined ? unnumbered : generated)
        const before = await stored()
        // #99 reads the canvas of its head commit that was generated here; the one shared on it
        // neither replaces that canvas nor puts #99's number on it.
        expect((await bundle(99, true)).artifact?.summary).toBe(own.summary)
        expect(await stored()).toEqual(before)
        expect((await bundle(42)).artifact?.summary).toBe(own.summary)
      })
    })

    it('does not scan when a canvas for the head is already stored', async () => {
      const fetches = alwaysFetch(() => new Response('', { status: 404 }))
      t = await contextFor(`canvas: ${FILE_URL}`, fetches.impl)
      await t.ctx.canvases.write(HEAD_SHA, artifactFor(HEAD_SHA), manifest(HEAD_SHA))
      const bundle = await json<PrBundle>(await createApp(t.ctx).request('/api/prs/42', { headers: LOCAL }))
      expect(bundle.status).toBe('ready')
      expect(bundle.sharedCanvas).toBeUndefined()
      expect(fetches.count()).toBe(0)
    })
  })
})
