import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { ACPX_BIN, createAgentRunner, findOnPath } from './acpx/acpx.js'
import {
  type CliIo,
  EXIT,
  namedCanvasDir,
  outputMode,
  printErrorEnvelope,
  reportFailure,
  runDoctor,
  runClean,
  runExport,
  runImport,
  runInstallSkill,
  runPrepare,
  runPublish,
  runValidate,
  splitCommonFlags,
} from './commands.js'
import { readEnv, resolveRepoRoot } from './config.js'
import { createGit, GitError } from './git/git.js'
import { printUsage } from './help.js'
import { createHostClient } from './host/client.js'
import { findServer, originOf, registerProject, runningPort } from './hub/client.js'
import { type HubCommandDeps, runOpen, runServe, type StartedServer } from './hub/commands.js'
import { hubHome } from './hub/home.js'
import { createHubApp } from './hub/hub-app.js'
import { createHub, type ProjectRegistration } from './hub/hub.js'
import { loadContext } from './load-context.js'
import { checkSkill } from './review/doctor.js'
import { type AppContext, readPackageVersion, resolveVendorRoots } from './server/context.js'
import { startHubServer } from './server/node-server.js'
import { openBrowser } from './server/open-browser.js'
import { PACKAGE_ROOT, STATIC_DIR } from './paths.js'
import { type CommandResult, runUpgrade } from './upgrade.js'

const SUBCOMMANDS = [
  'serve',
  'open',
  'prepare',
  'validate',
  'publish',
  'export',
  'import',
  'install-skill',
  'doctor',
  'upgrade',
  'clean',
] as const

/** Filled in by main once it knows the command line. */
const io: CliIo = {
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
  json: true,
}

/** The context of the checkout a one-shot command runs in. */
async function buildContext(
  repo: string | undefined,
  dataDir: string | undefined,
  extra: { canvasDir?: string | undefined; createDataDir?: boolean | undefined } = {}
): Promise<AppContext> {
  const cwd = process.cwd()
  const env = process.env
  return loadContext({
    repoDir: repo === undefined ? cwd : path.resolve(cwd, repo),
    cwd,
    env,
    flags: dataDir === undefined ? {} : { dataDir },
    canvasDir: extra.canvasDir,
    createDataDir: extra.createDataDir,
    // Without PR_REVIEW_PORT, the running server's port, so publish prints a URL it answers.
    port: readEnv(env, 'PR_REVIEW_PORT') === undefined ? await runningPort(hubHome(env)) : undefined,
  })
}

/** The top-level folder of the checkout `dir` is in; null outside one, as `serve` allows. */
async function repoRootOf(dir: string): Promise<string | null> {
  try {
    return await createGit(dir).topLevel()
  } catch (err) {
    if (err instanceof GitError) {
      return null
    }
    throw err
  }
}

function hubDeps(): HubCommandDeps {
  const home = hubHome(process.env)
  return {
    cwd: process.cwd(),
    env: process.env,
    version: readPackageVersion(),
    repoRoot: repoRootOf,
    findServer: () => findServer(home),
    register: registerProject,
    openBrowser: url => openBrowser(url, io.stderr),
  }
}

/** The shared server, in this process: every project registered with it answers under its path. */
async function startServer(opts: {
  port: number
  registration: ProjectRegistration | null
  advertise: boolean
}): Promise<StartedServer> {
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }
  const home = hubHome(process.env)
  const version = readPackageVersion()
  let port = opts.port
  const hub = await createHub({
    registry: opts.advertise ? home : null,
    load: (registration, hooks) =>
      loadContext({
        repoDir: registration.repoRoot,
        cwd: registration.repoRoot,
        env: registration.env,
        flags: registration.flags,
        port,
        log: hooks.log,
        cloneOf: hooks.cloneOf,
      }),
    log,
  })
  const token = randomBytes(32).toString('base64url')
  const app = createHubApp({
    hub,
    home,
    token,
    version,
    port: () => port,
    staticDir: STATIC_DIR,
    vendorRoots: resolveVendorRoots(),
    log,
  })
  const server = await startHubServer({
    fetch: app.fetch,
    port,
    hub,
    home,
    advertise: opts.advertise,
    info: { version, token },
    log,
  })
  port = server.port
  const origin = originOf(port)
  log(`pr-review ${version} · ${origin}/`)
  if (opts.registration === null) {
    return { origin, basePath: null }
  }
  try {
    const { project } = await hub.register(opts.registration)
    log(`serving ${project.ctx.config.slug} at ${origin}${project.ctx.config.basePath}`)
    return { origin, basePath: project.ctx.config.basePath }
  } catch (err) {
    // A checkout that cannot be served (no origin, a bad flag) stops the server it started.
    await server.close()
    throw err
  }
}

/** doctor builds no AppContext: it has to answer even when the repo or host CLI is the problem. */
async function doctorCommand(argv: string[]): Promise<number> {
  const { repo, dataDir, rest } = splitCommonFlags(argv)
  const cwd = process.cwd()
  return runDoctor(
    {
      git: createGit(repo === undefined ? cwd : path.resolve(cwd, repo)),
      env: process.env,
      client: host => createHostClient(host.cli),
      version: readPackageVersion(),
      acpxVersion: () => createAgentRunner().acpxVersion(),
      dataDirOverride: dataDir ?? readEnv(process.env, 'PR_REVIEW_DATA_DIR'),
    },
    rest,
    io,
    process.stdout
  )
}

async function installSkillCommand(argv: string[]): Promise<number> {
  const { repo, rest } = splitCommonFlags(argv)
  const cwd = process.cwd()
  const repoRoot = await resolveRepoRoot(createGit(repo === undefined ? cwd : path.resolve(cwd, repo)))
  return runInstallSkill({ repoRoot, cwd }, rest, io)
}

function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: err === null, stdout, stderr })
    )
  })
}

async function confirmOnTerminal(question: string): Promise<boolean | null> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim())
  } finally {
    rl.close()
  }
}

async function upgradeCommand(argv: string[]): Promise<number> {
  const { repo, rest } = splitCommonFlags(argv)
  const cwd = process.cwd()
  let repoRoot: string | null
  try {
    repoRoot = await resolveRepoRoot(createGit(repo === undefined ? cwd : path.resolve(cwd, repo)))
  } catch {
    repoRoot = null
  }
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { name: string }
  return runUpgrade(
    {
      packageName: pkg.name,
      version: readPackageVersion(),
      packageRoot: PACKAGE_ROOT,
      repoRoot,
      acpxVersion: () => createAgentRunner().acpxVersion(),
      acpxPath: findOnPath(ACPX_BIN, process.env),
      run: runCommand,
      runInstalled: args =>
        runCommand(process.execPath, [path.join(PACKAGE_ROOT, 'bin', 'pr-review.mjs'), ...args]),
      confirm: confirmOnTerminal,
    },
    rest,
    io
  )
}

export async function main(argv: string[]): Promise<number> {
  // `pnpm review -- --port 3011` forwards the `--` itself; drop it so parseArgs sees the flags.
  const [command, ...args] = argv.filter(a => a !== '--')
  const { json, rest } = outputMode(command ?? '', args, process.stdout.isTTY === true)
  io.json = json
  if (command === undefined || command === '--help' || command === '-h') {
    printUsage(process.stdout, readPackageVersion())
    return command === undefined ? EXIT.usage : EXIT.ok
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(command)) {
    printErrorEnvelope(io, 'BAD_REQUEST', `unknown command: ${command}`, 'run pr-review --help')
    return EXIT.usage
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    printUsage(process.stdout, readPackageVersion(), command)
    return EXIT.ok
  }
  try {
    switch (command) {
      case 'serve':
        return await runServe({ ...hubDeps(), startServer, checkSkill }, rest, io)
      case 'open':
        return await runOpen(hubDeps(), rest, io)
      case 'install-skill':
        return await installSkillCommand(rest)
      case 'doctor':
        return await doctorCommand(rest)
      case 'upgrade':
        return await upgradeCommand(rest)
      default: {
        const { repo, dataDir, rest: own } = splitCommonFlags(rest)
        const ctx = await buildContext(repo, dataDir, {
          canvasDir: namedCanvasDir(command, own),
          createDataDir: command !== 'validate' && command !== 'publish',
        })
        switch (command) {
          case 'prepare':
            return await runPrepare(ctx, own, io)
          case 'validate':
            return await runValidate(ctx, own, io)
          case 'export':
            return await runExport(ctx, own, io)
          case 'import':
            return await runImport(ctx, own, io)
          case 'clean':
            return await runClean(ctx, own, io)
          default:
            return await runPublish(ctx, own, io)
        }
      }
    }
  } catch (err) {
    return reportFailure(io, err)
  }
}

// Run directly (`tsx src/cli.ts …`) or through bin/pr-review.mjs, which calls main() itself.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
if (invokedDirectly) {
  const code = await main(process.argv.slice(2))
  if (code !== 0) {
    process.exit(code)
  }
}
