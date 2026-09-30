// @vitest-environment node
// The tour's steps end to end over the synthetic pull request: prepare writes the prompt and the
// context, validate reads the model and the scene files, publish stores and shares, preview
// screenshots, and the CLI layer prints what the skill reads.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type CliIo, reportFailure } from '../commands.js'
import { TourContextSchema, TourArtifactSchema } from '../contract/tour.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { ghPost, makeTestContext, type TestContext } from '../testing/fakes.js'
import { GH_ISSUE_COMMENTS, ghFor42, gitFor42, gitForLocal, HEAD_SHA } from '../testing/synthetic.js'
import { syntheticTourModel } from '../testing/synthetic-tour.js'
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
async function writeModel(tourDir: string, scenesDir: string, model = syntheticTourModel()): Promise<void> {
  const landmarks = model.landmarks.map(({ scene: _scene, ...l }) => l)
  await writeFile(path.join(tourDir, 'tour-model.json'), JSON.stringify({ ...model, landmarks }))
  await mkdir(scenesDir, { recursive: true })
  for (const l of model.landmarks) await writeFile(path.join(scenesDir, `${l.id}.scene.html`), l.scene ?? '')
}

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
      budget: { landmarks: 4, decisions: 2, quiz: 2 },
      guide: null,
    })
    expect(result.sceneGuidePath).toMatch(/skills\/pr-tour\/scenes\.md$/)
    const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.stateRequired).toBe(false)
    expect(context.options).toEqual({ microWorld: true, tryIt: false, finalQuiz: 'on' })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).not.toContain('{{')
    expect(prompt).toContain('At most **4 landmarks**')
    expect(prompt).toContain('```diff')
    expect(prompt).toContain('The project has no guide')
    expect(prompt).toContain('"landmarks"')
    expect(await readFile(path.join(tourDir, 'tour.log'), 'utf8')).toMatch(/ prepared /)
  })

  it('raises the budget and requires a state landmark when the change touches a schema pattern', async () => {
    const config = { ...DEFAULT_PROJECT_CONFIG, highRisk: [{ pattern: 'src/app.ts', label: 'schema' }] }
    const result = await prepared({ projectConfig: { config, warnings: [], source: null } })
    expect(result.blastRadius).toEqual(['schema'])
    expect(result.budget).toEqual({ landmarks: 5, decisions: 3, quiz: 2 })
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
    await writeModel(first.tourDir, first.scenesDir)
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
    await writeModel(result.tourDir, result.scenesDir)
    const published = await publishTour(t.ctx, result.tourDir, OPTS)
    expect(published).toMatchObject({
      status: 'published',
      headSha: HEAD_SHA,
      attempts: 1,
      tourUrl: 'http://localhost:3010/tour/42',
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
    await writeModel(result.tourDir, result.scenesDir, { ...model, landmarks: model.landmarks.slice(1) })
    const err = await publishTour(t.ctx, result.tourDir, OPTS).catch(e => e)
    expect(err).toBeInstanceOf(TourInvalidError)
    const { io, out } = capture()
    expect(reportFailure(io, err)).toBe(5)
    expect(out.some(l => l.startsWith('LANDMARK_ORDER'))).toBe(true)
    expect(out.at(-1)).toContain('MODEL_INVALID')
    expect(await t.ctx.tours.exists(HEAD_SHA)).toBe(false)
    expect(await readFile(path.join(result.tourDir, 'tour.log'), 'utf8')).toMatch(/invalid attempts=1/)
  })

  it('keeps the tour local when sharing is off, and exports a zip when the post fails', async () => {
    const off = await prepared()
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, tour: { ...DEFAULT_PROJECT_CONFIG.tour, share: 'off' } },
      warnings: [],
      source: null,
    }
    await writeModel(off.tourDir, off.scenesDir)
    expect((await publishTour(t.ctx, off.tourDir, OPTS)).sharing).toEqual({ status: 'off' })
    await t.cleanup()
    const failing = await prepared()
    await writeModel(failing.tourDir, failing.scenesDir)
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
    await writeModel(result.tourDir, result.scenesDir)
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
    await writeModel(result.tourDir, result.scenesDir)
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
    await writeModel(result.tourDir, result.scenesDir)
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
    expect(preview.previewUrl).toBe('http://localhost:3010/tour/42?preview')
    expect(preview.screenshots.map(f => path.basename(f))).toEqual([
      '01-world-desktop.png',
      '01-world-phone.png',
    ])
    expect(shots).toEqual([
      { url: 'http://127.0.0.1:9/tour/42?preview&landmark=world&theme=light', width: 1280 },
      { url: 'http://127.0.0.1:9/tour/42?preview&landmark=world&theme=light', width: 390 },
    ])
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
    await writeModel(refs.tourDir, refs.scenesDir)
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
    await writeModel(result.tourDir, result.scenesDir)
    const invalid = capture()
    await writeFile(model, '{')
    expect(await runTour(t.ctx, ['validate', model, '--tour', result.tourDir], invalid.io)).toBe(5)
    expect(JSON.parse(invalid.out[0]!).errors[0].code).toBe('SCHEMA')
    await writeModel(result.tourDir, result.scenesDir)
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
  })

  it('reads the tour dir a command line names, so the data dir can follow it', () => {
    expect(namedTourDir(['validate', 'm.json', '--tour', '/d/tours/x'])).toBe('/d/tours/x')
    expect(namedTourDir(['publish', '/d/tours/x', '--agent', 'a'])).toBe('/d/tours/x')
    expect(namedTourDir(['preview', '/d/tours/x'])).toBe('/d/tours/x')
    expect(namedTourDir(['prepare', '--pr', '1'])).toBeUndefined()
    expect(tourStepCreatesDataDir(['prepare'])).toBe(true)
    expect(tourStepCreatesDataDir(['publish', 'x'])).toBe(false)
  })
})

describe('the tour prompt', () => {
  it('fills every token and refuses one it does not know', async () => {
    const result = await prepared()
    const context = TourContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    const patches = (await t.ctx.derived.ensure(HEAD_SHA, context.mergeBaseSha)).patches
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
