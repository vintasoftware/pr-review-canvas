// One checkout's context, as every command and the shared server build it: the config from git,
// the flags, and the environment, then the project config, the data dir, and the dev fixture.
import path from 'node:path'
import { z } from 'zod'
import { ConfigError, loadRuntimeConfig, type RuntimeConfig } from './config.js'
import { type ReviewArtifact, ReviewArtifactSchema } from './contract/review-artifact.js'
import { createGit, execGitIn } from './git/git.js'
import { loadProjectConfig } from './project-config.js'
import { type AppContext, type CloneShared, createAppContext } from './server/context.js'
import { readJson } from './store/atomic-json.js'
import { ensureDataDir } from './store/data-dir.js'

/** The per-project flags of `serve` and `open`. The server saves them with the project. */
export const ProjectFlagsSchema = z.object({
  dataDir: z.string().optional(),
  fixtureCanvas: z.string().optional(),
  chatAgent: z.string().optional(),
  chatModel: z.string().optional(),
})
export type ProjectFlags = z.infer<typeof ProjectFlagsSchema>

export interface LoadContextOptions {
  /** A folder inside the checkout. */
  repoDir: string
  /** What relative paths in the flags are relative to. */
  cwd: string
  flags?: ProjectFlags | undefined
  /** The canvas validate or publish names; it also picks the data dir. */
  canvasDir?: string | undefined
  /** False for validate and publish: they work in the data dir prepare made, so they create none. */
  createDataDir?: boolean | undefined
  /** The shell the checkout was opened from; this process's when omitted. */
  env?: NodeJS.ProcessEnv | undefined
  port?: number | undefined
  log?: ((line: string) => void) | undefined
  /** The part the server shares between the worktrees of one clone, once the config names it. */
  cloneOf?: ((config: RuntimeConfig) => CloneShared) | undefined
}

export async function loadFixture(file: string): Promise<ReviewArtifact> {
  const artifact = await readJson(file, ReviewArtifactSchema)
  if (artifact === null) {
    throw new ConfigError('BAD_REQUEST', `fixture canvas not found: ${file}`)
  }
  return artifact
}

export async function loadContext(opts: LoadContextOptions): Promise<AppContext> {
  const env = opts.env ?? process.env
  const flags = opts.flags ?? {}
  const git = createGit(opts.repoDir, execGitIn(env))
  const config = await loadRuntimeConfig(
    {
      port: opts.port,
      dataDir: flags.dataDir === undefined ? undefined : path.resolve(opts.cwd, flags.dataDir),
      canvasDir: opts.canvasDir,
      fixtureCanvas: flags.fixtureCanvas,
      chatAgent: flags.chatAgent,
      chatModel: flags.chatModel,
    },
    env,
    git,
    opts.cwd
  )
  const projectConfig = await loadProjectConfig(config.repoRoot)
  if (opts.createDataDir !== false) {
    await ensureDataDir(config.dataDir)
  }
  const fixtureArtifact =
    config.fixtureCanvasPath === null ? null : await loadFixture(config.fixtureCanvasPath)
  return createAppContext({
    config,
    projectConfig,
    fixtureArtifact,
    git,
    env,
    log: opts.log,
    clone: opts.cloneOf?.(config),
  })
}
