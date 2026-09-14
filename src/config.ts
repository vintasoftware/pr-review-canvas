import path from 'node:path'
import type { Repo } from './contract/review-artifact.js'
import { isChatAgent, type SettingsOverrides } from './contract/settings.js'
import { type Git, GitError } from './git/git.js'
import { resolveDataDir } from './store/data-dir.js'

export const DEFAULT_PORT = 3010

export interface ServeFlags {
  port?: number | undefined
  repo?: string | undefined
  dataDir?: string | undefined
  fixtureCanvas?: string | undefined
  /** Wins over `.pr-review/settings.yml` for this run; the settings dialog reports it. */
  agent?: string | undefined
  model?: string | undefined
}

export interface RuntimeConfig {
  port: number
  repoRoot: string
  commonDir: string
  dataDir: string
  repo: Repo
  /** Dev only: every PR reports `ready` with this artifact re-keyed to the live head. */
  fixtureCanvasPath: string | null
  /** Chat agent and model the flags force for this run, if any. */
  chatOverrides: SettingsOverrides
}

export type ConfigErrorCode = 'NOT_A_REPO' | 'NO_ORIGIN' | 'BAD_REQUEST'

export class ConfigError extends Error {
  readonly code: ConfigErrorCode
  readonly hint: string | undefined

  constructor(code: ConfigErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.hint = hint
  }
}

export async function resolveRepoRoot(git: Git): Promise<string> {
  try {
    return await git.topLevel()
  } catch (err) {
    if (err instanceof GitError) {
      throw new ConfigError('NOT_A_REPO', 'not inside a git repository', 'run from a clone or pass --repo <dir>')
    }
    throw err
  }
}

export async function resolveCommonDir(git: Git): Promise<string> {
  return git.commonDir()
}

/** Parses the two URL forms GitHub gives out: ssh (`git@github.com:o/r.git`) and https. */
export function parseGithubRemote(url: string): Repo | null {
  const m =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      url.trim()
    )
  if (!m || m[1] === undefined || m[2] === undefined) {
    return null
  }
  return { owner: m[1], name: m[2] }
}

export async function resolveGithubRepo(git: Git): Promise<Repo> {
  const url = await git.remoteUrl('origin')
  if (url === null) {
    throw new ConfigError('NO_ORIGIN', 'the repository has no "origin" remote', 'add one that points at GitHub')
  }
  const repo = parseGithubRemote(url)
  if (repo === null) {
    throw new ConfigError(
      'NO_ORIGIN',
      `origin is not a GitHub URL: ${url}`,
      'only github.com repositories are supported'
    )
  }
  return repo
}

/** `--agent` names one of the agents the chat knows; anything else is a usage error. */
export function parseChatOverrides(flags: ServeFlags): SettingsOverrides {
  const overrides: SettingsOverrides = {}
  if (flags.agent !== undefined) {
    if (!isChatAgent(flags.agent)) {
      throw new ConfigError('BAD_REQUEST', `unknown chat agent: ${flags.agent}`, 'use --agent claude or --agent codex')
    }
    overrides.agent = flags.agent
  }
  if (flags.model !== undefined && flags.model !== '') {
    overrides.model = flags.model
  }
  return overrides
}

export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback
  }
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError('BAD_REQUEST', `invalid port: ${raw}`)
  }
  return n
}

/** Reads one variable by name, which also keeps the linter's literal-key rule happy. */
export function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]
}

/**
 * Flags win over env; env over defaults. `git` must already run in the chosen repo directory.
 */
export async function loadRuntimeConfig(
  flags: ServeFlags,
  env: NodeJS.ProcessEnv,
  git: Git,
  cwd: string
): Promise<RuntimeConfig> {
  const repoRoot = await resolveRepoRoot(git)
  const commonDir = await resolveCommonDir(git)
  const repo = await resolveGithubRepo(git)
  const port = flags.port ?? parsePort(readEnv(env, 'PR_REVIEW_PORT'), DEFAULT_PORT)
  const dataDir = resolveDataDir({ override: flags.dataDir ?? readEnv(env, 'PR_REVIEW_DATA_DIR'), commonDir })
  return {
    port,
    repoRoot,
    commonDir,
    dataDir,
    repo,
    fixtureCanvasPath: flags.fixtureCanvas === undefined ? null : path.resolve(cwd, flags.fixtureCanvas),
    chatOverrides: parseChatOverrides(flags),
  }
}
