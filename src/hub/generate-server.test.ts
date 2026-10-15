// @vitest-environment node
// `pr-review generate` against a real server: the hub app on a port of its own, found through
// `server.json` and called over HTTP, as the command calls an installed one. Only the agent and the
// host CLI are fakes, so the job, publish, the export, and import all run as they do for a user.
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { importCanvas } from '../canvas/import.js'
import type { CliIo } from '../commands.js'
import { isChatAgent } from '../contract/settings.js'
import type { ProjectFlags } from '../load-context.js'
import { artifactToModelOutput } from '../review/normalize.js'
import { type HubServer, startHubServer } from '../server/node-server.js'
import { STATIC_DIR } from '../paths.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import { type FakeGh, makeTempDir, makeTestContext, type TestContext } from '../testing/fakes.js'
import { ghFor42, gitFor42, HEAD_SHA, syntheticArtifact } from '../testing/synthetic.js'
import { callProject, downloadFromProject, findServer, registerProject } from './client.js'
import { runGenerate } from './generate.js'
import { createHubApp } from './hub-app.js'
import { createHub } from './hub.js'

const MODEL = JSON.stringify(artifactToModelOutput(syntheticArtifact()))

let home: string
let dataDir: string
let out: string
let server: HubServer
let gh: FakeGh
let runner: ReturnType<typeof createFakeRunner>
/** Each context the hub built, one per registration; the first one's clone part is shared. */
let built: TestContext[]
const others: TestContext[] = []

beforeEach(async () => {
  home = await makeTempDir('pr-review-gen-home-')
  dataDir = await makeTempDir('pr-review-gen-data-')
  out = await makeTempDir('pr-review-gen-out-')
  built = []
  gh = ghFor42()
  runner = createFakeRunner({
    acpxVersion: '0.19.4',
    script: [
      { type: 'chunk', text: MODEL },
      { type: 'done', stopReason: 'end_turn' },
    ],
  })
  // A registration builds the project again; the data dir and the clone part (with its one
  // generation lane) stay, as the real server keeps them for a checkout.
  const hub = await createHub({
    registry: home,
    load: async registration => {
      const flags: ProjectFlags = registration.flags ?? {}
      const t = await makeTestContext({
        dataDir,
        git: gitFor42(),
        gh,
        runner,
        chatOverrides:
          flags.chatAgent !== undefined && isChatAgent(flags.chatAgent) ? { chatAgent: flags.chatAgent } : {},
        ...(built[0] === undefined ? {} : { clone: built[0].ctx.clone }),
      })
      built.push(t)
      return t.ctx
    },
    log: () => undefined,
  })
  let port = 0
  const app = createHubApp({
    hub,
    home,
    token: 'test-token',
    version: '0.0.0-test',
    port: () => port,
    staticDir: STATIC_DIR,
    vendorRoots: built[0]?.ctx.vendorRoots ?? {
      diff: '/nonexistent/diff',
      marked: '/nonexistent/marked.js',
      dompurify: '/nonexistent/purify.js',
      hljs: '/nonexistent/hljs.js',
      mermaid: '/nonexistent/mermaid',
    },
    log: () => undefined,
  })
  server = await startHubServer({
    fetch: app.fetch,
    port: 0,
    hub,
    home,
    advertise: true,
    info: { version: '0.0.0-test', token: 'test-token' },
    log: () => undefined,
  })
  port = server.port
})

afterEach(async () => {
  await server.close()
  for (const t of [...built, ...others.splice(0)]) await t.cleanup()
  for (const dir of [home, dataDir, out]) await rm(dir, { recursive: true, force: true })
})

interface Run {
  code: number
  out: string[]
  err: string[]
}

/** `pr-review generate <argv>` in the checkout, against the server `server.json` names. */
async function generate(argv: string[], json = false): Promise<Run> {
  const run: Run = { code: -1, out: [], err: [] }
  const io: CliIo = { stdout: l => run.out.push(l), stderr: l => run.err.push(l), json }
  run.code = await runGenerate(
    {
      cwd: out,
      env: {},
      version: '0.0.0-test',
      repoRoot: async () => '/repo',
      findServer: () => findServer(home),
      register: registerProject,
      openBrowser: () => undefined,
      callProject,
      download: downloadFromProject,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
    },
    argv,
    io
  )
  return run
}

const posts = () => gh.calls.filter(call => call.kind === 'post').length

describe('pr-review generate against a running server', () => {
  it('generates and publishes a PR canvas, reporting each phase and what sharing did', async () => {
    const run = await generate(['42'])

    expect(run.code).toBe(0)
    // The fake agent answers within one poll, so the job may skip the phases in between.
    expect(run.err).toContain('pr-review generate: Preparing the diff')
    expect(run.out[0]).toBe(
      `published the canvas of #42 at ${HEAD_SHA.slice(0, 7)}: http://localhost:${server.port}/r/acme/widgets/review/42`
    )
    // The fake forge refuses the comment, so publish keeps the zip to upload by hand.
    expect(posts()).toBeGreaterThan(0)
    expect(run.err.some(line => line.startsWith('warning: Automatic canvas sharing failed'))).toBe(true)
    expect(run.out.at(-1)).toMatch(/^zip to upload: .*\.zip$/)
    expect(runner.runs).toHaveLength(1)
    expect(await built.at(-1)?.ctx.canvases.findForPr(42, HEAD_SHA)).toEqual({
      status: 'ready',
      headSha: HEAD_SHA,
    })
  })

  it('with --out, posts nothing and writes a zip that import loads into another clone', async () => {
    const run = await generate(['42', '--out', 'canvas.zip'], true)

    expect(run.code).toBe(0)
    expect(posts()).toBe(0)
    const zipPath = path.join(out, 'canvas.zip')
    expect(JSON.parse(run.out[0] ?? '')).toMatchObject({
      status: 'published',
      review: 42,
      headSha: HEAD_SHA,
      sharing: { status: 'off' },
      zipPath,
    })

    const reviewer = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    others.push(reviewer)
    const imported = await importCanvas(reviewer.ctx, {
      bytes: await readFile(zipPath),
      prNumber: 42,
    })
    expect(imported).toMatchObject({ headSha: HEAD_SHA })
    expect(await reviewer.ctx.canvases.findForPr(42, HEAD_SHA)).toEqual({
      status: 'ready',
      headSha: HEAD_SHA,
    })
  })

  it('keeps the flags the project was opened with, and runs the job with that chat agent', async () => {
    // As `pr-review open --chat-agent codex` registers it.
    const server0 = await findServer(home)
    if (server0 === null) throw new Error('the server did not advertise itself')
    await registerProject(server0, { repoRoot: '/repo', env: {}, flags: { chatAgent: 'codex' } })

    const run = await generate(['42', '--out', out], true)

    expect(run.code).toBe(0)
    expect(JSON.parse(run.out[0] ?? '')).toMatchObject({ agent: 'codex' })
    expect(runner.runs[0]?.agent).toBe('codex')
  })

  it('runs the second generation of a head from a blank page, and the first stays the result of its own run', async () => {
    expect((await generate(['42', '--out', out])).code).toBe(0)
    const again = await generate(['42', '--out', out, '--force'], true)
    expect(again.code).toBe(0)
    expect(runner.runs).toHaveLength(2)
    expect(JSON.parse(again.out[0] ?? '')).toMatchObject({ status: 'published', headSha: HEAD_SHA })
  })
})
