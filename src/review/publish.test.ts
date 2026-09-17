// @vitest-environment node
import { readCanvasComment } from '../canvas/comment.js'
import { readCanvasZip } from '../canvas/zip.js'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ReviewArtifactSchema, TEXT_CAPS } from '../contract/review-artifact.js'
import { createFakeGh, ghJson, makeTestContext, type TestContext } from '../testing/fakes.js'
import { BASE_SHA, GH_PULL, ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { artifactToModelOutput, normalize } from './normalize.js'
import { prepare } from './prepare.js'
import {
  attemptsSincePrepare,
  ModelInvalidError,
  PublishError,
  type PublishOptions,
  publish,
  readContext,
} from './publish.js'

let t: TestContext
afterEach(() => t?.cleanup())

const OPTS: PublishOptions = { agent: 'claude', model: 'opus', harness: 'claude-code', allowStale: false }

async function prepared(target: Parameters<typeof prepare>[1] = { kind: 'pr', number: 42 }) {
  t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
  const result = await prepare(t.ctx, target, { force: false, log: () => undefined })
  return result.canvasDir
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
      reviewUrl: 'http://localhost:3010/review/42',
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
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const bodies: string[] = []
    t.ctx.config.host = {
      ...t.ctx.config.host,
      shareCanvas: async (_client, _repo, _number, body) => {
        bodies.push(body)
        return 'https://github.com/acme/widgets/pull/42#issuecomment-1'
      },
    }
    const result = await publish(t.ctx, canvasDir, OPTS)
    expect(result.sharing).toEqual({
      status: 'shared',
      url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
    })
    expect(readCanvasZip(readCanvasComment(bodies[0]!)!.bytes).manifest.headSha).toBe(HEAD_SHA)

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
          { code: 'CHUNK_UNASSIGNED' },
        ],
      },
    })
    output.summary = 'fine'
    await writeModel(canvasDir, output)
    const second = await publish(t.ctx, canvasDir, OPTS).catch(e => e)
    expect(second).toMatchObject({
      message: 'model.json has 1 problem',
      attempts: 2,
      report: { errors: [{ code: 'CHUNK_UNASSIGNED' }] },
    })
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(false)
    expect(await t.ctx.canvases.readIndex()).toEqual({ canvases: {} })
    expect(await readFile(path.join(canvasDir, 'publish.log'), 'utf8')).toBe(
      `2026-09-10T12:00:00.000Z prepared ${HEAD_SHA}\n2026-09-10T12:00:00.000Z invalid attempts=1 errors=2 TEXT_TOO_LONG,CHUNK_UNASSIGNED\n2026-09-10T12:00:00.000Z invalid attempts=2 errors=1 CHUNK_UNASSIGNED\n`
    )
    // The third try succeeds and carries the attempt count.
    output.layers[1]?.files.push({ path: 'src/gone.ts', chunks: ['src_gone_ts#1'], annotations: [] })
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

  it('refuses when context.json is missing', async () => {
    t = await makeTestContext()
    const err = await publish(t.ctx, path.join(t.dataDir, 'nowhere'), OPTS).catch(e => e)
    expect(err).toBeInstanceOf(PublishError)
    expect(err).toMatchObject({ code: 'NOT_FOUND', hint: 'run `pr-review prepare` first' })
  })

  it('refuses a canvas whose PR head moved unless --allow-stale, and checks refs targets against the ref', async () => {
    const canvasDir = await prepared()
    await writeModel(canvasDir, artifactToModelOutput(syntheticArtifact()))
    const moved = 'e'.repeat(40)
    t.ctx.gh = createFakeGh({
      routes: {
        'repos/acme/widgets/pulls/42': ghJson({ ...GH_PULL, head: { ...GH_PULL.head, sha: moved } }),
      },
    })
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
