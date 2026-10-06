import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AgentRunner, createAgentRunner } from '../acpx/acpx.js'
import { type AgentDirectory, createAgentDirectory } from '../acpx/agents.js'
import { createPreflightProbe, type PreflightProbe } from '../acpx/preflight.js'
import { type ChatManager, createChatManager, type TurnSet } from '../chat/chat-manager.js'
import {
  type CheckoutGit,
  type CheckoutStore,
  checkoutsFor,
  createCheckoutGit,
  createReviewCheckouts,
  type ReviewCheckouts,
} from '../chat/checkouts.js'
import type { PromptOverrides } from '../project-config.js'
import { loadSeedTemplate } from '../chat/seed.js'
import { createTranscriptStore, type TranscriptStore } from '../chat/threads.js'
import type { RuntimeConfig } from '../config.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { reviewFolder } from '../contract/review-key.js'
import {
  createGenerationManager,
  type GenerationLane,
  type GenerationManager,
} from '../generate/generation-manager.js'
import { loadGenerationSkill } from '../generate/skill.js'
import { createGit, execGitIn, type Git } from '../git/git.js'
import { type CapabilityProbe, createCapabilityProbe } from '../host/capabilities.js'
import { createHostClient, execCliIn, type HostClient } from '../host/client.js'
import { describeFixes, fixModel } from '../review/fix-model.js'
import { prepare } from '../review/prepare.js'
import { publish, readContext } from '../review/publish.js'
import { PACKAGE_ROOT, STATIC_DIR } from '../paths.js'
import type { LoadedProjectConfig } from '../project-config.js'
import { type CanvasStore, createCanvasStore } from '../store/canvas-store.js'
import { repoDir } from '../store/data-dir.js'
import { createDerivedStore, type DerivedStore } from '../store/derived-store.js'
import { createPrStore, type PrStore } from '../store/pr-store.js'
import { createSettingsStore, type SettingsStore } from '../store/settings-store.js'
import { createStateStore, type StateStore } from '../store/state-store.js'

/** Directory roots the `/vendor/*` route may serve from. Exact files are listed in routes/static.ts. */
export interface VendorRoots {
  diff: string
  marked: string
  dompurify: string
  hljs: string
  mermaid: string
}

/**
 * Everything a route or pipeline needs, as a plain object. Real adapters are built once by
 * `createAppContext`; tests assemble their own with fakes and a temp data dir.
 */
export interface AppContext {
  log: (line: string) => void
  config: RuntimeConfig
  projectConfig: LoadedProjectConfig
  git: Git
  /** The host CLI client: `gh` or `glab`, whichever `config.host` names. */
  gh: HostClient
  /** The only outbound HTTP the tool makes: attachment downloads. Tests inject a fake. */
  fetch: typeof fetch
  canvases: CanvasStore
  derived: DerivedStore
  prs: PrStore
  state: StateStore
  /** What this forge login may post here, probed once and reused for ten minutes. */
  capabilities: CapabilityProbe
  /** Personal chat settings, in `.pr-review/settings.yml`. */
  settings: SettingsStore
  /** Which chat agents can run right now, and the one-shot probe behind the settings dialog. */
  agents: AgentDirectory
  /** Is acpx itself installed? A missing acpx disables the chat pane with a banner. */
  preflight: PreflightProbe
  chat: ChatManager
  /** The canvas generation the review page starts. */
  generation: GenerationManager
  /** What the context shares with the other worktrees of its clone. */
  clone: CloneShared
  /** The acpx boundary, shared by the chat and the generation the review page starts. */
  runner: AgentRunner
  transcripts: TranscriptStore
  /** The review checkouts AI Chat reads code from, one per review. */
  checkouts: ReviewCheckouts
  now: () => Date
  version: string
  staticDir: string
  vendorRoots: VendorRoots
  fixtureArtifact: ReviewArtifact | null
}

export { PACKAGE_ROOT, STATIC_DIR }

const require = createRequire(import.meta.url)

export function resolveVendorRoots(): VendorRoots {
  return {
    diff: path.dirname(fileURLToPath(import.meta.resolve('diff'))),
    marked: fileURLToPath(import.meta.resolve('marked')),
    dompurify: fileURLToPath(import.meta.resolve('dompurify')),
    hljs: path.join(
      path.dirname(require.resolve('@highlightjs/cdn-assets/package.json')),
      'es',
      'highlight.min.js'
    ),
    mermaid: path.dirname(fileURLToPath(import.meta.resolve('mermaid'))),
  }
}

export function readPackageVersion(): string {
  const pkg = require(path.join(PACKAGE_ROOT, 'package.json')) as { version: string }
  return pkg.version
}

export interface StoreSet {
  canvases: CanvasStore
  derived: DerivedStore
  prs: PrStore
  state: StateStore
}

/** The four stores over one repo directory. Shared by the real context and by tests. */
export function createStores(dataDir: string, config: RuntimeConfig, git: Git, now: () => Date): StoreSet {
  const root = repoDir(dataDir, config.repo)
  const canvases = createCanvasStore(root, git, config.worktree)
  const prs = createPrStore(root, config.worktree)
  return {
    canvases,
    derived: createDerivedStore(canvases, git, now),
    prs,
    state: createStateStore(prs, now),
  }
}

export interface CreateAppContextOptions {
  config: RuntimeConfig
  projectConfig: LoadedProjectConfig
  fixtureArtifact: ReviewArtifact | null
  git?: Git
  gh?: HostClient
  fetch?: typeof fetch
  runner?: AgentRunner
  now?: () => Date
  log?: ((line: string) => void) | undefined
  /**
   * The environment git, the host CLI, and the agent run under: that of the shell that opened the
   * project, held in memory only. This process's own when omitted.
   */
  env?: NodeJS.ProcessEnv | undefined
  /** What the context shares with the other worktrees of its clone; a part of its own if omitted. */
  clone?: CloneShared | undefined
}

/**
 * What the worktrees of one clone share, as they share its `.pr-review/` data dir: the review
 * checkouts, and the work that writes its files. A chat turn on a review, or a generation, in one
 * worktree keeps the others from starting one over the same files.
 */
export interface CloneShared {
  /** Run from the clone's common git dir, so no one worktree's folder has to stay. */
  checkouts: CheckoutStore
  /**
   * The reviews with a chat turn running, by review folder: a pull request is one review for every
   * worktree, a local review is its own checkout's.
   */
  chatTurns: Set<string>
  generationLane: GenerationLane
}

/** The clone's chat turns as one checkout sees them, the same way it sees the clone's checkouts. */
function turnsFor(folders: Set<string>, worktree: string | null): TurnSet {
  return {
    has: key => folders.has(reviewFolder(key, worktree)),
    add: key => void folders.add(reviewFolder(key, worktree)),
    delete: key => void folders.delete(reviewFolder(key, worktree)),
  }
}

/**
 * The review checkouts' git runs under the server's own environment: one clone part serves
 * worktrees opened from different shells, and adding or moving a checkout reads only objects the
 * clone already has.
 */
export function createCloneShared(
  config: Pick<RuntimeConfig, 'dataDir' | 'repo' | 'commonDir'>,
  now: () => Date,
  checkoutGit: CheckoutGit = createCheckoutGit(config.commonDir)
): CloneShared {
  return {
    checkouts: createReviewCheckouts({ root: checkoutsRoot(config.dataDir, config), git: checkoutGit, now }),
    chatTurns: new Set(),
    generationLane: { key: null },
  }
}

export interface ChatSet {
  /** The acpx boundary, shared by the chat and the generation the review page starts. */
  runner: AgentRunner
  settings: SettingsStore
  agents: AgentDirectory
  preflight: PreflightProbe
  chat: ChatManager
  transcripts: TranscriptStore
  checkouts: ReviewCheckouts
}

/** Where the review checkouts of one repository live, next to its canvases. */
export function checkoutsRoot(dataDir: string, config: Pick<RuntimeConfig, 'repo'>): string {
  return path.join(repoDir(dataDir, config.repo), 'checkouts')
}

/** The chat side of the context, built over the same stores. Shared by the real context and tests. */
export function createChatSet(
  config: RuntimeConfig,
  runner: AgentRunner,
  stores: StoreSet,
  now: () => Date,
  git: Git,
  clone: CloneShared,
  prompts?: PromptOverrides
): ChatSet {
  const settings = createSettingsStore(config.dataDir)
  const checkouts = checkoutsFor(clone.checkouts, config.worktree)
  const preflight = createPreflightProbe(runner, now)
  const transcripts = createTranscriptStore(key => stores.prs.prDir(key))
  return {
    runner,
    settings,
    preflight,
    transcripts,
    checkouts,
    agents: createAgentDirectory({ runner, preflight, cwd: config.repoRoot, now }),
    chat: createChatManager({
      runner,
      settings,
      state: stores.state,
      transcripts,
      repo: config.repo,
      repoRoot: config.repoRoot,
      overrides: config.chatOverrides,
      loadSeedTemplate: () => loadSeedTemplate(undefined, { repoRoot: config.repoRoot, overrides: prompts }),
      checkouts,
      currentBranch: () => git.currentBranch(),
      now,
      turns: turnsFor(clone.chatTurns, config.worktree),
    }),
  }
}

/**
 * The generation manager over the real pipeline: the same prepare and publish the CLI runs. It is
 * built from the rest of the context, and its steps run over the whole context once it exists.
 */
export function createContextGeneration(
  ctx: Omit<AppContext, 'generation'>,
  lane: GenerationLane,
  whole: () => AppContext
): GenerationManager {
  return createGenerationManager({
    runner: ctx.runner,
    checkouts: ctx.checkouts,
    lane,
    steps: {
      prepare: (input, opts) => prepare(whole(), input, opts),
      publish: (canvasDir, opts) => publish(whole(), canvasDir, opts),
      fix: async (canvasDir, modelPath, text) => {
        const context = await readContext(canvasDir)
        const { patches } = await ctx.derived.ensure(context.headSha, context.mergeBaseSha)
        return describeFixes(await fixModel(modelPath, text, context, patches))
      },
    },
    settings: () => ctx.chat.effectiveSettings(),
    skill: agent => loadGenerationSkill(ctx.config.repoRoot, agent, ctx.version),
    generation: ctx.projectConfig.config.generation,
    repo: ctx.config.repo,
    repoRoot: ctx.config.repoRoot,
    currentBranch: () => ctx.git.currentBranch(),
    log: ctx.log,
    now: ctx.now,
  })
}

export function createAppContext(opts: CreateAppContextOptions): AppContext {
  // git, the host CLI, and the agent all run as they would from the shell that opened the
  // project: its tokens, ssh agent, config dirs, and PATH.
  const env = opts.env ?? process.env
  const git = opts.git ?? createGit(opts.config.repoRoot, execGitIn(env))
  const now = opts.now ?? (() => new Date())
  const { host, repo } = opts.config
  const gh = opts.gh ?? createHostClient(host.cli, execCliIn(env))
  const runner = opts.runner ?? createAgentRunner({ env })
  const stores = createStores(opts.config.dataDir, opts.config, git, now)
  const clone = opts.clone ?? createCloneShared(opts.config, now)
  const parts: Omit<AppContext, 'generation'> = {
    config: opts.config,
    clone,
    log: opts.log ?? (line => process.stderr.write(`${line}\n`)),
    projectConfig: opts.projectConfig,
    git,
    gh,
    capabilities: createCapabilityProbe(() => host.probeCapabilities(gh, repo), now),
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ...stores,
    ...createChatSet(opts.config, runner, stores, now, git, clone, opts.projectConfig.config.prompts),
    now,
    version: readPackageVersion(),
    staticDir: STATIC_DIR,
    vendorRoots: resolveVendorRoots(),
    fixtureArtifact: opts.fixtureArtifact,
  }
  const ctx: AppContext = {
    ...parts,
    generation: createContextGeneration(parts, clone.generationLane, () => ctx),
  }
  return ctx
}
