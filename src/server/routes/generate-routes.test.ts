// @vitest-environment node
// The generate routes through Hono: start, status, stop, and the refusals before a job starts.
import { writeFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Capabilities, ErrorEnvelope } from '../../contract/api.js'
import type { GenerationJob, GenerationResponse } from '../../contract/generation.js'
import { GenerationBusyError, type GenerationManager } from '../../generate/generation-manager.js'
import { gitlabHost } from '../../host/host.js'
import { DEFAULT_PROJECT_CONFIG } from '../../project-config.js'
import { artifactToModelOutput } from '../../review/normalize.js'
import { createFakeRunner } from '../../testing/fake-runner.js'
import { makeTestContext, type TestContext } from '../../testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from '../../testing/synthetic.js'
import { createApp } from '../app.js'
import { toAppError } from '../errors.js'
import { generateRoutes } from './generate-routes.js'

const LOCAL = { host: '127.0.0.1:3010' }
const POST = { ...LOCAL, origin: 'http://127.0.0.1:3010', 'content-type': 'application/json' }

const JOB: GenerationJob = {
  key: 42,
  force: false,
  agent: 'claude',
  model: 'opus',
  phase: 'preparing',
  round: 1,
  maxRounds: 4,
  startedAt: '2026-10-05T12:00:00.000Z',
  activity: [],
}

let t: TestContext

afterEach(async () => {
  await t.cleanup()
})

async function context(opts: { chat?: boolean; acpx?: string | null } = {}): Promise<TestContext> {
  t = await makeTestContext({
    // A host CLI that is logged in, so a PR's canvas could be shared.
    gh: ghFor42(),
    runner: createFakeRunner({ acpxVersion: opts.acpx === undefined ? '0.19.4' : opts.acpx }),
    projectConfig: {
      config: { ...DEFAULT_PROJECT_CONFIG, chat: { enabled: opts.chat ?? true } },
      warnings: [],
      source: null,
    },
  })
  return t
}

function fakeManager(over: Partial<GenerationManager> = {}) {
  return {
    start: vi.fn<GenerationManager['start']>(
      over.start ?? (async (key, opts) => ({ ...JOB, key, force: opts.force }))
    ),
    status: vi.fn<GenerationManager['status']>(over.status ?? (() => null)),
    cancel: vi.fn<GenerationManager['cancel']>(over.cancel ?? (async () => false)),
  }
}

/** The routes over a fake manager, with the envelope the app answers errors with. */
function appWith(manager: ReturnType<typeof fakeManager>): Hono {
  const app = new Hono()
  app.onError((err, c) => {
    const mapped = toAppError(err)
    return c.json(mapped.toEnvelope(), mapped.status)
  })
  app.route('/api', generateRoutes(t.ctx, manager))
  return app
}

describe('generate routes', () => {
  it('answers no job for a review the server never generated', async () => {
    await context()
    const res = await createApp(t.ctx).request('/api/prs/42/generate', { headers: LOCAL })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ job: null })
  })

  it('starts a job with the force the page asked for', async () => {
    await context()
    const manager = fakeManager()
    const app = appWith(manager)
    const res = await app.request('/api/prs/42/generate', {
      method: 'POST',
      headers: POST,
      body: JSON.stringify({ force: true }),
    })
    expect(res.status).toBe(202)
    expect(((await res.json()) as GenerationResponse).job).toMatchObject({ key: 42, force: true })
    expect(manager.start).toHaveBeenCalledWith(42, { force: true })

    // An empty body is a start without force; a local review is a target like any other.
    await app.request('/api/prs/branch/generate', { method: 'POST', headers: POST })
    expect(manager.start).toHaveBeenLastCalledWith('branch', { force: false })
  })

  it('refuses a body that is not the one it reads', async () => {
    await context()
    const app = appWith(fakeManager())
    for (const body of [
      'not json',
      JSON.stringify({ force: 'yes' }),
      JSON.stringify({ force: true, x: 1 }),
    ]) {
      const res = await app.request('/api/prs/42/generate', { method: 'POST', headers: POST, body })
      expect(res.status).toBe(400)
      expect(((await res.json()) as ErrorEnvelope).error.code).toBe('BAD_REQUEST')
    }
  })

  it('refuses a second job while one runs', async () => {
    await context()
    const app = appWith(
      fakeManager({
        start: async () => {
          throw new GenerationBusyError()
        },
      })
    )
    const res = await app.request('/api/prs/42/generate', { method: 'POST', headers: POST, body: '{}' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe('GENERATION_BUSY')
  })

  it('refuses to start without acpx', async () => {
    await context({ acpx: null })
    const manager = fakeManager()
    const res = await appWith(manager).request('/api/prs/42/generate', {
      method: 'POST',
      headers: POST,
      body: '{}',
    })
    expect(res.status).toBe(503)
    expect(((await res.json()) as ErrorEnvelope).error).toMatchObject({
      code: 'GENERATION_FAILED',
      message: 'acpx is not installed',
    })
    expect(manager.start).not.toHaveBeenCalled()
  })

  describe('the host login a shared canvas needs', () => {
    const start = (app: Hono, key: string | number = 42) =>
      app.request(`/api/prs/${key}/generate`, { method: 'POST', headers: POST, body: '{}' })

    /** The capability probe, answering what the test says; `refreshes` counts the fresh reads. */
    function probe(caps: Capabilities): { refreshes: number } {
      const seen = { refreshes: 0 }
      t.ctx.capabilities = {
        get: async opts => {
          seen.refreshes += opts?.refresh === true ? 1 : 0
          return caps
        },
      }
      return seen
    }

    it('refuses before any agent time when the host CLI is not logged in', async () => {
      await context()
      const seen = probe({ canComment: false, tokenKind: 'unknown', login: null })
      const manager = fakeManager()
      const res = await start(appWith(manager))
      expect(res.status).toBe(401)
      expect(((await res.json()) as ErrorEnvelope).error).toEqual({
        code: 'GH_UNAUTHENTICATED',
        message: 'gh is not logged in, so the canvas could not be shared on the PR',
        hint: 'run `gh auth login` in a terminal, or turn sharing off with `canvasComment: false` in .pr-review/settings.yml',
      })
      expect(manager.start).not.toHaveBeenCalled()
      // The probe is read fresh, so a login made since the page loaded counts.
      expect(seen.refreshes).toBe(1)
    })

    it('names the GitLab login on a GitLab project', async () => {
      t = await makeTestContext({ host: gitlabHost('gitlab.com'), runner: createFakeRunner() })
      probe({ canComment: false, tokenKind: 'unknown', login: null })
      const res = await start(appWith(fakeManager()))
      expect(((await res.json()) as ErrorEnvelope).error).toMatchObject({
        code: 'GLAB_UNAUTHENTICATED',
        message: 'glab is not logged in, so the canvas could not be shared on the MR',
      })
    })

    it('refuses a login that cannot comment, with why and what to do', async () => {
      await context()
      probe({
        canComment: false,
        tokenKind: 'classic',
        login: 'octocat',
        reason: 'this token has no repo scope',
        hint: 'gh auth refresh -h github.com -s repo',
      })
      const res = await start(appWith(fakeManager()))
      expect(res.status).toBe(403)
      expect(((await res.json()) as ErrorEnvelope).error).toEqual({
        code: 'COMMENT_FORBIDDEN',
        message: 'octocat cannot comment on acme/widgets: this token has no repo scope',
        hint: 'gh auth refresh -h github.com -s repo, or turn sharing off with `canvasComment: false` in .pr-review/settings.yml',
      })
      probe({ canComment: false, tokenKind: 'classic', login: 'octocat' })
      expect(((await (await start(appWith(fakeManager()))).json()) as ErrorEnvelope).error).toMatchObject({
        message: 'octocat cannot comment on acme/widgets',
        hint: 'log in with an account that can comment, or turn sharing off with `canvasComment: false` in .pr-review/settings.yml',
      })
    })

    it('lets through a login whose rights the probe cannot read', async () => {
      await context()
      probe({ canComment: 'unknown', tokenKind: 'fine-grained', login: 'octocat' })
      expect((await start(appWith(fakeManager()))).status).toBe(202)
    })

    it('needs no login for a local review, or with sharing off', async () => {
      await context()
      const seen = probe({ canComment: false, tokenKind: 'unknown', login: null })
      expect((await start(appWith(fakeManager()), 'uncommitted')).status).toBe(202)
      await writeFile(t.ctx.settings.file, 'canvasComment: false\n')
      expect((await start(appWith(fakeManager()), 42)).status).toBe(202)
      expect(seen.refreshes).toBe(0)
    })
  })

  it('stops a job and answers where it is', async () => {
    await context()
    const manager = fakeManager({ cancel: async () => true, status: () => ({ ...JOB, stopping: true }) })
    const res = await appWith(manager).request('/api/prs/42/generate', { method: 'DELETE', headers: POST })
    expect(await res.json()).toEqual({ cancelled: true, job: { ...JOB, stopping: true } })
    expect(manager.cancel).toHaveBeenCalledWith(42)
  })

  it('does not exist when the project turns agents off', async () => {
    await context({ chat: false })
    const app = createApp(t.ctx)
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await app.request('/api/prs/42/generate', { method, headers: POST })
      expect(res.status).toBe(404)
    }
  })

  it('refuses a target that is not a review', async () => {
    await context()
    const res = await createApp(t.ctx).request('/api/prs/nope/generate', { headers: LOCAL })
    expect(res.status).toBe(400)
  })

  it('generates a canvas end to end: a rejected first answer, the fixes, and a published second', async () => {
    const model = artifactToModelOutput(syntheticArtifact())
    // Over its cap, so the fix step shortens it and the repair prompt names the fix.
    const firstTitle = `${model.layers[0]?.title ?? 'x'}: ${'and more '.repeat(20)}`
    const answers = [
      JSON.stringify({
        ...model,
        layers: model.layers.map((l, i) => (i === 0 ? { ...l, title: firstTitle } : l)).slice(0, 1),
      }),
      JSON.stringify(model),
    ]
    const runner = createFakeRunner({
      script: options => [
        { type: 'chunk', text: answers[runner.runs.indexOf(options)] ?? '' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    })
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42(), runner })
    const app = createApp(t.ctx)
    const started = await app.request('/api/prs/42/generate', { method: 'POST', headers: POST, body: '{}' })
    expect(started.status).toBe(202)

    let job: GenerationJob | null = null
    for (let i = 0; i < 200; i++) {
      job = (
        (await (await app.request('/api/prs/42/generate', { headers: LOCAL })).json()) as GenerationResponse
      ).job
      if (
        job !== null &&
        !['preparing', 'checkout', 'generating', 'publishing', 'repairing'].includes(job.phase)
      ) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(job).toMatchObject({ phase: 'done', outcome: 'published', round: 2, headSha: HEAD_SHA })
    expect(runner.runs[0]?.prompt).toContain('The pr-review server runs this generation')
    expect(runner.runs[1]?.prompt).toMatch(/HUNK_UNASSIGNED/)
    expect(runner.runs[1]?.prompt).toContain('keep them')
    expect(await t.ctx.canvases.findForPr(42, HEAD_SHA)).toEqual({ status: 'ready', headSha: HEAD_SHA })
  })

  it('rejects a cross-site start', async () => {
    await context()
    const res = await createApp(t.ctx).request('/api/prs/42/generate', {
      method: 'POST',
      headers: { ...POST, origin: 'https://evil.example' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })
})
