import type { CliIo } from '../commands.js'
import { UsageError } from '../commands.js'
import { ConfigError } from '../config.js'
import { AppError } from '../server/errors.js'
import type { RunningServer } from './client.js'
import { runOpen, runServe, type ServeDeps } from './commands.js'
import type { RegisterInput, RegisterResponse } from './hub-app.js'

interface FakeIo extends CliIo {
  out: string[]
  err: string[]
}

function fakeIo(json = false): FakeIo {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: l => out.push(l), stderr: l => err.push(l), json }
}

const running: RunningServer = {
  pid: 999,
  port: 3010,
  version: '1.0.0',
  token: 'tok',
  origin: 'http://localhost:3010',
}

interface Fake extends ServeDeps {
  registered: RegisterInput[]
  opened: string[]
  started: Parameters<ServeDeps['startServer']>[0][]
  repoRootCalls: string[]
}

function fakeDeps(
  opts: {
    repoRoot?: string | null
    server?: RunningServer | null
    env?: NodeJS.ProcessEnv
    answer?: Partial<RegisterResponse>
    skill?: { ok: boolean; detail: string; hint?: string }
  } = {}
): Fake {
  const registered: RegisterInput[] = []
  const opened: string[] = []
  const started: Parameters<ServeDeps['startServer']>[0][] = []
  const repoRootCalls: string[] = []
  return {
    registered,
    opened,
    started,
    repoRootCalls,
    cwd: '/home/me/widgets',
    env: opts.env ?? {},
    version: '1.0.0',
    repoRoot: dir => {
      repoRootCalls.push(dir)
      return Promise.resolve(opts.repoRoot === undefined ? '/home/me/widgets' : opts.repoRoot)
    },
    findServer: () => Promise.resolve(opts.server === undefined ? running : opts.server),
    register: (_server, input) => {
      registered.push(input)
      return Promise.resolve({
        slug: 'acme/widgets',
        basePath: '/r/acme/widgets/',
        kept: false,
        ...opts.answer,
      })
    },
    openBrowser: url => opened.push(url),
    startServer: o => {
      started.push(o)
      return Promise.resolve({
        origin: `http://localhost:${o.port}`,
        basePath: o.registration === null ? null : '/r/acme/widgets/',
      })
    },
    checkSkill: () => Promise.resolve(opts.skill ?? { ok: true, detail: 'installed' }),
  }
}

describe('runOpen', () => {
  it('registers the checkout, opens its start page and prints the url', async () => {
    const deps = fakeDeps()
    const io = fakeIo()
    expect(await runOpen(deps, [], io)).toBe(0)
    expect(deps.opened).toEqual(['http://localhost:3010/r/acme/widgets/start'])
    expect(io.out).toEqual(['http://localhost:3010/r/acme/widgets/start'])
    expect(io.err).toEqual([])
  })

  it.each(['42', 'branch', 'uncommitted'])('opens review/%s', async target => {
    const deps = fakeDeps()
    const io = fakeIo()
    await runOpen(deps, [target], io)
    expect(io.out).toEqual([`http://localhost:3010/r/acme/widgets/review/${target}`])
  })

  it('rejects a target that is not a review', async () => {
    await expect(runOpen(fakeDeps(), ['nope'], fakeIo())).rejects.toThrow(UsageError)
    await expect(runOpen(fakeDeps(), ['0'], fakeIo())).rejects.toThrow(UsageError)
  })

  it('rejects two targets', async () => {
    await expect(runOpen(fakeDeps(), ['42', 'branch'], fakeIo())).rejects.toThrow(/one review at most/)
  })

  it('rejects an unknown flag', async () => {
    await expect(runOpen(fakeDeps(), ['--port', '1'], fakeIo())).rejects.toThrow()
  })

  it('fails outside a repository', async () => {
    const err = await runOpen(fakeDeps({ repoRoot: null }), [], fakeIo()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err).toMatchObject({ code: 'NOT_A_REPO' })
  })

  it('fails when no server runs', async () => {
    const deps = fakeDeps({ server: null })
    const err = await runOpen(deps, [], fakeIo()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'SERVER_NOT_RUNNING', status: 503 })
    expect(deps.registered).toEqual([])
  })

  it('warns when the server runs another version', async () => {
    const io = fakeIo()
    await runOpen(fakeDeps({ server: { ...running, version: '0.9.0' } }), [], io)
    expect(io.err).toEqual([
      'pr-review: the running server is 0.9.0 and this command is 1.0.0; restart the server to run 1.0.0',
    ])
  })

  it('notes when the project kept its settings', async () => {
    const io = fakeIo()
    await runOpen(fakeDeps({ answer: { kept: true } }), [], io)
    expect(io.err).toEqual([
      'pr-review open: acme/widgets has a chat turn or a generation running, so it keeps its settings until that ends',
    ])
  })

  it('does not open the browser with --no-open or under CI', async () => {
    const noOpen = fakeDeps()
    await runOpen(noOpen, ['--no-open'], fakeIo())
    expect(noOpen.opened).toEqual([])
    const ci = fakeDeps({ env: { CI: 'true' } })
    await runOpen(ci, [], fakeIo())
    expect(ci.opened).toEqual([])
  })

  it('prints JSON when asked', async () => {
    const io = fakeIo(true)
    await runOpen(fakeDeps({ answer: { kept: true } }), ['42'], io)
    expect(io.out.map(l => JSON.parse(l) as unknown)).toEqual([
      {
        url: 'http://localhost:3010/r/acme/widgets/review/42',
        project: 'acme/widgets',
        kept: true,
        server: { port: 3010, version: '1.0.0' },
      },
    ])
  })

  it('sends the shell env and the flags, with folders made absolute', async () => {
    const deps = fakeDeps({ env: { HOME: '/home/me', UNSET: undefined } })
    await runOpen(
      deps,
      ['--data-dir', 'data', '--chat-agent', 'codex', '--chat-model', 'gpt', '--no-open'],
      fakeIo()
    )
    expect(deps.registered).toEqual([
      {
        repoRoot: '/home/me/widgets',
        env: { HOME: '/home/me' },
        flags: { dataDir: '/home/me/widgets/data', chatAgent: 'codex', chatModel: 'gpt' },
      },
    ])
  })

  it('sends no flags when none are given', async () => {
    const deps = fakeDeps()
    await runOpen(deps, [], fakeIo())
    expect(deps.registered[0]?.flags).toEqual({})
  })

  it('resolves --repo against the working folder', async () => {
    const deps = fakeDeps()
    await runOpen(deps, ['--repo', '../other'], fakeIo())
    expect(deps.repoRootCalls).toEqual(['/home/me/other'])
  })
})

describe('runServe', () => {
  it('adds the checkout to a running server and opens it', async () => {
    const deps = fakeDeps()
    const io = fakeIo()
    expect(await runServe(deps, [], io)).toBe(0)
    expect(deps.started).toEqual([])
    expect(deps.registered).toEqual([{ repoRoot: '/home/me/widgets', env: {}, flags: {} }])
    expect(deps.opened).toEqual(['http://localhost:3010/r/acme/widgets/start'])
    expect(io.err).toEqual([
      'pr-review serve: a server already runs at http://localhost:3010/ (pid 999); added acme/widgets',
    ])
  })

  it('delegates when the named port is the running one, warning about the version', async () => {
    const deps = fakeDeps({ server: { ...running, version: '0.9.0' } })
    const io = fakeIo()
    await runServe(deps, ['--port', '3010'], io)
    expect(deps.started).toEqual([])
    expect(deps.registered).toHaveLength(1)
    expect(io.err[0]).toMatch(/running server is 0\.9\.0/)
  })

  it('outside a repository, points at the running server without registering', async () => {
    const deps = fakeDeps({ repoRoot: null })
    const io = fakeIo()
    await runServe(deps, [], io)
    expect(deps.started).toEqual([])
    expect(deps.registered).toEqual([])
    expect(deps.opened).toEqual(['http://localhost:3010/'])
    expect(io.err).toEqual(['pr-review serve: a server already runs at http://localhost:3010/ (pid 999)'])
  })

  it('does not open the browser for a running server with --no-open', async () => {
    const deps = fakeDeps()
    await runServe(deps, ['--no-open'], fakeIo())
    expect(deps.opened).toEqual([])
  })

  it('starts and advertises a server when none runs', async () => {
    const deps = fakeDeps({ server: null })
    expect(await runServe(deps, [], fakeIo())).toBe(0)
    expect(deps.started).toEqual([
      {
        port: 3010,
        registration: { repoRoot: '/home/me/widgets', flags: {} },
        advertise: true,
      },
    ])
    expect(deps.registered).toEqual([])
    expect(deps.opened).toEqual(['http://localhost:3010/r/acme/widgets/start'])
  })

  it('starts a server of its own, not advertised, on a port other than the running one', async () => {
    const deps = fakeDeps()
    await runServe(deps, ['--port', '4000'], fakeIo())
    expect(deps.started).toEqual([expect.objectContaining({ port: 4000, advertise: false })])
    expect(deps.registered).toEqual([])
    expect(deps.opened).toEqual(['http://localhost:4000/r/acme/widgets/start'])
  })

  it('reads the port from PR_REVIEW_PORT', async () => {
    const deps = fakeDeps({ env: { PR_REVIEW_PORT: '4001' } })
    await runServe(deps, [], fakeIo())
    expect(deps.started).toEqual([expect.objectContaining({ port: 4001, advertise: false })])
  })

  it('rejects an invalid port', async () => {
    const err = await runServe(fakeDeps(), ['--port', 'abc'], fakeIo()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('outside a repository with no server, starts alone and opens the root', async () => {
    const deps = fakeDeps({ repoRoot: null, server: null })
    await runServe(deps, [], fakeIo())
    expect(deps.started).toEqual([{ port: 3010, registration: null, advertise: true }])
    expect(deps.opened).toEqual(['http://localhost:3010/'])
  })

  it('fails when --repo is not a repository', async () => {
    const deps = fakeDeps({ repoRoot: null, server: null })
    const err = await runServe(deps, ['--repo', 'nowhere'], fakeIo()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConfigError)
    expect(err).toMatchObject({ code: 'NOT_A_REPO', message: 'not a git repository: nowhere' })
    expect(deps.repoRootCalls).toEqual(['/home/me/widgets/nowhere'])
    expect(deps.started).toEqual([])
  })

  it('maps the deprecated --agent and --model, with a warning', async () => {
    const deps = fakeDeps({ server: null })
    const io = fakeIo()
    await runServe(deps, ['--agent', 'codex', '--model', 'gpt'], io)
    expect(io.err).toEqual([
      'pr-review serve: --agent and --model are deprecated; use --chat-agent and --chat-model',
    ])
    expect(deps.started[0]?.registration?.flags).toEqual({ chatAgent: 'codex', chatModel: 'gpt' })
  })

  it('prefers --chat-agent and --chat-model, and makes folders absolute', async () => {
    const deps = fakeDeps({ server: null })
    const io = fakeIo()
    await runServe(
      deps,
      [
        '--chat-agent',
        'claude',
        '--chat-model',
        'opus',
        '--data-dir',
        '/abs/data',
        '--fixture-canvas',
        'fixtures/canvas',
      ],
      io
    )
    expect(io.err).toEqual([])
    expect(deps.started[0]?.registration?.flags).toEqual({
      chatAgent: 'claude',
      chatModel: 'opus',
      dataDir: '/abs/data',
      fixtureCanvas: '/home/me/widgets/fixtures/canvas',
    })
  })

  it('warns when the skill check fails in a repository', async () => {
    const io = fakeIo()
    await runServe(
      fakeDeps({ server: null, skill: { ok: false, detail: 'skill missing', hint: 'run install-skill' } }),
      [],
      io
    )
    expect(io.err).toEqual(['pr-review doctor: skill missing. run install-skill'])
    const noHint = fakeIo()
    await runServe(fakeDeps({ server: null, skill: { ok: false, detail: 'skill missing' } }), [], noHint)
    expect(noHint.err).toEqual(['pr-review doctor: skill missing. '])
  })

  it('skips the skill check outside a repository', async () => {
    const io = fakeIo()
    await runServe(
      fakeDeps({ repoRoot: null, server: null, skill: { ok: false, detail: 'skill missing' } }),
      [],
      io
    )
    expect(io.err).toEqual([])
  })

  it('does not open the browser with --no-open or under CI', async () => {
    const noOpen = fakeDeps({ server: null })
    await runServe(noOpen, ['--no-open'], fakeIo())
    expect(noOpen.opened).toEqual([])
    const ci = fakeDeps({ server: null, env: { CI: '1' } })
    await runServe(ci, [], fakeIo())
    expect(ci.opened).toEqual([])
    expect(ci.started).toHaveLength(1)
  })

  it('rejects positionals and unknown flags', async () => {
    await expect(runServe(fakeDeps(), ['extra'], fakeIo())).rejects.toThrow()
    await expect(runServe(fakeDeps(), ['--json-nope'], fakeIo())).rejects.toThrow()
  })
})
