// `pr-review serve` and `pr-review open`. One server serves every checkout: `serve` starts it, from
// any folder, and `open` adds the checkout it runs in and opens its review in the browser. `serve`
// inside a repository does both, as it always has; when a server already runs, it adds the
// checkout to that one instead of starting a second.
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type CliIo, EXIT, printJson, splitCommonFlags, UsageError } from '../commands.js'
import { ConfigError, DEFAULT_PORT, parsePort, readEnv } from '../config.js'
import { parseReviewKey } from '../contract/review-key.js'
import { AppError } from '../server/errors.js'
import type { RunningServer } from './client.js'
import type { ServerInfo } from './home.js'
import type { RegisterInput, RegisterResponse } from './hub-app.js'
import type { ProjectFlags } from '../load-context.js'
import type { ProjectRegistration } from './hub.js'

export interface HubCommandDeps {
  cwd: string
  env: NodeJS.ProcessEnv
  version: string
  /** The top-level folder of the checkout `dir` is in, or null when it is in none. */
  repoRoot: (dir: string) => Promise<string | null>
  findServer: () => Promise<RunningServer | null>
  register: (server: ServerInfo, input: RegisterInput) => Promise<RegisterResponse>
  openBrowser: (url: string) => void
}

export interface StartedServer {
  origin: string
  /** The base path of the project `serve` was started in, if it was started in one. */
  basePath: string | null
}

export interface ServeDeps extends HubCommandDeps {
  /**
   * Starts the server in this process and registers the checkout, if any. `advertise` is false
   * when another server owns `server.json`, so commands keep finding that one.
   */
  startServer: (opts: {
    port: number
    registration: ProjectRegistration | null
    advertise: boolean
  }) => Promise<StartedServer>
  checkSkill: (repoRoot: string) => Promise<{ ok: boolean; detail: string; hint?: string | undefined }>
}

/** The set variables of the shell, which the server runs this project's host CLI and agent under. */
function shellEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

/** The folders the flags name, made absolute here: the server does not run in this folder. */
function projectFlags(cwd: string, values: ProjectFlags): ProjectFlags {
  const flags: ProjectFlags = {}
  if (values.dataDir !== undefined) flags.dataDir = path.resolve(cwd, values.dataDir)
  if (values.fixtureCanvas !== undefined) flags.fixtureCanvas = path.resolve(cwd, values.fixtureCanvas)
  if (values.chatAgent !== undefined) flags.chatAgent = values.chatAgent
  if (values.chatModel !== undefined) flags.chatModel = values.chatModel
  return flags
}

function shouldOpen(env: NodeJS.ProcessEnv, noOpen: boolean | undefined): boolean {
  return noOpen !== true && readEnv(env, 'CI') === undefined
}

function warnVersion(io: CliIo, server: RunningServer, version: string): void {
  if (server.version !== version) {
    io.stderr(
      `pr-review: the running server is ${server.version} and this command is ${version}; restart the server to run ${version}`
    )
  }
}

/**
 * Registers the checkout. When its flags moved the project to another data dir, says so: the
 * canvases and review state until now stay where they were, and look gone otherwise.
 */
async function addTo(
  deps: HubCommandDeps,
  io: CliIo,
  server: RunningServer,
  repoRoot: string,
  flags: ProjectFlags
): Promise<RegisterResponse> {
  const added = await deps.register(server, { repoRoot, env: shellEnv(deps.env), flags })
  if (added.dataDirBefore !== undefined) {
    io.stderr(
      `pr-review: ${added.slug} now reads ${added.dataDir}; its canvases and review state until now are in ${added.dataDirBefore}`
    )
  }
  return added
}

export async function runOpen(deps: HubCommandDeps, argv: string[], io: CliIo): Promise<number> {
  const { repo, dataDir, rest } = splitCommonFlags(argv)
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      'chat-agent': { type: 'string' },
      'chat-model': { type: 'string' },
      'no-open': { type: 'boolean' },
    },
    allowPositionals: true,
    strict: true,
  })
  if (positionals.length > 1) {
    throw new UsageError('open takes one review at most: a number, branch, or uncommitted')
  }
  const target = positionals[0]
  if (target !== undefined && parseReviewKey(target) === null) {
    throw new UsageError(`"${target}" is not a review: use a number, branch, or uncommitted`)
  }
  const repoRoot = await deps.repoRoot(repo === undefined ? deps.cwd : path.resolve(deps.cwd, repo))
  if (repoRoot === null) {
    throw new ConfigError(
      'NOT_A_REPO',
      'not inside a git repository',
      'run from a clone or pass --repo <dir>'
    )
  }
  const server = await deps.findServer()
  if (server === null) {
    throw new AppError(
      'SERVER_NOT_RUNNING',
      'no pr-review server is running',
      503,
      'start one with `pr-review serve` in any terminal'
    )
  }
  warnVersion(io, server, deps.version)
  const added = await addTo(
    deps,
    io,
    server,
    repoRoot,
    projectFlags(deps.cwd, { dataDir, chatAgent: values['chat-agent'], chatModel: values['chat-model'] })
  )
  const url = `${server.origin}${added.basePath}${target === undefined ? 'start' : `review/${target}`}`
  if (shouldOpen(deps.env, values['no-open'])) {
    deps.openBrowser(url)
  }
  if (io.json) {
    printJson(io, {
      url,
      project: added.slug,
      dataDir: added.dataDir,
      server: { port: server.port, version: server.version },
    })
  } else {
    io.stdout(url)
  }
  return EXIT.ok
}

export async function runServe(deps: ServeDeps, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      repo: { type: 'string' },
      'data-dir': { type: 'string' },
      'fixture-canvas': { type: 'string' },
      'chat-agent': { type: 'string' },
      'chat-model': { type: 'string' },
      // Deprecated spellings of --chat-agent and --chat-model.
      agent: { type: 'string' },
      model: { type: 'string' },
      'no-open': { type: 'boolean' },
    },
    strict: true,
  })
  if (values.agent !== undefined || values.model !== undefined) {
    io.stderr('pr-review serve: --agent and --model are deprecated; use --chat-agent and --chat-model')
  }
  const explicitPort = values.port ?? readEnv(deps.env, 'PR_REVIEW_PORT')
  const port = explicitPort === undefined ? DEFAULT_PORT : parsePort(explicitPort, DEFAULT_PORT)
  // Outside a repository, serve starts the server alone; `--repo` must name one.
  const repoRoot = await deps.repoRoot(
    values.repo === undefined ? deps.cwd : path.resolve(deps.cwd, values.repo)
  )
  if (repoRoot === null && values.repo !== undefined) {
    throw new ConfigError(
      'NOT_A_REPO',
      `not a git repository: ${values.repo}`,
      'pass --repo <dir> of a clone'
    )
  }
  const flags = projectFlags(deps.cwd, {
    dataDir: values['data-dir'],
    fixtureCanvas: values['fixture-canvas'],
    chatAgent: values['chat-agent'] ?? values.agent,
    chatModel: values['chat-model'] ?? values.model,
  })
  if (repoRoot !== null) {
    const skill = await deps.checkSkill(repoRoot)
    if (!skill.ok) io.stderr(`pr-review doctor: ${skill.detail}. ${skill.hint ?? ''}`)
  }
  const open = shouldOpen(deps.env, values['no-open'])

  const running = await deps.findServer()
  // A port the user named that differs from the running server's starts a server of its own.
  if (running !== null && (explicitPort === undefined || port === running.port)) {
    warnVersion(io, running, deps.version)
    const added = repoRoot === null ? null : await addTo(deps, io, running, repoRoot, flags)
    io.stderr(
      `pr-review serve: a server already runs at ${running.origin}/ (pid ${running.pid})${added === null ? '' : `; added ${added.slug}`}`
    )
    if (open) {
      deps.openBrowser(`${running.origin}${added === null ? '/' : `${added.basePath}start`}`)
    }
    return EXIT.ok
  }
  const started = await deps.startServer({
    port,
    registration: repoRoot === null ? null : { repoRoot, env: shellEnv(deps.env), flags },
    advertise: running === null,
  })
  if (open) {
    deps.openBrowser(`${started.origin}${started.basePath === null ? '/' : `${started.basePath}start`}`)
  }
  return EXIT.ok
}
