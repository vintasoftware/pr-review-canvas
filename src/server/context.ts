import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AgentRunner, createAgentRunner } from '../acpx/acpx.js'
import { type AgentDirectory, createAgentDirectory } from '../acpx/agents.js'
import { createPreflightProbe, type PreflightProbe } from '../acpx/preflight.js'
import { type ChatManager, createChatManager } from '../chat/chat-manager.js'
import type { PromptOverrides } from '../project-config.js'
import { loadSeedTemplate } from '../chat/seed.js'
import { createTranscriptStore, type TranscriptStore } from '../chat/threads.js'
import type { RuntimeConfig } from '../config.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { createGit, type Git } from '../git/git.js'
import { type CapabilityProbe, createCapabilityProbe } from '../host/capabilities.js'
import { createHostClient, type HostClient } from '../host/client.js'
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
  transcripts: TranscriptStore
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
  const canvases = createCanvasStore(root, git)
  const prs = createPrStore(root)
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
}

export interface ChatSet {
  settings: SettingsStore
  agents: AgentDirectory
  preflight: PreflightProbe
  chat: ChatManager
  transcripts: TranscriptStore
}

/** The chat side of the context, built over the same stores. Shared by the real context and tests. */
export function createChatSet(
  config: RuntimeConfig,
  runner: AgentRunner,
  stores: StoreSet,
  now: () => Date,
  prompts?: PromptOverrides
): ChatSet {
  const settings = createSettingsStore(config.dataDir)
  const preflight = createPreflightProbe(runner, now)
  const transcripts = createTranscriptStore(number => stores.prs.prDir(number))
  return {
    settings,
    preflight,
    transcripts,
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
      now,
    }),
  }
}

export function createAppContext(opts: CreateAppContextOptions): AppContext {
  const git = opts.git ?? createGit(opts.config.repoRoot)
  const now = opts.now ?? (() => new Date())
  const { host, repo } = opts.config
  const gh = opts.gh ?? createHostClient(host.cli)
  const stores = createStores(opts.config.dataDir, opts.config, git, now)
  return {
    config: opts.config,
    log: line => process.stderr.write(`${line}\n`),
    projectConfig: opts.projectConfig,
    git,
    gh,
    capabilities: createCapabilityProbe(() => host.probeCapabilities(gh, repo), now),
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ...stores,
    ...createChatSet(
      opts.config,
      opts.runner ?? createAgentRunner(),
      stores,
      now,
      opts.projectConfig.config.prompts
    ),
    now,
    version: readPackageVersion(),
    staticDir: STATIC_DIR,
    vendorRoots: resolveVendorRoots(),
    fixtureArtifact: opts.fixtureArtifact,
  }
}
