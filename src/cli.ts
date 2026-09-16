import path from 'node:path'
import { parseArgs } from 'node:util'
import { createAgentRunner } from './acpx/acpx.js'
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
import { createGitHubClient } from './github/gh.js'
import { loadProjectConfig } from './project-config.js'
import { checkSkill } from './review/doctor.js'
import { type AppContext, createAppContext, readPackageVersion } from './server/context.js'
import { startServer } from './server/node-server.js'
import { readJson } from './store/atomic-json.js'
import { ensureDataDir } from './store/data-dir.js'

const SUBCOMMANDS = [
  'serve',
  'prepare',
  'validate',
  'publish',
  'export',
  'import',
  'install-skill',
  'doctor',
] as const

const USAGE = `usage: pr-review <command> [flags]

  serve [--port 3010] [--repo <dir>] [--data-dir <dir>] [--fixture-canvas <review.json>]
        [--agent claude|codex] [--model <id>]   (chat only; wins over .pr-review/settings.yml)
  prepare (--pr <n> | --base <ref> --head <ref>) [--force] [--repo <dir>] [--data-dir <dir>]
  validate <model.json|review.json> --canvas <dir> [--human] [--fix] [--repo <dir>] [--data-dir <dir>]
                   (--fix trims over-cap titles in place and reports each one)
  publish <canvasDir> --agent <id> [--model <id>] --harness claude-code|codex|other [--allow-stale]
  install-skill [--claude-dir .claude/skills] [--codex-dir .agents/skills] [--force] [--repo <dir>]
  export (--pr <n> | --head <ref|sha>) [--out <file|dir>] [--repo <dir>] [--data-dir <dir>]
                   (both flags: the named commit is exported and the number stamps the zip)
  import <zip> [--pr <n>] [--force] [--repo <dir>] [--data-dir <dir>]
  doctor [--all-checks] [--repo <dir>] [--data-dir <dir>]

Every command prints one JSON line on success and { "error": { code, message, hint } } on failure.
Exit codes: 0 ok, 1 error, 2 usage, 4 gh missing or not logged in, 5 invalid model output.
`

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

/** doctor builds no AppContext: it has to answer even when the repo or `gh` is the problem. */
async function doctorCommand(argv: string[]): Promise<number> {
  const { repo, dataDir, rest } = splitCommonFlags(argv)
  const cwd = process.cwd()
  const git = createGit(repo === undefined ? cwd : path.resolve(cwd, repo))
  return runDoctor(
    {
      git,
      gh: createGitHubClient(),
      version: readPackageVersion(),
      acpxVersion: () => createAgentRunner().acpxVersion(),
      dataDirOverride: dataDir ?? readEnv(process.env, 'PR_REVIEW_DATA_DIR'),
    },
    rest,
    io
  )
}

async function installSkillCommand(argv: string[]): Promise<number> {
  const { repo, rest } = splitCommonFlags(argv)
  const cwd = process.cwd()
  const repoRoot = await resolveRepoRoot(createGit(repo === undefined ? cwd : path.resolve(cwd, repo)))
  return runInstallSkill({ repoRoot, cwd }, rest, io)
}

export async function main(argv: string[]): Promise<number> {
  // `pnpm review -- --port 3011` forwards the `--` itself; drop it so parseArgs sees the flags.
  const [command, ...rest] = argv.filter(a => a !== '--')
  if (command === undefined || command === '--help' || command === '-h') {
    process.stderr.write(USAGE)
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
