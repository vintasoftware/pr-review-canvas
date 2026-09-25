import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { ACPX_BIN, createAgentRunner, findOnPath } from './acpx/acpx.js'
import {
  type CliIo,
  EXIT,
  printErrorEnvelope,
  reportFailure,
  runDoctor,
  runExport,
  runImport,
  runInstallSkill,
  runPrepare,
  runPublish,
  runValidate,
  splitCommonFlags,
} from './commands.js'
import { ConfigError, loadRuntimeConfig, parsePort, readEnv, resolveRepoRoot } from './config.js'
import { type ReviewArtifact, ReviewArtifactSchema } from './contract/review-artifact.js'
import { createGit } from './git/git.js'
import { printUsage } from './help.js'
import { createHostClient } from './host/client.js'
import { loadProjectConfig } from './project-config.js'
import { checkSkill } from './review/doctor.js'
import { type AppContext, createAppContext, readPackageVersion } from './server/context.js'
import { startServer } from './server/node-server.js'
import { PACKAGE_ROOT } from './paths.js'
import { readJson } from './store/atomic-json.js'
import { ensureDataDir } from './store/data-dir.js'
import { type CommandResult, runUpgrade } from './upgrade.js'

const SUBCOMMANDS = [
  'serve',
  'prepare',
  'validate',
  'publish',
  'export',
  'import',
  'install-skill',
  'doctor',
  'upgrade',
] as const

const io: CliIo = {
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
}

async function buildContext(
  repo: string | undefined,
  dataDir: string | undefined,
  extra: {
    port?: string | undefined
    fixtureCanvas?: string | undefined
    agent?: string | undefined
    model?: string | undefined
  } = {}
): Promise<AppContext> {
  const cwd = process.cwd()
  const repoDir = repo === undefined ? cwd : path.resolve(cwd, repo)
  const git = createGit(repoDir)
  const config = await loadRuntimeConfig(
    {
      port: extra.port === undefined ? undefined : parsePort(extra.port, 0),
      dataDir,
      fixtureCanvas: extra.fixtureCanvas,
      agent: extra.agent,
      model: extra.model,
    },
    process.env,
    git,
    cwd
  )
  const projectConfig = await loadProjectConfig(config.repoRoot)
  await ensureDataDir(config.dataDir)
  const fixtureArtifact =
    config.fixtureCanvasPath === null ? null : await loadFixture(config.fixtureCanvasPath)
  return createAppContext({ config, projectConfig, fixtureArtifact })
}

async function loadFixture(file: string): Promise<ReviewArtifact> {
  const artifact = await readJson(file, ReviewArtifactSchema)
  if (artifact === null) {
    throw new ConfigError('BAD_REQUEST', `fixture canvas not found: ${file}`)
  }
  return artifact
}

async function serve(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      repo: { type: 'string' },
      'data-dir': { type: 'string' },
      'fixture-canvas': { type: 'string' },
      agent: { type: 'string' },
      model: { type: 'string' },
    },
    strict: true,
  })
  const ctx = await buildContext(values.repo, values['data-dir'], {
    port: values.port,
    fixtureCanvas: values['fixture-canvas'],
    agent: values.agent,
    model: values.model,
  })
  const skill = await checkSkill(ctx.config.repoRoot)
  if (!skill.ok) io.stderr(`pr-review doctor: ${skill.detail}. ${skill.hint ?? ''}`)
  startServer(ctx, line => process.stderr.write(`${line}\n`))
  return EXIT.ok
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
  const [command, ...rest] = argv.filter(a => a !== '--')
  if (command === undefined || command === '--help' || command === '-h') {
    printUsage(process.stderr, readPackageVersion())
    return command === undefined ? EXIT.usage : EXIT.ok
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(command)) {
    printErrorEnvelope(io, 'BAD_REQUEST', `unknown command: ${command}`, 'run pr-review --help')
    return EXIT.usage
  }
  try {
    switch (command) {
      case 'serve':
        return await serve(rest)
      case 'install-skill':
        return await installSkillCommand(rest)
      case 'doctor':
        return await doctorCommand(rest)
      case 'upgrade':
        return await upgradeCommand(rest)
      default: {
        const { repo, dataDir, rest: own } = splitCommonFlags(rest)
        const ctx = await buildContext(repo, dataDir)
        switch (command) {
          case 'prepare':
            return await runPrepare(ctx, own, io)
          case 'validate':
            return await runValidate(ctx, own, io)
          case 'export':
            return await runExport(ctx, own, io)
          case 'import':
            return await runImport(ctx, own, io)
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
