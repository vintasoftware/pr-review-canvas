// @vitest-environment node
// The tour's steps end to end over the synthetic pull request: prepare writes the prompt and the
// context, validate reads the model and the scene files, publish stores and shares, preview
// screenshots, and the CLI layer prints what the skill reads.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type CliIo, reportFailure } from '../commands.js'
import { TourContextSchema, TourArtifactSchema } from '../contract/tour.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { ghPost, makeTestContext, type TestContext } from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_ISSUE_COMMENTS,
  ghFor42,
  gitFor42,
  gitForLocal,
  HEAD_SHA,
  SYNTHETIC_DIFF,
} from '../testing/synthetic.js'
import { syntheticTour, syntheticTourModel, writeTourFiles } from '../testing/synthetic-tour.js'
import { buildTourComment, readTourComment, tourCommentSummary } from './comment.js'
import { namedTourDir, tourStepCreatesDataDir } from './named-dir.js'
import { runTour } from './commands.js'
import { guideHasRunRecipe, prepareTour } from './prepare.js'
import { previewTour } from './preview.js'
import { renderTourPrompt } from './prompt.js'
import { carriedRecord, publishTour, TourInvalidError } from './publish.js'
import { exportTour, zipStoredTour } from './share.js'
import { buildTourZipName, parseTourZipName, readTourZip } from './zip.js'

let t: TestContext
afterEach(() => t?.cleanup())

const OPTS = { agent: 'claude', model: 'opus', harness: 'claude-code' as const, allowStale: false }

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: l => out.push(l), stderr: l => err.push(l), json: true }, out, err }
}

async function prepared(extra: Parameters<typeof makeTestContext>[0] = {}) {
  t = await makeTestContext({ git: gitFor42(), gh: ghFor42(), ...extra })
  return prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
}

/** The synthetic model with its scenes as files, the way the skill writes them. */
describe('tour prepare', () => {
  it('writes prompt.md, context.json, and an empty scenes dir, with the budget and the blast radius', async () => {
    const result = await prepared()
    const tourDir = t.ctx.tours.tourDir(HEAD_SHA)
    expect(result).toMatchObject({
      tourDir,
      headSha: HEAD_SHA,
      promptPath: path.join(tourDir, 'prompt.md'),
      contextPath: path.join(tourDir, 'context.json'),
      scenesDir: path.join(tourDir, 'scenes'),
      models: { claude: 'opus' },
      sharing: 'shared',
      status: 'prepared',
      blastRadius: [],
      budget: { why: 1, whyMax: 4, decisions: 5, quiz: 5 },
      guide: null,
    })
    expect(result.sceneGuidePath).toMatch(/skills\/pr-tour\/scenes\.md$/)
    const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.stateRequired).toBe(false)
    expect(context.options).toEqual({ microWorld: true, tryIt: false, finalQuiz: 'on' })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).not.toContain('{{')
    expect(prompt).toContain('at most **1 why landmark**')
    expect(prompt).toContain('never more than **4**')
    expect(prompt).toContain('```diff')
    expect(prompt).toContain('The project has no guide')
    expect(prompt).toContain('"landmarks"')
    expect(await readFile(path.join(tourDir, 'tour.log'), 'utf8')).toMatch(/ prepared /)
  })

  it('raises the budget and requires a state landmark when the change touches a schema pattern', async () => {
    const config = { ...DEFAULT_PROJECT_CONFIG, highRisk: [{ pattern: 'src/app.ts', label: 'schema' }] }
    const result = await prepared({ projectConfig: { config, warnings: [], source: null } })
    expect(result.blastRadius).toEqual(['schema'])
    expect(result.budget).toEqual({ why: 2, whyMax: 4, decisions: 5, quiz: 5 })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('A state landmark is required')
  })

  it('reads the guide, turns try-it on when it has a run recipe, and says when a tour exists', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    t.ctx.config.repoRoot = t.dataDir
    await mkdir(path.join(t.dataDir, 'docs'), { recursive: true })
    await writeFile(
      path.join(t.dataDir, 'docs', 'pr-tour.md'),
      '# Guide\n\n## Run the app\n\n```bash\npnpm start\n```\n'
    )
    const first = await prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    expect(first.guide).toBe('docs/pr-tour.md')
    const context = TourContextSchema.parse(JSON.parse(await readFile(first.contextPath, 'utf8')))
    expect(context.options.tryIt).toBe(true)
    expect(await readFile(first.promptPath, 'utf8')).toContain('pnpm start')
    await writeTourFiles(first.tourDir, first.scenesDir)
    await publishTour(t.ctx, first.tourDir, { ...OPTS })
    const again = await prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force: false, log: () => undefined })
    expect(again.status).toBe('exists')
    // A forced run clears the model and the scenes, but not the published tour.
    const forced = await prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    expect(forced.status).toBe('prepared')
    expect(await t.ctx.tours.exists(HEAD_SHA)).toBe(true)
    await expect(readFile(path.join(first.tourDir, 'tour-model.json'))).rejects.toThrow()
  })

  it('names the local review it prepared', async () => {
    t = await makeTestContext({ git: gitForLocal(), gh: ghFor42() })
    const result = await prepareTour(
      t.ctx,
      { kind: 'local', source: 'uncommitted' },
      { force: false, log: () => undefined }
    )
    expect(result.local).toEqual({
      review: 'uncommitted',
      base: 'origin/main',
      headRef: 'feat/b',
      uncommitted: true,
    })
    expect(result.sharing).toBe('off')
  })

  it('knows a run recipe when a heading names running and a fence follows', () => {
    expect(guideHasRunRecipe('## Run the app\n```\npnpm start\n```')).toBe(true)
    expect(guideHasRunRecipe('## Start it\n\n```bash\nx\n```')).toBe(true)
    expect(guideHasRunRecipe('## Run the app\n\nno commands')).toBe(false)
    expect(guideHasRunRecipe(null)).toBe(false)
  })
})

describe('tour publish', () => {
  it('reads the scene files, validates, stores tour.json, and shares the tour comment', async () => {
    let shared: unknown
    const result = await prepared({
      gh: ghFor42({
        postRoutes: {
          'repos/acme/widgets/issues/42/comments': ghPost(body => {
            shared = { ...GH_ISSUE_COMMENTS[0], id: 7001, ...(body as object) }
            return shared
          }),
        },
      }),
    })
    await writeTourFiles(result.tourDir, result.scenesDir)
    const published = await publishTour(t.ctx, result.tourDir, OPTS)
    expect(published).toMatchObject({
      status: 'published',
      headSha: HEAD_SHA,
      attempts: 1,
      tourUrl: 'http://localhost:3010/r/acme/widgets/tour/42',
      sharing: { status: 'shared', url: GH_ISSUE_COMMENTS[0]!.html_url },
    })
    const stored = TourArtifactSchema.parse(JSON.parse(await readFile(published.tourJsonPath, 'utf8')))
    expect(stored.landmarks.map(l => l.scene)).toEqual(syntheticTourModel().landmarks.map(l => l.scene))
    expect(stored.generator).toEqual({ agent: 'claude', model: 'opus', harness: 'claude-code', attempts: 1 })
    expect(stored.record).toEqual({ touredBy: [] })
    const body = (shared as { body: string }).body
    expect(body).toContain('PR Review Tour for commit')
    expect(body).toContain('**Tour:** 4 landmarks, 1 decisions, 1 quiz questions.')
    const embedded = readTourComment(body)
    expect(embedded?.name).toBe(
      buildTourZipName({
        repo: stored.repo,
        headSha: HEAD_SHA,
        prNumber: 42,
        generatedAt: stored.generatedAt,
      })
    )
    const zip = readTourZip(embedded!.bytes)
    expect(zip.artifact).toEqual(stored)
    expect(zip.manifest.tool.name).toBe('pr-review-tour')
    expect(zip.manifest.prNumber).toBe(42)
  })

  it('refuses an invalid model with one line per problem and exits 5 through the CLI', async () => {
    const result = await prepared()
    const model = syntheticTourModel()
    await writeTourFiles(result.tourDir, result.scenesDir, { ...model, landmarks: model.landmarks.slice(1) })
    const err = await publishTour(t.ctx, result.tourDir, OPTS).catch(e => e)
    expect(err).toBeInstanceOf(TourInvalidError)
    const { io, out } = capture()
    expect(reportFailure(io, err)).toBe(5)
    expect(out.some(l => l.startsWith('LANDMARK_ORDER'))).toBe(true)
    expect(out.at(-1)).toContain('MODEL_INVALID')
    expect(await t.ctx.tours.exists(HEAD_SHA)).toBe(false)
    expect(await readFile(path.join(result.tourDir, 'tour.log'), 'utf8')).toMatch(/invalid attempts=1/)
  })

  it('keeps the tour local when sharing or the run turns it off, and exports a zip when the post fails', async () => {
    const off = await prepared()
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, tour: { ...DEFAULT_PROJECT_CONFIG.tour, share: 'off' } },
      warnings: [],
      source: null,
    }
    await writeTourFiles(off.tourDir, off.scenesDir)
    expect((await publishTour(t.ctx, off.tourDir, OPTS)).sharing).toEqual({ status: 'off' })
    await t.cleanup()
    const failing = await prepared()
    await writeTourFiles(failing.tourDir, failing.scenesDir)
    // A run that turns sharing off (`tour generate --out`) posts nothing, whatever the config says.
    expect((await publishTour(t.ctx, failing.tourDir, { ...OPTS, share: false })).sharing).toEqual({
      status: 'off',
    })
    const published = await publishTour(t.ctx, failing.tourDir, OPTS)
    expect(published.sharing.status).toBe('failed')
    if (published.sharing.status === 'failed') {
      expect(published.sharing.zipPath).toMatch(/-tour\.zip$/)
      expect(readTourZip(new Uint8Array(await readFile(published.sharing.zipPath))).artifact.headSha).toBe(
        HEAD_SHA
      )
    }
  })

  it('carries who toured and the author picks whose decisions survive a regeneration', () => {
    const model = syntheticTourModel()
    const previous = {
      record: {
        touredBy: [{ login: 'octocat', at: '2026-09-11T00:00:00.000Z' }],
        author: {
          finishedAt: '2026-09-11T00:00:00.000Z',
          prompt: 'p',
          picks: { 'sum-over-product': { pick: 'keep' as const }, gone: { pick: 'change' as const } },
        },
      },
    }
    expect(carriedRecord(null, model)).toEqual({ touredBy: [] })
    expect(carriedRecord(previous as never, model)).toEqual({
      touredBy: previous.record.touredBy,
      author: { ...previous.record.author, picks: { 'sum-over-product': { pick: 'keep' } } },
    })
  })

  it('refuses a tour dir from another data dir, and a head that moved', async () => {
    const result = await prepared()
    await writeTourFiles(result.tourDir, result.scenesDir)
    await expect(publishTour(t.ctx, path.join(t.dataDir, 'elsewhere'), OPTS)).rejects.toThrow(
      'has no context.json'
    )
    t.ctx.config.dataDir = '/other'
    t.ctx.tours = { ...t.ctx.tours, tourDir: () => '/other/tours/x' }
    await expect(publishTour(t.ctx, result.tourDir, OPTS)).rejects.toThrow('is not the tour dir')
  })
})

describe('tour zip and comment', () => {
  it('names and parses a tour zip, and refuses what is not one', () => {
    const repo = { owner: 'acme', name: 'widgets' }
    const name = buildTourZipName({
      repo,
      headSha: HEAD_SHA,
      generatedAt: '2026-09-10T11:00:00Z',
      prNumber: 42,
    })
    expect(name).toBe('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-tour.zip')
    expect(parseTourZipName(name, repo)).toEqual({ prNumber: 42, shaPrefix: 'aaaaaaaa' })
    expect(parseTourZipName('ref-20260910T110000Z-aaaaaaaa-acme-widgets-tour.zip', repo)).toEqual({
      shaPrefix: 'aaaaaaaa',
    })
    expect(parseTourZipName('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip', repo)).toBeNull()
    expect(parseTourZipName('x-acme-widgets-tour.zip', repo)).toBeNull()
    expect(() => readTourZip(new Uint8Array([1, 2, 3]))).toThrow('not a tour')
    expect(() => readTourZip(new Uint8Array(21 * 1024 * 1024))).toThrow('larger')
    expect(readTourComment('no marker here')).toBeNull()
  })

  it('exports a stored tour and summarises who toured it', async () => {
    const result = await prepared()
    await writeTourFiles(result.tourDir, result.scenesDir)
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, tour: { ...DEFAULT_PROJECT_CONFIG.tour, share: 'off' } },
      warnings: [],
      source: null,
    }
    await publishTour(t.ctx, result.tourDir, OPTS)
    const exported = await exportTour(t.ctx, { headSha: HEAD_SHA })
    expect(exported.path).toBe(path.join(t.dataDir, 'exports', exported.name))
    const { artifact, zip } = await zipStoredTour(t.ctx, HEAD_SHA)
    expect(zip.prNumber).toBe(42)
    expect(
      tourCommentSummary({
        ...artifact,
        record: { touredBy: [{ login: 'ana', at: '2026-09-12T10:00:00Z' }] },
      })
    ).toContain('**Toured by:** ana (2026-09-12).')
    expect(() => buildTourComment(zip, artifact, 10)).toThrow('host limit is 10')
    await expect(zipStoredTour(t.ctx, 'e'.repeat(40))).rejects.toThrow('no tour')
  })
})

describe('tour preview', () => {
  it('screenshots every landmark on a desktop and a phone through a quiet server', async () => {
    const result = await prepared()
    await writeTourFiles(result.tourDir, result.scenesDir)
    const shots: Array<{ url: string; width: number }> = []
    const preview = await previewTour(
      t.ctx,
      result.tourDir,
      {
        env: { PR_REVIEW_BROWSER: '/opt/chrome' },
        platform: 'linux',
        startServer: async () => ({ origin: 'http://127.0.0.1:9', close: async () => undefined }),
        screenshot: async (_b, url, file, viewport) => {
          shots.push({ url, width: viewport.width })
          await writeFile(file, 'png')
        },
      },
      { landmark: 'world' }
    )
    expect(preview.status).toBe('previewed')
    // The screenshots came from a server of preview's own, so no URL points at another one.
    expect(preview.previewUrl).toBeUndefined()
    // The page on a desktop and a phone, then the scene alone at the width the page gives it.
    expect(preview.screenshots.map(f => path.basename(f))).toEqual([
      '02-world-desktop.png',
      '02-world-phone.png',
      '02-world-scene.png',
      '02-world-scene-phone.png',
    ])
    expect(shots).toEqual([
      { url: 'http://127.0.0.1:9/tour/42?preview&landmark=world&theme=light', width: 1280 },
      { url: 'http://127.0.0.1:9/tour/42?preview&landmark=world&theme=light', width: 390 },
      { url: 'http://127.0.0.1:9/tour-scene/42/world/scene?preview&theme=light', width: 1120 },
      { url: 'http://127.0.0.1:9/tour-scene/42/world/scene?preview&theme=light', width: 350 },
    ])
    // The whole tour adds each decision and each question, on a desktop.
    const whole = await previewTour(t.ctx, result.tourDir, {
      env: { PR_REVIEW_BROWSER: '/opt/chrome' },
      platform: 'linux',
      startServer: async () => ({ origin: 'http://127.0.0.1:9', close: async () => undefined }),
      screenshot: async (_b, _url, file) => writeFile(file, 'png'),
    })
    expect(whole.screenshots.map(f => path.basename(f)).slice(-2)).toEqual([
      'd1-sum-over-product.png',
      'q1-q-run.png',
    ])
    expect(whole.screenshots).toHaveLength(4 * 4 + 2)
    // A retake of one landmark replaces only its own pictures; the rest of the run stays.
    await previewTour(
      t.ctx,
      result.tourDir,
      {
        env: { PR_REVIEW_BROWSER: '/opt/chrome' },
        platform: 'linux',
        startServer: async () => ({ origin: 'http://127.0.0.1:9', close: async () => undefined }),
        screenshot: async (_b, _url, file) => writeFile(file, 'retake'),
      },
      { landmark: 'world' }
    )
    const kept = await readdir(path.join(result.tourDir, 'preview'))
    expect(kept).toHaveLength(4 * 4 + 2)
    expect(await readFile(path.join(result.tourDir, 'preview', '02-world-scene.png'), 'utf8')).toBe('retake')
    expect(await readFile(path.join(result.tourDir, 'preview', '01-before-scene.png'), 'utf8')).toBe('png')
    const none = await previewTour(t.ctx, result.tourDir, {
      env: { PATH: '' },
      platform: 'linux',
      startServer: async () => ({ origin: '', close: async () => undefined }),
      screenshot: async () => undefined,
    })
    expect(none.status).toBe('no-browser')
    expect(none.landmarks).toBe(4)
  })

  it('refuses an invalid tour, and says a refs tour has no page', async () => {
    const result = await prepared()
    await writeFile(path.join(result.tourDir, 'tour-model.json'), '{"landmarks": []}')
    const deps = {
      env: {},
      platform: 'linux' as const,
      startServer: async () => ({ origin: '', close: async () => undefined }),
      screenshot: async () => undefined,
    }
    await expect(previewTour(t.ctx, result.tourDir, deps)).rejects.toBeInstanceOf(TourInvalidError)
    await t.cleanup()
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const refs = await prepareTour(
      t.ctx,
      { kind: 'refs', base: 'main', head: 'feat/b' },
      { force: false, log: () => undefined }
    )
    await writeTourFiles(refs.tourDir, refs.scenesDir)
    expect((await previewTour(t.ctx, refs.tourDir, deps)).status).toBe('no-page')
  })
})

describe('the tour CLI', () => {
  it('runs each step and prints what the skill reads', async () => {
    const result = await prepared()
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, tour: { ...DEFAULT_PROJECT_CONFIG.tour, share: 'off' } },
      warnings: [],
      source: null,
    }
    const model = path.join(result.tourDir, 'tour-model.json')
    await writeTourFiles(result.tourDir, result.scenesDir)
    const invalid = capture()
    await writeFile(model, '{')
    expect(await runTour(t.ctx, ['validate', model, '--tour', result.tourDir], invalid.io)).toBe(5)
    expect(JSON.parse(invalid.out[0]!).errors[0].code).toBe('SCHEMA')
    await writeTourFiles(result.tourDir, result.scenesDir)
    const human = capture()
    expect(await runTour(t.ctx, ['validate', model, '--tour', result.tourDir, '--human'], human.io)).toBe(0)
    expect(human.out[0]).toMatch(/^ok: tour-model\.json passes/)
    const published = capture()
    expect(
      await runTour(
        t.ctx,
        ['publish', result.tourDir, '--agent', 'claude', '--harness', 'claude-code'],
        published.io
      )
    ).toBe(0)
    expect(JSON.parse(published.out[0]!).status).toBe('published')
    const prepare = capture()
    expect(await runTour(t.ctx, ['prepare', '--pr', '42'], prepare.io)).toBe(0)
    expect(JSON.parse(prepare.out[0]!).status).toBe('exists')
    // A code chunk for the model, whole or trimmed to a new-side range.
    const chunk = capture()
    expect(await runTour(t.ctx, ['hunk', result.tourDir, 'src_app_ts#1'], chunk.io)).toBe(0)
    const whole = JSON.parse(chunk.out[0]!) as { path: string; diff: string }
    expect(whole.path).toBe('src/app.ts')
    expect(whole.diff).toMatch(/^@@ -1,\d+ \+1,\d+ @@/)
    const trimmed = capture()
    expect(
      await runTour(t.ctx, ['hunk', result.tourDir, 'src_app_ts#1', '--from', '2', '--to', '2'], trimmed.io)
    ).toBe(0)
    expect(JSON.parse(trimmed.out[0]!).diff).toMatch(/^@@ -\d+,\d+ \+2,1 @@/)
    await expect(runTour(t.ctx, ['hunk', result.tourDir, 'nope#1'], chunk.io)).rejects.toThrow(
      'no hunk nope#1 in this change'
    )
  })

  it('exports the tour a review shows and imports it back, as export and import do a canvas', async () => {
    await prepared()
    await t.ctx.tours.write(HEAD_SHA, syntheticTour())
    const out = path.join(t.dataDir, 'shared')
    await mkdir(out)
    const exported = capture()
    expect(await runTour(t.ctx, ['export', '--pr', '42', '--out', out], exported.io)).toBe(0)
    const { path: zipPath, headSha } = JSON.parse(exported.out[0]!) as { path: string; headSha: string }
    expect(headSha).toBe(HEAD_SHA)
    expect(zipPath).toMatch(/shared\/pr-42-.+-tour\.zip$/)
    const byHead = capture()
    expect(await runTour(t.ctx, ['export', '--head', HEAD_SHA, '--pr', '42'], byHead.io)).toBe(0)
    expect(JSON.parse(byHead.out[0]!).path).toMatch(/exports\/pr-42-.+-tour\.zip$/)
    await expect(runTour(t.ctx, ['export', '--head', HEAD_SHA, '--branch'], byHead.io)).rejects.toThrow(
      'tour export takes --head alone'
    )
    await expect(runTour(t.ctx, ['export', '--branch'], byHead.io)).rejects.toThrow(
      'no branch review has been prepared'
    )

    const kept = capture()
    expect(await runTour(t.ctx, ['import', zipPath], kept.io)).toBe(0)
    expect(JSON.parse(kept.out[0]!)).toEqual({ status: 'exists', headSha: HEAD_SHA, warnings: [] })
    const human = capture()
    human.io.json = false
    await rm(t.ctx.tours.tourDir(HEAD_SHA), { recursive: true })
    expect(await runTour(t.ctx, ['import', zipPath, '--pr', '42'], human.io)).toBe(0)
    expect(human.out).toEqual([`Imported the tour for ${HEAD_SHA.slice(0, 7)}.`])
    await expect(runTour(t.ctx, ['import'], human.io)).rejects.toThrow('tour import takes one zip')
  })

  it('checks out the head and the merge base in worktrees of their own, listed and swept with the chat ones', async () => {
    const result = await prepared()
    const head = capture()
    expect(await runTour(t.ctx, ['checkout', result.tourDir, 'head'], head.io)).toBe(0)
    const headOut = JSON.parse(head.out[0]!) as {
      side: string
      dir: string
      sha: string
      port: number
      scratch: string
    }
    expect(headOut).toMatchObject({ side: 'head', dir: path.join(t.ctx.checkouts.root, '42'), sha: HEAD_SHA })
    // A free port and an empty folder in the tour dir, so a server started there keeps off the reader's.
    expect(headOut.port).toBeGreaterThan(0)
    expect(headOut.scratch).toBe(path.join(result.tourDir, 'scratch', 'head'))
    await writeFile(path.join(headOut.scratch, 'state.json'), '{}')
    const again = capture()
    await runTour(t.ctx, ['checkout', result.tourDir, 'head'], again.io)
    expect(await readdir(headOut.scratch)).toEqual([])
    expect(await readFile(path.join(headOut.dir, 'HEAD'), 'utf8')).toBe(HEAD_SHA)
    const base = capture()
    expect(await runTour(t.ctx, ['checkout', result.tourDir, 'base'], base.io)).toBe(0)
    const baseOut = JSON.parse(base.out[0]!) as { side: string; dir: string; sha: string }
    expect(baseOut).toMatchObject({
      side: 'base',
      dir: path.join(t.ctx.checkouts.root, 'base', '42'),
      sha: BASE_SHA,
    })
    expect((await t.ctx.checkouts.list()).map(c => c.dir).sort()).toEqual([headOut.dir, baseOut.dir].sort())
    // Done with it, the generator takes the base away; the head stays, for AI Chat.
    const removed = capture()
    expect(await runTour(t.ctx, ['checkout', result.tourDir, 'base', '--remove'], removed.io)).toBe(0)
    expect(JSON.parse(removed.out[0]!)).toEqual({ side: 'base', removed: true })
    expect((await t.ctx.checkouts.list()).map(c => c.dir)).toEqual([headOut.dir])
    await expect(
      runTour(t.ctx, ['checkout', result.tourDir, 'head', '--remove'], removed.io)
    ).rejects.toThrow('the head checkout stays')
    await runTour(t.ctx, ['checkout', result.tourDir, 'base'], capture().io)
    const swept = await t.ctx.checkouts.sweep({ all: true })
    expect(swept.removed).toHaveLength(2)
    // The chat holds the head checkout: the tour waits rather than move it under the answer.
    const lease = await t.ctx.checkouts.lease(42, 'chat')
    await expect(runTour(t.ctx, ['checkout', result.tourDir, 'head'], head.io)).rejects.toThrow(
      'a chat answer is using the review checkout of 42'
    )
    await lease.release()
    await expect(runTour(t.ctx, ['checkout', result.tourDir, 'side'], head.io)).rejects.toThrow(
      'takes a tour directory and a side'
    )
  })

  it('has no checkout for a ref comparison', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const result = await prepareTour(
      t.ctx,
      { kind: 'refs', base: 'main', head: 'feat/b' },
      { force: false, log: () => undefined }
    )
    await expect(runTour(t.ctx, ['checkout', result.tourDir, 'base'], capture().io)).rejects.toThrow(
      'a ref comparison has no checkout'
    )
  })

  it('names its usage errors', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const { io } = capture()
    await expect(runTour(t.ctx, ['dance'], io)).rejects.toThrow('tour takes a step')
    await expect(runTour(t.ctx, ['validate'], io)).rejects.toThrow('takes one file')
    await expect(runTour(t.ctx, ['validate', 'x.json'], io)).rejects.toThrow('needs --tour')
    await expect(runTour(t.ctx, ['publish'], io)).rejects.toThrow('takes one directory')
    await expect(runTour(t.ctx, ['publish', 'dir'], io)).rejects.toThrow('needs --agent')
    await expect(runTour(t.ctx, ['publish', 'dir', '--agent', 'x'], io)).rejects.toThrow('needs --harness')
    await expect(runTour(t.ctx, ['preview'], io)).rejects.toThrow('takes one directory')
    await expect(runTour(t.ctx, ['hunk', 'dir'], io)).rejects.toThrow('takes a tour directory and a hunk id')
    await expect(runTour(t.ctx, ['hunk', 'dir', 'a#1', '--from', 'x', '--to', '2'], io)).rejects.toThrow(
      '--from takes a line number'
    )
    await expect(runTour(t.ctx, ['hunk', 'dir', 'a#1', '--from', '2'], io)).rejects.toThrow(
      'takes --from and --to together'
    )
  })

  it('reads the tour dir a command line names, so the data dir can follow it', () => {
    expect(namedTourDir(['validate', 'm.json', '--tour', '/d/tours/x'])).toBe('/d/tours/x')
    expect(namedTourDir(['publish', '/d/tours/x', '--agent', 'a'])).toBe('/d/tours/x')
    expect(namedTourDir(['preview', '/d/tours/x'])).toBe('/d/tours/x')
    expect(namedTourDir(['checkout', '/d/tours/x', 'head'])).toBe('/d/tours/x')
    expect(namedTourDir(['prepare', '--pr', '1'])).toBeUndefined()
    expect(tourStepCreatesDataDir(['prepare'])).toBe(true)
    expect(tourStepCreatesDataDir(['publish', 'x'])).toBe(false)
  })
})

describe('the tour prompt', () => {
  it('fills every token and refuses one it does not know', async () => {
    const result = await prepared()
    const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    const patches = (await t.ctx.derived.ensure({ headSha: HEAD_SHA, mergeBaseSha: context.mergeBaseSha }))
      .patches
    const text = renderTourPrompt(
      context,
      patches,
      '{{META}}|{{GUIDE}}|{{MICRO_WORLD}}|{{TRY_IT}}|{{CATEGORIES}}',
      { sceneGuidePath: '/g.md' }
    )
    expect(text).toContain('Pull request: #42')
    expect(text).toContain('Try-it recipes are off')
    expect(text).toContain('`pokayoke`')
    expect(() => renderTourPrompt(context, patches, '{{NOPE}}', { sceneGuidePath: '/g.md' })).toThrow(
      'unknown token {{NOPE}}'
    )
    const long = renderTourPrompt(context, { ...patches, big: 'x\n'.repeat(2000) }, '{{DIFFS}}', {
      sceneGuidePath: '/g.md',
    })
    expect(long).toContain('not inlined')
  })
})

describe('a tour that updates an earlier one', () => {
  const OLD = 'e'.repeat(40)
  let oldGit = gitFor42()

  /** PR 42 whose head has an ancestor commit, of the same diff, with a tour the author took. */
  async function withOldTour(incremental = true) {
    const git = gitFor42()
    Object.assign(git.options.refs ?? {}, { old: OLD })
    Object.assign(git.options.diffs ?? {}, { [`${BASE_SHA}..${OLD}`]: SYNTHETIC_DIFF })
    git.options.ancestors = { ...git.options.ancestors, [`${OLD}..${HEAD_SHA}`]: true }
    t = await makeTestContext({ git, gh: ghFor42() })
    oldGit = git
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, tour: { ...DEFAULT_PROJECT_CONFIG.tour, incremental } },
      warnings: [],
      source: null,
    }
    await t.ctx.tours.write(
      OLD,
      syntheticTour({
        headSha: OLD,
        generatedAt: '2026-09-09T12:00:00.000Z',
        record: {
          touredBy: [{ login: 'octocat', at: '2026-09-09T13:00:00.000Z' }],
          author: {
            finishedAt: '2026-09-09T13:00:00.000Z',
            prompt: '# Keep it',
            picks: { 'sum-over-product': { pick: 'keep' } },
          },
        },
      })
    )
  }

  const prepare = (force = false) =>
    prepareTour(t.ctx, { kind: 'pr', number: 42 }, { force, log: () => undefined })

  it('copies the earlier tour and its pictures, says how the files relate, and tells the agent what carries', async () => {
    await withOldTour()
    const result = await prepare()
    const basisDir = path.join(result.tourDir, 'basis')
    expect(result.basis).toEqual({
      tourSha: OLD,
      modelPath: path.join(basisDir, 'tour-model.json'),
      scenesDir: path.join(basisDir, 'scenes'),
    })
    const model = JSON.parse(await readFile(result.basis!.modelPath, 'utf8'))
    expect(model.landmarks.map((l: { id: string }) => l.id)).toEqual(
      syntheticTourModel().landmarks.map(l => l.id)
    )
    expect(model.landmarks.every((l: object) => !('scene' in l))).toBe(true)
    expect((await readdir(result.basis!.scenesDir)).sort()).toEqual(
      syntheticTourModel()
        .landmarks.map(l => `${l.id}.scene.html`)
        .sort()
    )
    const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    // The head's diff is the old commit's, so every file carries.
    expect(context.basis?.files).toMatchObject({ changed: [], added: [], removed: [] })
    expect(context.basis?.files.unchanged).toEqual(context.files.map(f => f.path).sort())
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('## The earlier tour')
    expect(prompt).toContain(`This head builds on \`${OLD}\``)
    expect(prompt).toContain('; changed: none; new: none. These are gone from the diff: none.')
  })

  it("carries the author's picks by decision key on publish, and nobody's tour of the old commit", async () => {
    await withOldTour()
    const result = await prepare()
    await writeTourFiles(result.tourDir, result.scenesDir)
    await publishTour(t.ctx, result.tourDir, OPTS)
    const record = (await t.ctx.tours.read(HEAD_SHA))?.record
    expect(record?.author?.picks).toEqual({ 'sum-over-product': { pick: 'keep' } })
    expect(record?.touredBy).toEqual([])
  })

  it('starts blank with --force, with tour.incremental off, and with no tour of an ancestor', async () => {
    await withOldTour()
    expect((await prepare(true)).basis).toBeUndefined()
    await t.cleanup()
    await withOldTour(false)
    expect((await prepare()).basis).toBeUndefined()
    await t.cleanup()
    await withOldTour()
    delete oldGit.options.ancestors?.[`${OLD}..${HEAD_SHA}`]
    const unrelated = await prepare()
    expect(unrelated.basis).toBeUndefined()
    expect(await readFile(unrelated.promptPath, 'utf8')).not.toContain('## The earlier tour')
  })
})
