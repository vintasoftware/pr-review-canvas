// @vitest-environment node
import { readCanvasComment } from '../canvas/comment.js'
import { readCanvasZip } from '../canvas/zip.js'
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ReviewArtifactSchema, TEXT_CAPS } from '../contract/review-artifact.js'
import {
  createFakeGh,
  type FakeGit,
  ghJson,
  ghHandler,
  ghPost,
  makeTestContext,
  moveFakeHead,
  type TestContext,
} from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  GH_ISSUE_COMMENTS,
  ghFor42,
  gitFor42,
  HEAD_SHA,
  SYNTHETIC_DIFF,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { artifactToModelOutput, fingerprint, normalize } from './normalize.js'
import { prepare } from './prepare.js'
import { createApp } from '../server/app.js'
import {
  attemptsSincePrepare,
  ModelInvalidError,
  PublishError,
  type PublishOptions,
  publish,
  readContext,
} from './publish.js'

let t: TestContext
let clone: FakeGit
afterEach(() => t?.cleanup())

const OPTS: PublishOptions = { agent: 'claude', model: 'opus', harness: 'claude-code', allowStale: false }

async function prepared(target: Parameters<typeof prepare>[1] = { kind: 'pr', number: 42 }) {
  clone = gitFor42()
  t = await makeTestContext({ git: clone, gh: ghFor42() })
  const result = await prepare(t.ctx, target, { force: false, log: () => undefined })
  return result.canvasDir
}

/** The pull request's head moved to `sha` in the clone and on GitHub, with `diff` against the same merge base. */
function headMovedTo(sha: string, diff: string): void {
  moveFakeHead(clone, {
    headRef: 'pull/42/head',
    baseRef: 'refs/pr/42/base',
    headSha: sha,
    mergeBaseSha: BASE_SHA,
    diff,
  })
  t.ctx.gh = pullAt(sha)
}

/** GitHub with PR #42's head at `sha`. */
function pullAt(sha: string) {
  return createFakeGh({
    routes: { 'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha } }) },
  })
}

async function writeModel(canvasDir: string, value: unknown): Promise<void> {
  await writeFile(
    path.join(canvasDir, 'model.json'),
    typeof value === 'string' ? value : JSON.stringify(value)
  )
}

describe('publish', () => {
  it('validates, normalizes, writes review.json + manifest.json, indexes the canvas, and counts attempts', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const result = await publish(t.ctx, canvasDir, OPTS)
    expect(result).toEqual({
      status: 'published',
      sharing: expect.objectContaining({ status: 'failed', zipPath: expect.stringMatching(/\.zip$/) }),
      headSha: HEAD_SHA,
      reviewJsonPath: path.join(canvasDir, 'review.json'),
      attempts: 1,
      reviewUrl: 'http://localhost:3010/r/acme/widgets/review/42',
    })
    const context = await readContext(canvasDir)
    const stored = ReviewArtifactSchema.parse(JSON.parse(await readFile(result.reviewJsonPath, 'utf8')))
    expect(stored).toEqual(
      normalize(artifactToModelOutput(syntheticArtifact()), {
        pr: syntheticArtifact().pr,
        files: context.files,
        highRisk: [],
        caps: TEXT_CAPS,
        generatedAt: '2026-09-10T12:00:00.000Z',
        generator: { agent: 'claude', model: 'opus', harness: 'claude-code', attempts: 1 },
      })
    )
    expect(await t.ctx.canvases.readManifest(HEAD_SHA)).toEqual({
      formatVersion: 1,
      tool: { name: 'pr-review', version: '0.0.0-test' },
      repo: { owner: 'acme', name: 'widgets' },
      prNumber: 42,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: '2026-09-10T12:00:00.000Z',
      generator: { agent: 'claude', model: 'opus', harness: 'claude-code', attempts: 1 },
    })
    expect(await t.ctx.canvases.readIndex()).toEqual({
      canvases: { [HEAD_SHA]: { prNumber: 42, generatedAt: '2026-09-10T12:00:00.000Z', source: 'local' } },
    })
    expect(await t.ctx.canvases.findForPr(42, HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
    // A second run against the same prepared context is attempt 2, without a model id.
    const again = await publish(t.ctx, canvasDir, { agent: 'codex', harness: 'codex', allowStale: false })
    expect(again.attempts).toBe(2)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.generator).toEqual({
      agent: 'codex',
      harness: 'codex',
      attempts: 2,
    })
    expect(await readFile(path.join(canvasDir, 'publish.log'), 'utf8')).toBe(
      `2026-09-10T12:00:00.000Z prepared ${HEAD_SHA}\n2026-09-10T12:00:00.000Z published attempts=1\n2026-09-10T12:00:00.000Z published attempts=2\n`
    )
    // A new prepare keeps the history and restarts the count.
    await prepare(t.ctx, { kind: 'pr', number: 42 }, { force: true, log: () => undefined })
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    expect((await publish(t.ctx, canvasDir, OPTS)).attempts).toBe(1)
    expect(attemptsSincePrepare('')).toBe(0)
    expect(attemptsSincePrepare('x prepared a\nx published attempts=1\nx prepared b\n')).toBe(0)
    expect(attemptsSincePrepare('x invalid attempts=1 errors=1 A\nx invalid attempts=2 errors=1 B\n')).toBe(2)
    // Only the second field marks a prepare; the word elsewhere in a line does not.
    expect(attemptsSincePrepare('x prepared a\nx published attempts=1 prepared \n')).toBe(1)
  })

  it('shares the validated ZIP and preserves a usable fallback when sharing fails', async () => {
    const canvasDir = await prepared()
    await createApp(t.ctx).request('/api/prs/42', { headers: { host: 'localhost:3010' } })
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const bodies: string[] = []
    t.ctx.config.host = {
      ...t.ctx.config.host,
      shareCanvas: async (_client, _repo, _number, body) => {
        bodies.push(body)
        return {
          id: 1,
          author: 'octocat',
          body,
          createdAt: '2026-09-10T12:00:00.000Z',
          updatedAt: '2026-09-10T12:00:00.000Z',
          url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
        }
      },
    }
    const result = await publish(t.ctx, canvasDir, OPTS)
    expect(result.sharing).toEqual({
      status: 'shared',
      url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
    })
    expect(readCanvasZip(readCanvasComment(bodies[0]!)!.bytes).manifest.headSha).toBe(HEAD_SHA)

    expect((await t.ctx.prs.readComments(42))?.issueComments).toContainEqual(
      expect.objectContaining({ id: 1, body: bodies[0] })
    )
    for (const failure of [new Error('permission denied'), 'network unavailable']) {
      t.ctx.config.host.shareCanvas = async () => {
        throw failure
      }
      const failed = await publish(t.ctx, canvasDir, OPTS)
      expect(failed.sharing.status).toBe('failed')
      if (failed.sharing.status !== 'failed') throw new Error('expected fallback')
      expect(failed.sharing.warning).toContain('Upload the ZIP')
      expect(readCanvasZip(await readFile(failed.sharing.zipPath)).manifest.headSha).toBe(HEAD_SHA)
      expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
    }
    t.ctx.config.host = { ...t.ctx.config.host, canvasCommentLimit: 10, shareCanvas: vi.fn() }
    const oversized = await publish(t.ctx, canvasDir, OPTS)
    expect(oversized.sharing).toMatchObject({
      status: 'failed',
      warning: expect.stringContaining('host limit is 10'),
    })
    expect(t.ctx.config.host.shareCanvas).not.toHaveBeenCalled()
  })

  it('fetches the complete conversation after a CLI publish with no prior comments cache', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    let shared: Record<string, unknown> | undefined
    t.ctx.gh = ghFor42({
      routes: {
        'repos/acme/widgets/issues/42/comments': ghHandler(() => [
          ...GH_ISSUE_COMMENTS,
          ...(shared === undefined ? [] : [shared]),
        ]),
      },
      postRoutes: {
        'repos/acme/widgets/issues/42/comments': ghPost(body => {
          shared = { ...GH_ISSUE_COMMENTS[0], id: 6001, ...(body as object) }
          return shared
        }),
      },
    })
    expect((await publish(t.ctx, canvasDir, OPTS)).sharing.status).toBe('shared')
    expect(await t.ctx.prs.readComments(42)).toBeNull()
    const res = await createApp(t.ctx).request('/api/prs/42/review/body', {
      headers: { host: 'localhost:3010' },
    })
    expect(res.status).toBe(200)
    expect((await t.ctx.prs.readComments(42))?.issueComments.map(c => c.id)).toEqual([
      ...GH_ISSUE_COMMENTS.map(c => c.id),
      6001,
    ])
  })

  it('keeps the canvas local when the config turns the canvas comment off, and the user file wins', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const shareCanvas = vi.fn(async () => ({
      id: 1,
      author: 'octocat',
      body: '',
      createdAt: '2026-09-10T12:00:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
    }))
    t.ctx.config.host = { ...t.ctx.config.host, shareCanvas }
    const project = t.ctx.projectConfig.config
    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...project, sharing: { ...project.sharing, canvasComment: false } },
    }

    const off = await publish(t.ctx, canvasDir, OPTS)
    expect(off.sharing).toEqual({ status: 'off' })
    expect(off.reviewUrl).toMatch(/\/review\/42$/)
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
    expect(shareCanvas).not.toHaveBeenCalled()

    await t.ctx.settings.write({})
    await writeFile(
      t.ctx.settings.file,
      (await readFile(t.ctx.settings.file, 'utf8')).replace('canvasComment: null', 'canvasComment: true')
    )
    expect((await publish(t.ctx, canvasDir, OPTS)).sharing.status).toBe('shared')

    t.ctx.projectConfig = { ...t.ctx.projectConfig, config: project }
    await writeFile(
      t.ctx.settings.file,
      (await readFile(t.ctx.settings.file, 'utf8')).replace('canvasComment: true', 'canvasComment: false')
    )
    expect((await publish(t.ctx, canvasDir, OPTS)).sharing).toEqual({ status: 'off' })
    expect(shareCanvas).toHaveBeenCalledTimes(1)
  })

  it('keeps the canvas local when the run turns sharing off, whatever the settings say', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const shareCanvas = vi.fn()
    t.ctx.config.host = { ...t.ctx.config.host, shareCanvas }

    const result = await publish(t.ctx, canvasDir, { ...OPTS, share: false })
    expect(result.sharing).toEqual({ status: 'off' })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
    expect(shareCanvas).not.toHaveBeenCalled()
  })

  it('refuses an invalid model with the report, logs the attempt, and writes no review.json', async () => {
    const canvasDir = await prepared()
    const output = artifactToModelOutput(syntheticArtifact())
    output.layers[1]?.files.pop()
    output.summary = 's'.repeat(1201)
    await writeModel(canvasDir, output)
    const err = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(err).toBeInstanceOf(ModelInvalidError)
    expect(err).toMatchObject({
      message: 'model.json has 2 problems',
      attempts: 1,
      report: {
        ok: false,
        errors: [
          {
            code: 'TEXT_TOO_LONG',
            message: expect.stringContaining('summary: 1201 visible chars, cap 1200;'),
          },
          { code: 'HUNK_UNASSIGNED' },
        ],
      },
    })
    output.summary = 'fine'
    await writeModel(canvasDir, output)
    const second = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(second).toMatchObject({
      message: 'model.json has 1 problem',
      attempts: 2,
      report: { errors: [{ code: 'HUNK_UNASSIGNED' }] },
    })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    expect(await t.ctx.canvases.readIndex()).toEqual({ canvases: {} })
    expect(await readFile(path.join(canvasDir, 'publish.log'), 'utf8')).toBe(
      `2026-09-10T12:00:00.000Z prepared ${HEAD_SHA}\n2026-09-10T12:00:00.000Z invalid attempts=1 errors=2 TEXT_TOO_LONG,HUNK_UNASSIGNED\n2026-09-10T12:00:00.000Z invalid attempts=2 errors=1 HUNK_UNASSIGNED\n`
    )
    // The third try succeeds and carries the attempt count.
    output.layers[1]?.files.push({ path: 'src/gone.ts', hunks: ['src_gone_ts#1'], annotations: [] })
    await writeModel(canvasDir, output)
    expect((await publish(t.ctx, canvasDir, OPTS)).attempts).toBe(3)
  })

  it('treats model.json that is not JSON, or missing, as a failure without a partial write', async () => {
    const canvasDir = await prepared()
    const missing = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(missing).toBeInstanceOf(PublishError)
    expect(missing).toMatchObject({
      code: 'NOT_FOUND',
      message: `${path.join(canvasDir, 'model.json')} does not exist`,
    })
    await writeModel(canvasDir, '{ not json')
    const bad = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(bad).toBeInstanceOf(ModelInvalidError)
    expect(bad.report.errors).toEqual([
      { code: 'SCHEMA', where: '(root)', message: expect.stringMatching(/^model\.json is not valid JSON: /) },
    ])
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
  })

  it('accepts a covered test path that exists at the PR head without being in the diff', async () => {
    const canvasDir = await prepared()
    const git = gitFor42()
    git.options.blobs = { ...git.options.blobs, [`${HEAD_SHA}:src/old.test.ts`]: 'test("old")' }
    t.ctx.git = git
    const output = artifactToModelOutput(syntheticArtifact())
    output.layers[0]?.tests.push(
      { behavior: 'old path still works', status: 'covered', testPath: 'src/old.test.ts' },
      { behavior: 'ghost', status: 'covered', testPath: 'src/nope.test.ts' }
    )
    await writeModel(canvasDir, output)
    const err = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(err).toBeInstanceOf(ModelInvalidError)
    expect(err.report.errors).toEqual([
      {
        code: 'TEST_PATH_UNKNOWN',
        where: 'layer:run-path',
        message: 'layer run-path: src/nope.test.ts is not in the PR head',
      },
    ])
    expect(git.calls.filter(c => c[0] === 'cat-file' && c[1] === '-s').map(c => c[2])).toEqual([
      `${HEAD_SHA}:src/old.test.ts`,
      `${HEAD_SHA}:src/nope.test.ts`,
    ])
    output.layers[0]?.tests.pop()
    await writeModel(canvasDir, output)
    expect((await publish(t.ctx, canvasDir, OPTS)).status).toBe('published')
  })

  it('refuses a canvas dir that is not where its data dir keeps it, and writes nothing', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const log = await readFile(path.join(canvasDir, 'publish.log'), 'utf8')
    // Prepared under one data dir, published by a context on another, as with a --data-dir that
    // names the main checkout's while the canvas sits in a sandbox.
    const other = await makeTestContext({ git: clone, gh: ghFor42() })
    const err = await publish(other.ctx, canvasDir, OPTS).catch(e => e)
    const written = await readdir(other.dataDir, { recursive: true })
    await other.cleanup()
    expect(err).toBeInstanceOf(PublishError)
    expect(err).toMatchObject({
      code: 'CANVAS_ELSEWHERE',
      message: `${canvasDir} is not the canvas dir of ${HEAD_SHA.slice(0, 7)} in ${other.dataDir}; publishing would write ${other.ctx.canvases.canvasDir(HEAD_SHA)}`,
      hint: 'publish the canvasDir prepare printed, with the --data-dir prepare used or none',
    })
    expect(written).toEqual([])
    // A copy of the canvas dir is refused the same way.
    const copy = path.join(t.dataDir, 'copy')
    await cp(canvasDir, copy, { recursive: true })
    await expect(publish(t.ctx, copy, OPTS)).rejects.toMatchObject({ code: 'CANVAS_ELSEWHERE' })
    expect(await readFile(path.join(canvasDir, 'publish.log'), 'utf8')).toBe(log)
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
  })

  it('refuses when context.json is missing', async () => {
    t = await makeTestContext()
    const err = await publish(t.ctx, path.join(t.dataDir, 'nowhere'), OPTS).catch(e => e)
    expect(err).toBeInstanceOf(PublishError)
    expect(err).toMatchObject({ code: 'NOT_FOUND', hint: 'run `pr-review prepare` first' })
  })

  it('records the basis canvas of an incremental run on the canvas it stores', async () => {
    const canvasDir = await prepared()
    const basis = 'e'.repeat(40)
    // prepare found no basis here; write one into the context the way an incremental run would.
    const contextPath = path.join(canvasDir, 'context.json')
    const context = JSON.parse(await readFile(contextPath, 'utf8')) as Record<string, unknown>
    context['basis'] = {
      canvasSha: basis,
      reviewJsonPath: path.join(canvasDir, 'review.json'),
      files: { unchanged: [], changed: [], added: [], removed: [] },
      layers: [],
      points: [],
    }
    await writeFile(contextPath, JSON.stringify(context))
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    await publish(t.ctx, canvasDir, OPTS)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.basisCanvasSha).toBe(basis)
  })

  it('keeps the author’s settlements when the same commit is generated again, for the points still there', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    await publish(t.ctx, canvasDir, OPTS)
    const first = await t.ctx.canvases.readArtifact(HEAD_SHA)
    const kept = fingerprint({ kind: 'debt', path: 'src/gone.ts', title: 'Deleted file had no owner' })
    // A reviewer point keeps its settlement too: the author may resolve any point.
    const reviewer = fingerprint({ kind: 'decision', path: 'src/app.ts', title: 'Sum instead of product' })
    const settlement = { reason: 'Nothing imports it.', at: '2026-09-10T12:00:00.000Z' }
    await t.ctx.canvases.revise(HEAD_SHA, {
      ...first!,
      settled: { [kept]: settlement, [reviewer]: settlement, gone: settlement },
      revisedAt: settlement.at,
    })
    await publish(t.ctx, canvasDir, OPTS)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toEqual({
      [kept]: settlement,
      [reviewer]: settlement,
    })
  })

  it('regenerates over a canvas of a format it no longer reads, keeping no settlement from it', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    await publish(t.ctx, canvasDir, OPTS)
    await writeFile(path.join(t.ctx.canvases.canvasDir(HEAD_SHA), 'review.json'), '{"version":0}')
    await publish(t.ctx, canvasDir, OPTS)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toBeUndefined()
  })

  it('carries the basis canvas’s settlements only for the points the basis split carried', async () => {
    const canvasDir = await prepared()
    const basisSha = 'e'.repeat(40)
    const carried = { kind: 'debt', path: 'src/gone.ts', title: 'Deleted file had no owner' } as const
    const reJudged = { kind: 'tests', path: 'src/app.ts', title: 'other() returns x' } as const
    const settlement = { reason: 'Agreed with the team.', at: '2026-09-09T12:00:00.000Z' }
    await t.ctx.canvases.write(
      basisSha,
      {
        ...syntheticArtifact(),
        settled: { [fingerprint(carried)]: settlement, [fingerprint(reJudged)]: settlement },
      },
      {
        formatVersion: 1,
        tool: { name: 'pr-review', version: '0' },
        repo: { owner: 'acme', name: 'widgets' },
        headSha: basisSha,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: '2026-09-09T11:00:00.000Z',
        generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
      },
      42
    )
    const contextPath = path.join(canvasDir, 'context.json')
    const context = JSON.parse(await readFile(contextPath, 'utf8')) as Record<string, unknown>
    context['basis'] = {
      canvasSha: basisSha,
      reviewJsonPath: path.join(canvasDir, 'review.json'),
      files: { unchanged: ['src/gone.ts'], changed: ['src/app.ts'], added: [], removed: [] },
      layers: [],
      points: [
        { ...carried, status: 'carried' },
        { ...reJudged, status: 're-judged' },
      ],
    }
    await writeFile(contextPath, JSON.stringify(context))
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    await publish(t.ctx, canvasDir, OPTS)
    expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toEqual({
      [fingerprint(carried)]: settlement,
    })
  })

  it('publishes for a head that moved on with the identical diff', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const merged = 'e'.repeat(40)
    const moved = 'd'.repeat(40)
    headMovedTo(merged, SYNTHETIC_DIFF)
    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...t.ctx.projectConfig.config, canvas: { keepForIdenticalDiff: false, incremental: true } },
    }
    await expect(publish(t.ctx, canvasDir, OPTS)).rejects.toMatchObject({ code: 'CANVAS_STALE' })
    t.ctx.projectConfig = {
      ...t.ctx.projectConfig,
      config: { ...t.ctx.projectConfig.config, canvas: { keepForIdenticalDiff: true, incremental: true } },
    }
    // A base merge that moved the hunks down is another diff.
    headMovedTo(moved, SYNTHETIC_DIFF_MOVED_BY_BASE)
    await expect(publish(t.ctx, canvasDir, OPTS)).rejects.toMatchObject({ code: 'CANVAS_STALE' })
    headMovedTo(merged, SYNTHETIC_DIFF)
    const result = await publish(t.ctx, canvasDir, OPTS)
    expect(result.status).toBe('published')
    // The canvas is stored under the commit it was prepared for, which the merged head stands for.
    expect(result.headSha).toBe(HEAD_SHA)
  })

  it('refuses a canvas whose PR head moved unless --allow-stale, and checks refs targets against the ref', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const moved = 'e'.repeat(40)
    // Force-pushed, with another diff: the fetched head does not stand for the prepared commit.
    headMovedTo(moved, SYNTHETIC_DIFF_MOVED_BY_BASE)
    const err = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(err).toBeInstanceOf(PublishError)
    expect(err).toMatchObject({
      code: 'CANVAS_STALE',
      message: `the target moved to ${moved.slice(0, 7)} while this canvas was prepared for ${HEAD_SHA.slice(0, 7)}`,
    })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    expect((await publish(t.ctx, canvasDir, { ...OPTS, allowStale: true })).status).toBe('published')
    await t.cleanup()

    const refsDir = await prepared({ kind: 'refs', base: 'main', head: 'feat/b' })
    await writeModel(refsDir, artifactToModelOutput(syntheticArtifact()))
    t.ctx.git.revParse = async () => moved
    await expect(publish(t.ctx, refsDir, OPTS)).rejects.toMatchObject({ code: 'CANVAS_STALE' })
    t.ctx.git.revParse = async () => HEAD_SHA
    const ok = await publish(t.ctx, refsDir, OPTS)
    expect(ok.status).toBe('published')
    expect(ok.sharing).toEqual({ status: 'local' })
    // A pre-PR canvas is indexed without a PR number and its manifest carries none.
    expect(await t.ctx.canvases.readIndex()).toEqual({
      canvases: { [HEAD_SHA]: { generatedAt: '2026-09-10T12:00:00.000Z', source: 'local' } },
    })
    expect((await t.ctx.canvases.readManifest(HEAD_SHA))?.prNumber).toBeUndefined()
    await rm(refsDir, { recursive: true, force: true })
  })
})
