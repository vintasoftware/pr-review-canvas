import path from 'node:path'
import type { Repo } from './contract/review-artifact.js'
import { isChatAgent, type SettingsOverrides } from './contract/settings.js'
import { type Git, GitError } from './git/git.js'
import type { Host } from './host/host.js'
import { type OriginRemote, parseOriginRemote } from './host/remote.js'
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
  noOpen?: boolean | undefined
}

export interface RuntimeConfig {
  port: number
  repoRoot: string
  commonDir: string
  dataDir: string
  repo: Repo
  /** The forge origin points at, which owns every request or answer that differs between them. */
  host: Host
  /** Dev only: every PR reports `ready` with this artifact re-keyed to the live head. */
  fixtureCanvasPath: string | null
  /** Chat agent and model the flags force for this run, if any. */
  chatOverrides: SettingsOverrides
  /** Open the index in the default browser once the port is bound. Off with `--no-open` or in CI. */
  openBrowser: boolean
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
      throw new ConfigError(
        'NOT_A_REPO',
        'not inside a git repository',
        'run from a clone or pass --repo <dir>'
      )
    }
    throw err
  }
}

export async function resolveCommonDir(git: Git): Promise<string> {
  return git.commonDir()
}

export const ORIGIN_HINT =
  'add a github.com or GitLab origin, or set PR_REVIEW_HOST=gitlab for self-hosted GitLab'

export async function resolveOrigin(git: Git, env: NodeJS.ProcessEnv = {}): Promise<OriginRemote> {
  const url = await git.remoteUrl('origin')
  if (url === null) {
    throw new ConfigError('NO_ORIGIN', 'the repository has no "origin" remote', ORIGIN_HINT)
  }
  const parsed = parseOriginRemote(url, env)
  if (parsed === null) {
    throw new ConfigError('NO_ORIGIN', `origin is not a GitHub or GitLab URL: ${url}`, ORIGIN_HINT)
  }
  return parsed
}

/** `--agent` names one of the agents the chat knows; anything else is a usage error. */
export function parseChatOverrides(flags: ServeFlags): SettingsOverrides {
  const overrides: SettingsOverrides = {}
  if (flags.agent !== undefined) {
    if (!isChatAgent(flags.agent)) {
      throw new ConfigError(
        'BAD_REQUEST',
        `unknown chat agent: ${flags.agent}`,
        'use --agent claude or --agent codex'
      )
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
  const { repo, host } = await resolveOrigin(git, env)
  const port = flags.port ?? parsePort(readEnv(env, 'PR_REVIEW_PORT'), DEFAULT_PORT)
  const dataDir = resolveDataDir({ override: flags.dataDir ?? readEnv(env, 'PR_REVIEW_DATA_DIR'), commonDir })
  return {
    port,
    repoRoot,
    commonDir,
    dataDir,
    repo,
    host,
    fixtureCanvasPath: flags.fixtureCanvas === undefined ? null : path.resolve(cwd, flags.fixtureCanvas),
    chatOverrides: parseChatOverrides(flags),
    openBrowser: flags.noOpen !== true && readEnv(env, 'CI') === undefined,
  }
}
