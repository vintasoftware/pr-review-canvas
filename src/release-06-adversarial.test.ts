// Release 0.6 regressions and explicitly deferred audit cases.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { buildCanvasZipFor } from './canvas/export.js'
import { importCanvas } from './canvas/import.js'
import { buildCanvasZip } from './canvas/zip.js'
import { createCheckoutGit, createReviewCheckouts } from './chat/checkouts.js'
import { runClean } from './commands.js'
import type { CanvasManifest } from './contract/canvas-manifest.js'
import { ReviewArtifactSchema } from './contract/review-artifact.js'
import { envWithoutRepo } from './git/environment.mjs'
import { gitlabHost } from './host/host.js'
import { artifactToModelOutput } from './review/normalize.js'
import { applyFoldFixes } from './review/fix-folds.js'
import { prepare } from './review/prepare.js'
import { createApp } from './server/app.js'
import { applySettings, parseSettings } from './store/settings-store.js'
import {
  createFakeCheckoutGit,
  createFakeGh,
  ghJson,
  ghPost,
  makeTempDir,
  makeTestContext,
  type TestContext,
} from './testing/fakes.js'
import { BASE_SHA, ghFor42, gitFor42, gitForLocal, HEAD_SHA, syntheticArtifact } from './testing/synthetic.js'

const contexts: TestContext[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(t => t.cleanup()))
  await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true })))
})
const headers = {
  host: 'localhost:3010',
  'content-type': 'application/json',
  'sec-fetch-site': 'same-origin',
}
const manifest: CanvasManifest = {
  formatVersion: 1,
  tool: { name: 'pr-review', version: '0.5.0' },
  repo: syntheticArtifact().pr.repo,
  prNumber: 42,
  headSha: HEAD_SHA,
  mergeBaseSha: BASE_SHA,
  baseRef: 'main',
  headRef: 'feat/b',
  generatedAt: syntheticArtifact().generatedAt,
  generator: syntheticArtifact().generator,
}
async function context(local = false) {
  const t = await makeTestContext({
    git: local ? gitForLocal({ head: HEAD_SHA }) : gitFor42(),
    gh: ghFor42(),
  })
  contexts.push(t)
  t.ctx.projectConfig = {
    ...t.ctx.projectConfig,
    config: { ...t.ctx.projectConfig.config, sharing: { canvasComment: false, mentionCanvas: false } },
  }
  return t
}

it('0.5 canvases without audience remain readable and default to reviewer points', () => {
  const old = JSON.parse(JSON.stringify(syntheticArtifact()))
  old.points.forEach((p: Record<string, unknown>) => delete p['audience'])
  expect(ReviewArtifactSchema.parse(old).points.every(p => p.audience === 'reviewer')).toBe(true)
})

it.each([
  'agent: codex\nmodel: old-model\n',
  'agent: claude\nchatAgent: codex\nmodel: discarded\nchatModel: old-model\n',
])('legacy settings migrate without losing personal sharing settings (%#)', legacy => {
  const saved = applySettings(legacy + 'canvasComment: false\nmentionCanvas: false\n', { layerView: 'one' })
  expect(parseSettings(saved.text)).toMatchObject({
    chatAgent: 'codex',
    chatModel: 'old-model',
    layerView: 'one',
    canvasComment: false,
    mentionCanvas: false,
  })
  expect(saved.text).not.toMatch(/^agent:|^model:/m)
})

it.each(['branch', 'uncommitted'] as const)(
  '%s self-review rejects a settlement sent from an older head',
  async source => {
    const t = await context(true)
    const artifact = syntheticArtifact()
    const { prNumber: _number, ...localManifest } = manifest
    const prepared = await prepare(
      t.ctx,
      { kind: 'local', source, base: 'origin/main' },
      { force: false, log: () => undefined }
    )
    artifact.pr = {
      ...artifact.pr,
      headSha: prepared.headSha,
      number: null,
      state: source,
      baseRef: 'origin/main',
    }
    await t.ctx.canvases.write(prepared.headSha, artifact, { ...localManifest, headSha: prepared.headSha })
    const app = createApp(t.ctx)
    const response = await app.request(`/api/prs/${source}/points/fp-2/settled`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settled: true, reason: 'Reason for the old code', headSha: BASE_SHA }),
    })
    expect(response.status).toBe(409)
    expect((await t.ctx.canvases.readArtifact(prepared.headSha))?.settled).toBeUndefined()
    const current = await app.request(`/api/prs/${source}/points/fp-2/settled`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        settled: true,
        reason: 'Answer for the current code',
        headSha: prepared.headSha,
      }),
    })
    expect(current.status).toBe(200)
    const staleReopen = await app.request(`/api/prs/${source}/points/fp-2/settled`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settled: false, headSha: BASE_SHA }),
    })
    expect(staleReopen.status).toBe(409)
    expect((await t.ctx.canvases.readArtifact(prepared.headSha))?.settled?.['fp-2']?.reason).toBe(
      'Answer for the current code'
    )
  }
)

it('settle and reopen changes survive export and refresh import at the same commit', async () => {
  const author = await context()
  const reader = await context()
  await author.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifest, 42)
  await reader.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifest, 42)
  let time = Date.parse('2026-09-20T12:00:00Z')
  author.ctx.now = () => new Date(time++)
  for (const settled of [true, false]) {
    const response = await createApp(author.ctx).request('/api/prs/42/points/fp-2/settled', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settled, reason: 'Already tested', headSha: HEAD_SHA }),
    })
    expect(response.status).toBe(200)
    const zip = await buildCanvasZipFor(author.ctx, HEAD_SHA, 42)
    await importCanvas(reader.ctx, { bytes: zip.bytes, prNumber: 42 })
    expect(Boolean((await reader.ctx.canvases.readArtifact(HEAD_SHA))?.settled?.['fp-2'])).toBe(settled)
  }
})

it('concurrent canvas revisions cannot let an older import overwrite a settlement', async () => {
  const t = await context()
  const otherSha = 'c'.repeat(40)
  const artifact = syntheticArtifact()
  const other = { ...artifact, pr: { ...artifact.pr, headSha: otherSha, number: 43 } }
  const otherManifest = { ...manifest, headSha: otherSha, prNumber: 43 }
  await t.ctx.canvases.write(HEAD_SHA, artifact, manifest, 42)
  await t.ctx.canvases.write(otherSha, other, otherManifest, 43)
  // Another machine shared these revisions before either of our new settlements.
  const oldZips = [
    { bytes: buildCanvasZip(manifest, { ...artifact, revisedAt: '2026-09-15T12:00:00.000Z' }), prNumber: 42 },
    {
      bytes: buildCanvasZip(otherManifest, { ...other, revisedAt: '2026-09-15T12:00:00.000Z' }),
      prNumber: 43,
    },
  ]
  const revisedAt = '2026-09-20T12:00:00.000Z'
  const settled = { 'fp-2': { reason: 'The latest answer', at: revisedAt } }
  await Promise.all([
    t.ctx.canvases.revise(HEAD_SHA, { ...artifact, revisedAt, settled }),
    t.ctx.canvases.revise(otherSha, { ...other, revisedAt, settled }),
  ])
  for (const zip of oldZips) await importCanvas(t.ctx, { bytes: zip.bytes, prNumber: zip.prNumber })
  expect((await t.ctx.canvases.readArtifact(HEAD_SHA))?.settled).toEqual(settled)
  expect((await t.ctx.canvases.readArtifact(otherSha))?.settled).toEqual(settled)
})

// Fault injection outside this fix's scope; preserve the audit observation as an expected failure.
it.fails('checkout listing ignores manually malformed metadata instead of returning an invalid row', async () => {
  const root = await makeTempDir('release06-meta-')
  directories.push(root)
  const store = createReviewCheckouts({ root, git: createFakeCheckoutGit(), now: () => new Date() })
  const lease = await store.lease(42, 'chat')
  await lease.moveTo(HEAD_SHA)
  await lease.release()
  await writeFile(path.join(root, '43.json'), '{}')
  expect((await store.list()).map(row => row.key)).toEqual([42])
})

it('clean dry-run, active lock protection, and never-clean settings agree', async () => {
  const t = await context()
  const lease = await t.ctx.checkouts.lease(42, 'chat')
  await lease.moveTo(HEAD_SHA)
  expect(await t.ctx.checkouts.sweep({ all: true, dryRun: true })).toMatchObject({
    removed: [],
    skipped: [{ key: 42 }],
  })
  expect(await t.ctx.checkouts.sweep({ all: true })).toMatchObject({ removed: [], skipped: [{ key: 42 }] })
  await lease.release()
  await t.ctx.settings.write({ checkoutIdleDays: -1 })
  const output: string[] = []
  await runClean(t.ctx, [], { stdout: line => output.push(line), stderr: () => undefined, json: true })
  expect(JSON.parse(output[0]!)).toMatchObject({ removed: [] })
  expect(await t.ctx.checkouts.list()).toHaveLength(1)
  await runClean(t.ctx, ['--all'], { stdout: () => undefined, stderr: () => undefined, json: true })
  expect(await t.ctx.checkouts.list()).toEqual([])
})

it('review checkout uses the reviewed commit without running hooks or touching reader edits', async () => {
  const root = await makeTempDir('release06-git-')
  directories.push(root)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env: envWithoutRepo(), encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Release audit')
  git('config', 'user.email', 'audit@example.test')
  await writeFile(path.join(root, 'app.txt'), 'reviewed\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'reviewed commit')
  const sha = git('rev-parse', 'HEAD')
  await writeFile(path.join(root, 'app.txt'), 'reader edits\n')
  await writeFile(path.join(root, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 123\n', { mode: 0o755 })
  const store = createReviewCheckouts({
    root: path.join(root, 'data/checkouts'),
    git: createCheckoutGit(root),
    now: () => new Date(),
  })
  const lease = await store.lease(42, 'chat')
  await lease.moveTo(sha)
  expect(await readFile(path.join(lease.dir, 'app.txt'), 'utf8')).toBe('reviewed\n')
  expect(await readFile(path.join(root, 'app.txt'), 'utf8')).toBe('reader edits\n')
  await lease.release()
  await store.sweep({ all: true })
  expect(git('worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
})

it('fold repair is idempotent across out-of-bounds and duplicate ranges', () => {
  const artifact = syntheticArtifact()
  const output = artifactToModelOutput(artifact)
  output.points = []
  for (const layer of output.layers) layer.tests = []
  output.layers[0]!.files[0]!.folds = [
    { title: 'Too long', side: 'new', startLine: 3, endLine: 100, level: 'moderate' },
    { title: 'Duplicate after clipping', side: 'new', startLine: 3, endLine: 5, level: 'aggressive' },
  ]
  expect(applyFoldFixes(output, artifact.files)).toHaveLength(2)
  expect(applyFoldFixes(output, artifact.files)).toEqual([])
})

it('personal sharing overrides apply to publish-facing APIs and survive settings save', async () => {
  const t = await context()
  await mkdir(path.dirname(t.ctx.settings.file), { recursive: true })
  await writeFile(t.ctx.settings.file, 'canvasComment: false\nmentionCanvas: false\n')
  await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifest, 42)
  const app = createApp(t.ctx)
  const saved = await app.request('/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ layerView: 'one' }),
  })
  expect(saved.status).toBe(200)
  const bundle = await app.request('/api/prs/42', { headers })
  expect(await bundle.json()).toMatchObject({ canvasComment: false, mentionCanvas: false })
})

it('posting a multiline settlement preserves the attention point range', async () => {
  const forge = ghFor42({
    postRoutes: {
      'repos/acme/widgets/pulls/42/comments': ghPost(body => ({
        id: 888,
        user: { login: 'octocat' },
        created_at: '2026-09-10T12:00:00Z',
        html_url: 'https://github.com/acme/widgets/pull/42#discussion_r888',
        ...(body as Record<string, unknown>),
      })),
    },
  })
  const t = await makeTestContext({ git: gitFor42(), gh: forge })
  contexts.push(t)
  t.ctx.projectConfig = {
    ...t.ctx.projectConfig,
    config: { ...t.ctx.projectConfig.config, sharing: { canvasComment: false, mentionCanvas: false } },
  }
  const artifact = syntheticArtifact()
  artifact.points[0] = { ...artifact.points[0]!, audience: 'author', line: 3, endLine: 5 }
  await t.ctx.canvases.write(HEAD_SHA, artifact, manifest, 42)
  await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
  const response = await createApp(t.ctx).request('/api/prs/42/points/fp-1/settled', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      settled: true,
      reason: 'All three lines are covered',
      comment: true,
      headSha: HEAD_SHA,
    }),
  })
  expect(response.status).toBe(200)
  const posted = forge.calls.find(c => c.kind === 'post')
  expect(posted?.body).toMatchObject({ start_line: 3, line: 5, start_side: 'RIGHT', side: 'RIGHT' })
})

it('GitLab self-review posts the reason and shares the revised canvas, then reopens it', async () => {
  const base = 'projects/acme%2Fwidgets/merge_requests/42'
  const note = (id: number, body: string) => ({
    id,
    body,
    author: { username: 'octocat' },
    created_at: '2026-09-20T12:00:00Z',
  })
  const forge = createFakeGh({
    routes: {
      user: ghJson({ username: 'octocat' }),
      'projects/acme%2Fwidgets': ghJson({
        permissions: { project_access: { access_level: 30 }, group_access: null },
      }),
      [base]: ghJson({
        iid: 42,
        title: 'Test MR',
        description: '',
        updated_at: '2026-09-20T12:00:00Z',
        web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42',
        state: 'opened',
        target_branch: 'main',
        source_branch: 'feat/b',
        sha: HEAD_SHA,
        author: { username: 'octocat' },
        diff_refs: { base_sha: BASE_SHA, head_sha: HEAD_SHA, start_sha: BASE_SHA },
      }),
      [`${base}/notes`]: ghJson([]),
      [`${base}/discussions`]: ghJson([]),
    },
    postRoutes: {
      [`${base}/notes`]: ghPost(body => note(6001, (body as { body: string }).body)),
      [`${base}/discussions`]: ghPost(body => ({
        id: 'd1',
        notes: [
          {
            ...note(5001, (body as { body: string }).body),
            position: (body as { position: unknown }).position,
          },
        ],
      })),
    },
  })
  const git = gitFor42()
  git.options.refs!['merge-requests/42/head'] = HEAD_SHA
  const t = await makeTestContext({ git, gh: forge, host: gitlabHost('gitlab.example.com') })
  contexts.push(t)
  await t.ctx.canvases.write(HEAD_SHA, syntheticArtifact(), manifest, 42)
  await t.ctx.derived.ensure(HEAD_SHA, BASE_SHA)
  const app = createApp(t.ctx)
  const response = await app.request('/api/prs/42/points/fp-2/settled', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ settled: true, reason: 'Covered externally', comment: true, headSha: HEAD_SHA }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  expect(await response.json()).toMatchObject({
    sharing: { status: 'shared' },
    settled: { 'fp-2': { commentUrl: expect.stringContaining('#note_5001') } },
  })
  const reopened = await app.request('/api/prs/42/points/fp-2/settled', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ settled: false, headSha: HEAD_SHA }),
  })
  expect(await reopened.json()).toMatchObject({ settled: {}, sharing: { status: 'shared' } })
})
