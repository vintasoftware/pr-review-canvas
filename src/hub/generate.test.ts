// @vitest-environment node
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { CliIo } from '../commands.js'
import { reportFailure, UsageError } from '../commands.js'
import type { GenerationJob } from '../contract/generation.js'
import { AppError } from '../server/errors.js'
import { makeTempDir } from '../testing/fakes.js'
import type { RunningServer } from './client.js'
import { GENERATE_POLL_MS, type GenerateDeps, runGenerate } from './generate.js'
import type { RegisterInput } from './hub-app.js'

interface FakeIo extends CliIo {
  out: string[]
  err: string[]
}

function fakeIo(json = false): FakeIo {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: l => out.push(l), stderr: l => err.push(l), json }
}

const SERVER: RunningServer = {
  pid: 999,
  port: 3010,
  version: '1.0.0',
  token: 'tok',
  origin: 'http://localhost:3010',
}
const HEAD = 'c'.repeat(40)
const BASE_PATH = '/r/acme/widgets/'

function job(over: Partial<GenerationJob> = {}): GenerationJob {
  return {
    key: 42,
    force: false,
    agent: 'claude',
    model: 'opus',
    skill: { source: 'default', version: '1.0.0' },
    phase: 'preparing',
    round: 1,
    maxRounds: 4,
    startedAt: '2026-10-07T12:00:00.000Z',
    activity: [],
    ...over,
  }
}

const DONE = job({
  phase: 'done',
  headSha: HEAD,
  sharing: { status: 'shared', url: 'https://github.com/acme/widgets/pull/42#c1' },
})

interface Call {
  path: string
  method: string
  body: unknown
}

interface Fake extends GenerateDeps {
  calls: Call[]
  registered: RegisterInput[]
  opened: string[]
  sleeps: number[]
}

/**
 * The deps over a server whose start answers `started` and whose status answers `polls` in turn,
 * the last one again once they run out.
 */
function fakeDeps(
  opts: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    started?: GenerationJob | null
    polls?: (GenerationJob | null | Error)[]
    branchPr?: number | null
  } = {}
): Fake {
  const calls: Call[] = []
  const registered: RegisterInput[] = []
  const opened: string[] = []
  const sleeps: number[] = []
  const polls = [...(opts.polls ?? [DONE])]
  return {
    calls,
    registered,
    opened,
    sleeps,
    cwd: opts.cwd ?? '/home/me/widgets',
    env: opts.env ?? {},
    version: '1.0.0',
    repoRoot: () => Promise.resolve('/home/me/widgets'),
    findServer: () => Promise.resolve(SERVER),
    register: (_server, input) => {
      registered.push(input)
      return Promise.resolve({
        slug: 'acme/widgets',
        basePath: BASE_PATH,
        dataDir: '/home/me/widgets/.pr-review',
      })
    },
    openBrowser: url => opened.push(url),
    callProject: <T>(_server: RunningServer, basePath: string, route: string, init: RequestInit = {}) => {
      expect(basePath).toBe(BASE_PATH)
      calls.push({
        path: route,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      if (route === 'generate/target') {
        return Promise.resolve({ prNumber: opts.branchPr === undefined ? 42 : opts.branchPr } as T)
      }
      if (init.method === 'POST') {
        const input = JSON.parse(String(init.body)) as { force: boolean }
        const key = route.split('/')[1] ?? ''
        const started =
          opts.started === undefined
            ? job({ key: /^\d+$/.test(key) ? Number(key) : (key as 'branch'), force: input.force })
            : opts.started
        return Promise.resolve({ job: started } as T)
      }
      const next = polls.length > 1 ? polls.shift() : polls[0]
      return next instanceof Error ? Promise.reject(next) : Promise.resolve({ job: next ?? null } as T)
    },
    download: (_server, basePath, route) => {
      calls.push({ path: route, method: 'GET', body: undefined })
      expect(basePath).toBe(BASE_PATH)
      return Promise.resolve({ name: 'acme-widgets-pr42-ccccccc.zip', bytes: new Uint8Array([80, 75]) })
    },
    sleep: ms => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  }
}

let tmp: string | null = null
afterEach(async () => {
  if (tmp !== null) await rm(tmp, { recursive: true, force: true })
  tmp = null
})

describe('runGenerate', () => {
  it('starts the job in the server, reports each phase, and prints where the canvas is', async () => {
    const deps = fakeDeps({
      polls: [
        job({ phase: 'checkout' }),
        job({ phase: 'generating' }),
        job({ phase: 'generating' }),
        job({ phase: 'publishing' }),
        job({ phase: 'repairing', round: 2, problems: ['HUNK_UNASSIGNED a'] }),
        job({ phase: 'publishing', round: 2 }),
        { ...DONE, round: 2 },
      ],
    })
    const io = fakeIo()
    expect(await runGenerate(deps, ['42'], io)).toBe(0)

    // The project keeps the flags `open` or `serve` saved with it.
    expect(deps.registered).toEqual([{ repoRoot: '/home/me/widgets', env: {} }])
    expect(deps.calls[0]).toEqual({ path: 'prs/42/generate', method: 'POST', body: { force: false } })
    expect(deps.calls.slice(1).every(c => c.path === 'prs/42/generate' && c.method === 'GET')).toBe(true)
    expect(deps.sleeps.every(ms => ms === GENERATE_POLL_MS)).toBe(true)
    expect(io.err).toEqual([
      'pr-review generate: generating #42 with claude (opus) in acme/widgets; follow it at http://localhost:3010/r/acme/widgets/review/42',
      'pr-review generate: Ctrl+C stops waiting; the generation goes on in the server',
      'pr-review generate: Preparing the diff',
      'pr-review generate: Checking out the head',
      'pr-review generate: The agent is writing the canvas',
      'pr-review generate: Validating and publishing',
      'pr-review generate: The agent is fixing what publish rejected (1 problem, attempt 2 of 4)',
      'pr-review generate: Validating and publishing',
    ])
    expect(io.out).toEqual([
      'published the canvas of #42 at ccccccc: http://localhost:3010/r/acme/widgets/review/42',
      'shared on the pull request: https://github.com/acme/widgets/pull/42#c1',
    ])
    expect(deps.opened).toEqual([])
  })

  it('prints one JSON line with --json', async () => {
    const io = fakeIo(true)
    expect(await runGenerate(fakeDeps(), ['42'], io)).toBe(0)
    expect(io.out.map(l => JSON.parse(l) as unknown)).toEqual([
      {
        status: 'published',
        review: 42,
        headSha: HEAD,
        url: 'http://localhost:3010/r/acme/widgets/review/42',
        agent: 'claude',
        model: 'opus',
        attempts: 1,
        sharing: DONE.sharing,
      },
    ])
  })

  it('generates for the open pull request of the branch when no review is named', async () => {
    const deps = fakeDeps({ branchPr: 7, polls: [{ ...DONE, key: 7 }] })
    expect(await runGenerate(deps, [], fakeIo())).toBe(0)
    expect(deps.calls.slice(0, 2).map(c => c.path)).toEqual(['generate/target', 'prs/7/generate'])
  })

  it('asks for a review when the branch has no open pull request', async () => {
    const deps = fakeDeps({ branchPr: null })
    await expect(runGenerate(deps, [], fakeIo())).rejects.toThrow(/no open pull request/)
    expect(deps.calls.map(c => c.path)).toEqual(['generate/target'])
  })

  it('sends the force, base, agent, and model it is given', async () => {
    const deps = fakeDeps({ polls: [{ ...DONE, key: 'branch', sharing: { status: 'local' } }] })
    const io = fakeIo()
    const argv = ['branch', '--force', '--base', 'release', '--agent', 'codex', '--model', 'gpt-x']
    expect(await runGenerate(deps, argv, io)).toBe(0)
    expect(deps.calls[0]).toEqual({
      path: 'prs/branch/generate',
      method: 'POST',
      body: { force: true, base: 'release', agent: 'codex', model: 'gpt-x' },
    })
    expect(io.out).toEqual([
      'published the canvas of the branch review at ccccccc: http://localhost:3010/r/acme/widgets/review/branch',
    ])
  })

  it.each([
    [['42', '--base', 'main'], /--base is for/],
    [['--base', 'main'], /--base is for/],
    [['42', '--agent', 'gemini'], /claude or codex/],
    [['nope'], /not a review/],
    [['42', 'branch'], /one review at most/],
  ])('refuses %j before it reaches the server', async (argv, message) => {
    const deps = fakeDeps()
    const err = await runGenerate(deps, argv, fakeIo()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UsageError)
    expect((err as Error).message).toMatch(message)
    expect(deps.registered).toEqual([])
  })

  it('sends a data dir it is given in place of the saved flags, as open does', async () => {
    const deps = fakeDeps()
    await runGenerate(deps, ['42', '--data-dir', 'scratch'], fakeIo())
    expect(deps.registered).toEqual([
      { repoRoot: '/home/me/widgets', env: {}, flags: { dataDir: '/home/me/widgets/scratch' } },
    ])
  })

  it('rejects an unknown flag', async () => {
    await expect(runGenerate(fakeDeps(), ['42', '--share'], fakeIo())).rejects.toThrow()
  })

  it('with --out, posts nothing and writes the zip of the published head', async () => {
    tmp = await makeTempDir()
    const deps = fakeDeps({ cwd: tmp, polls: [{ ...DONE, sharing: { status: 'off' } }] })
    const io = fakeIo()
    expect(await runGenerate(deps, ['42', '--out', 'canvas.zip'], io)).toBe(0)

    expect(deps.calls[0]?.body).toEqual({ force: false, share: false })
    expect(deps.calls.at(-1)?.path).toBe(`prs/42/export?headSha=${HEAD}`)
    const file = path.join(tmp, 'canvas.zip')
    expect([...(await readFile(file))]).toEqual([80, 75])
    expect(io.out).toEqual([
      'published the canvas of #42 at ccccccc: http://localhost:3010/r/acme/widgets/review/42',
      `wrote ${file}; open it with \`pr-review import <zip>\``,
    ])
  })

  it('with --out naming a folder, writes the zip there under its own name', async () => {
    tmp = await makeTempDir()
    const deps = fakeDeps({ cwd: '/elsewhere', polls: [{ ...DONE, sharing: { status: 'off' } }] })
    const io = fakeIo(true)
    expect(await runGenerate(deps, ['42', '--out', tmp], io)).toBe(0)
    const file = path.join(tmp, 'acme-widgets-pr42-ccccccc.zip')
    expect(await readFile(file)).toHaveLength(2)
    expect(JSON.parse(io.out[0] ?? '')).toMatchObject({ sharing: { status: 'off' }, zipPath: file })
  })

  it('says when sharing is off, and passes on a failed share with its zip', async () => {
    const off = fakeIo()
    await runGenerate(fakeDeps({ polls: [{ ...DONE, sharing: { status: 'off' } }] }), ['42'], off)
    expect(off.out.at(-1)).toBe('kept local: sharing is off')

    const failed = fakeIo()
    const sharing = {
      status: 'failed',
      warning: 'Automatic canvas sharing failed: offline.',
      zipPath: '/z.zip',
    } as const
    expect(await runGenerate(fakeDeps({ polls: [{ ...DONE, sharing }] }), ['42'], failed)).toBe(0)
    expect(failed.err.at(-1)).toBe('warning: Automatic canvas sharing failed: offline.')
    expect(failed.out.at(-1)).toBe('zip to upload: /z.zip')
  })

  it('opens the review with --open, except under CI', async () => {
    const deps = fakeDeps()
    await runGenerate(deps, ['42', '--open'], fakeIo())
    expect(deps.opened).toEqual(['http://localhost:3010/r/acme/widgets/review/42'])

    const ci = fakeDeps({ env: { CI: '1' } })
    await runGenerate(ci, ['42', '--open'], fakeIo())
    expect(ci.opened).toEqual([])
  })

  /** The exit code and output of a run, with a failure reported as `main` reports it. */
  const exitOf = (deps: Fake, argv: string[], io: FakeIo) =>
    runGenerate(deps, argv, io).catch((err: unknown) => reportFailure(io, err))

  it('exits 5 with the problems when publish rejected the model every time', async () => {
    const failed = job({
      phase: 'failed',
      round: 4,
      problems: ['HUNK_UNASSIGNED a', 'TITLE_TOO_LONG b'],
      error: { code: 'MODEL_INVALID', message: 'publish rejected the model 4 times', hint: 'run the skill' },
    })
    const io = fakeIo()
    expect(await exitOf(fakeDeps({ polls: [failed] }), ['42'], io)).toBe(5)
    expect(io.err.slice(-4)).toEqual([
      'HUNK_UNASSIGNED a',
      'TITLE_TOO_LONG b',
      'error: publish rejected the model 4 times (MODEL_INVALID)',
      'hint: run the skill',
    ])
    expect(io.out).toEqual([])
  })

  it('exits with the code of the error a failed job carries, as any command does', async () => {
    const failed = job({
      phase: 'failed',
      problems: ['HUNK_UNASSIGNED a'],
      error: { code: 'GENERATION_FAILED', message: 'the agent needs a login', hint: 'log in' },
    })
    const io = fakeIo(true)
    expect(await exitOf(fakeDeps({ polls: [failed] }), ['42'], io)).toBe(1)
    expect(io.out.map(line => JSON.parse(line) as unknown)).toEqual([
      { error: { code: 'GENERATION_FAILED', message: 'the agent needs a login', hint: 'log in' } },
    ])
    // Only a rejected model's problems are its own to print.
    expect(io.err.some(line => line.includes('HUNK_UNASSIGNED'))).toBe(false)

    // A logged-out host CLI exits 4, as prepare does when it finds the same.
    const loggedOut = job({
      phase: 'failed',
      error: { code: 'GH_UNAUTHENTICATED', message: 'gh is not logged in', hint: 'run gh auth login' },
    })
    expect(await exitOf(fakeDeps({ polls: [loggedOut] }), ['42', '--out', '/tmp/x.zip'], fakeIo())).toBe(4)
  })

  it('exits 1 when the job was stopped', async () => {
    const io = fakeIo()
    expect(await exitOf(fakeDeps({ polls: [job({ phase: 'cancelled' })] }), ['42'], io)).toBe(1)
    expect(io.err.slice(-2)).toEqual([
      'error: the generation of #42 was stopped (GENERATION_FAILED)',
      'hint: start it again with `pr-review generate`',
    ])
  })

  it('fails when another job of the review took its place, or the server lost it', async () => {
    const other = job({ phase: 'generating', startedAt: '2026-10-07T12:05:00.000Z' })
    const replaced = await runGenerate(fakeDeps({ polls: [other] }), ['42'], fakeIo()).catch(
      (e: unknown) => e
    )
    expect(replaced).toBeInstanceOf(AppError)
    expect(replaced).toMatchObject({ code: 'GENERATION_FAILED', message: expect.stringMatching(/replaced/) })

    const lost = await runGenerate(fakeDeps({ polls: [null] }), ['42'], fakeIo()).catch((e: unknown) => e)
    expect(lost).toMatchObject({
      code: 'GENERATION_FAILED',
      message: expect.stringMatching(/no longer knows .* may have restarted/),
    })
  })

  it('refuses an ended job that lacks what the server always sends with it', async () => {
    const { headSha: _, ...headless } = DONE
    for (const polls of [[headless], [job({ phase: 'failed' })]]) {
      const err = await runGenerate(fakeDeps({ polls }), ['42'], fakeIo()).catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'INTERNAL', message: expect.stringMatching(/without its result/) })
    }
  })

  it('fails with what to do when the server stops answering', async () => {
    const lost = await runGenerate(
      fakeDeps({ polls: [new TypeError('fetch failed')] }),
      ['42'],
      fakeIo()
    ).catch((e: unknown) => e)
    expect(lost).toMatchObject({ code: 'SERVER_NOT_RUNNING', hint: expect.stringMatching(/pr-review serve/) })

    const refused = new AppError('NOT_FOUND', 'agents are turned off', 404)
    const err = await runGenerate(fakeDeps({ polls: [refused] }), ['42'], fakeIo()).catch((e: unknown) => e)
    expect(err).toBe(refused)
  })

  it('fails when the server answers a start with no job', async () => {
    const err = await runGenerate(fakeDeps({ started: null }), ['42'], fakeIo()).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'INTERNAL' })
  })
})
