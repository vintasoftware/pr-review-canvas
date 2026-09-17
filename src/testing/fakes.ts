// In-memory fakes for the two process boundaries (git, gh) and a test AppContext over a temp
// data dir. Tests build real stores on the real filesystem; only the processes are faked.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentRunner } from '../acpx/acpx.js'
import type { RuntimeConfig } from '../config.js'
import { GITHUB_HOST, type Host } from '../host/host.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { type Git, GitError } from '../git/git.js'
import { type CapabilityProbe, createCapabilityProbe } from '../host/capabilities.js'
import { type CliResponse, HostCliError, type HostClient } from '../host/client.js'
import { DEFAULT_PROJECT_CONFIG, type LoadedProjectConfig } from '../project-config.js'
import {
  type AppContext,
  createChatSet,
  createStores,
  STATIC_DIR,
  type VendorRoots,
} from '../server/context.js'
import { createFakeRunner } from './fake-runner.js'

export interface FakeGitOptions {
  refs?: Record<string, string>
  mergeBases?: Record<string, string>
  diffs?: Record<string, string>
  /** `<sha>:<path>` → content */
  blobs?: Record<string, string>
  topLevel?: string
  commonDir?: string
  remotes?: Record<string, string>
  /** `<sha>` → author name; unknown commits answer 'someone'. */
  authors?: Record<string, string>
  /** `<a>..<b>` → true when a is an ancestor of b; unlisted pairs are not ancestors. */
  ancestors?: Record<string, boolean>
  /** `<a>..<b>` → how many commits b is ahead of a; unlisted pairs count 0. */
  counts?: Record<string, number>
  /**
   * `<head> ^<base> ^<base>` → how many ordinary commits head reaches that no base does. An
   * unlisted query answers the `counts` entry of its first base, so a history that names no
   * merges is all ordinary commits.
   */
  nonMergeCounts?: Record<string, number>
  /** Commits the fake origin serves when they are fetched by sha. */
  fetchable?: string[]
}

export interface FakeGit extends Git {
  calls: string[][]
  options: FakeGitOptions
}

export function createFakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: string[][] = []
  const refs = options.refs ?? {}
  const shas = new Set(Object.values(refs))
  const fail = (args: string[], msg: string): never => {
    throw new GitError(args, msg, 128)
  }
  return {
    calls,
    options,
    revParse: async ref => {
      calls.push(['rev-parse', ref])
      const sha = refs[ref] ?? (shas.has(ref) ? ref : undefined)
      return sha ?? fail(['rev-parse', ref], 'fatal: Needed a single revision')
    },
    mergeBase: async (a, b) => {
      calls.push(['merge-base', a, b])
      return (
        options.mergeBases?.[`${a}..${b}`] ?? fail(['merge-base', a, b], 'fatal: Not a valid object name')
      )
    },
    commitExists: async sha => {
      calls.push(['cat-file', '-e', sha])
      return shas.has(sha) || Object.values(options.mergeBases ?? {}).includes(sha)
    },
    isAncestor: async (a, b) => {
      calls.push(['merge-base', '--is-ancestor', a, b])
      return options.ancestors?.[`${a}..${b}`] === true
    },
    countCommitsBetween: async (a, b) => {
      calls.push(['rev-list', '--count', `${a}..${b}`])
      return options.counts?.[`${a}..${b}`] ?? 0
    },
    countNonMergeCommitsNotIn: async (head, bases) => {
      const excluded = bases.map(b => `^${b}`)
      calls.push(['rev-list', '--no-merges', '--count', head, ...excluded])
      return (
        options.nonMergeCounts?.[[head, ...excluded].join(' ')] ??
        options.counts?.[`${bases[0]}..${head}`] ??
        0
      )
    },
    diff: async (base, head) => {
      calls.push(['diff', base, head])
      return options.diffs?.[`${base}..${head}`] ?? fail(['diff', base, head], 'fatal: bad revision')
    },
    fetch: async (remote, refspecs) => {
      calls.push(['fetch', remote, ...refspecs])
      for (const spec of refspecs) {
        const m = /^\+?([^:]+):(.+)$/.exec(spec)
        if (m === null) {
          // A bare sha: the fake origin serves it when it is on the fetchable list.
          if (options.fetchable?.includes(spec) === true) {
            shas.add(spec)
          }
          continue
        }
        const from = m[1] === undefined ? undefined : refs[m[1]]
        if (from !== undefined && m[2] !== undefined) {
          refs[m[2]] = from
        }
      }
    },
    show: async (ref, p) => {
      calls.push(['show', `${ref}:${p}`])
      const content = options.blobs?.[`${ref}:${p}`]
      return content === undefined ? null : Buffer.from(content, 'utf8')
    },
    blobSize: async (ref, p) => {
      calls.push(['cat-file', '-s', `${ref}:${p}`])
      const content = options.blobs?.[`${ref}:${p}`]
      return content === undefined ? null : Buffer.byteLength(content, 'utf8')
    },
    commitAuthor: async ref => {
      calls.push(['log', '-1', '--format=%an', ref])
      const sha = refs[ref] ?? ref
      return options.authors?.[sha] ?? 'someone'
    },
    topLevel: async () => {
      calls.push(['rev-parse', '--show-toplevel'])
      return options.topLevel ?? fail(['rev-parse', '--show-toplevel'], 'fatal: not a git repository')
    },
    commonDir: async () => {
      calls.push(['rev-parse', '--git-common-dir'])
      return options.commonDir ?? fail(['rev-parse', '--git-common-dir'], 'fatal: not a git repository')
    },
    remoteUrl: async name => {
      calls.push(['remote', 'get-url', name])
      return options.remotes?.[name] ?? null
    },
  }
}

/** What a fake REST path answers: a JSON body, a body computed from the query params, or a throw. */
export type FakeGhRoute =
  | { kind: 'json'; body: unknown }
  | { kind: 'handler'; handler: (params: Record<string, string>) => unknown }
  | { kind: 'error'; error: Error }

export const ghJson = (body: unknown): FakeGhRoute => ({ kind: 'json', body })
export const ghHandler = (handler: (params: Record<string, string>) => unknown): FakeGhRoute => ({
  kind: 'handler',
  handler,
})
export const ghError = (error: Error): FakeGhRoute => ({ kind: 'error', error })

/** What a fake POST answers: a JSON body computed from the posted payload, or a throw. */
export type FakePostRoute =
  | { kind: 'json'; handler: (body: unknown) => unknown }
  | { kind: 'error'; error: Error }

export const ghPost = (handler: (body: unknown) => unknown): FakePostRoute => ({ kind: 'json', handler })
export const ghPostError = (error: Error): FakePostRoute => ({ kind: 'error', error })

export interface FakeGhOptions {
  /** `path` → route; unknown paths answer like GitHub's 404. */
  routes?: Record<string, FakeGhRoute>
  /** `path` → what `gh api -i` answers. */
  rawRoutes?: Record<string, CliResponse | Error>
  /** `path` → what a POST answers. */
  postRoutes?: Record<string, FakePostRoute>
  /** GraphQL pages in call order. */
  graphql?: Array<unknown | Error>
  auth?: { installed: boolean; authenticated: boolean; detail: string }
  /** What `gh auth token` answers; null means no login. */
  token?: string | null
}

export interface FakeGh extends HostClient {
  calls: Array<{
    kind: 'api' | 'raw' | 'post' | 'graphql' | 'auth'
    path: string
    params: Record<string, string | number>
    body?: unknown
  }>
}

export function createFakeGh(options: FakeGhOptions = {}): FakeGh {
  const calls: FakeGh['calls'] = []
  let gqlCall = 0
  return {
    calls,
    api: async (p, params = {}) => {
      calls.push({ kind: 'api', path: p, params })
      const route = options.routes?.[p]
      if (route === undefined) {
        throw new HostCliError('gh', p, 'gh: Not Found (HTTP 404)', 1)
      }
      switch (route.kind) {
        case 'json':
          return route.body
        case 'handler':
          return route.handler(params)
        case 'error':
          throw route.error
      }
    },
    apiWithHeaders: async p => {
      calls.push({ kind: 'raw', path: p, params: {} })
      const route = options.rawRoutes?.[p]
      if (route === undefined) {
        throw new HostCliError('gh', p, 'gh: Not Found (HTTP 404)', 1)
      }
      if (route instanceof Error) {
        throw route
      }
      return route
    },
    post: async (p, body) => {
      calls.push({ kind: 'post', path: p, params: {}, body })
      const route = options.postRoutes?.[p]
      if (route === undefined) {
        throw new HostCliError('gh', p, 'gh: Not Found (HTTP 404)', 1)
      }
      if (route.kind === 'error') {
        throw route.error
      }
      return route.handler(body)
    },
    graphql: async (query, variables) => {
      calls.push({ kind: 'graphql', path: query.slice(0, 20), params: variables })
      const page = options.graphql?.[gqlCall++]
      if (page === undefined) {
        throw new HostCliError('gh', 'graphql', 'no more pages', 1)
      }
      if (page instanceof Error) {
        throw page
      }
      return page
    },
    authStatus: async () => {
      calls.push({ kind: 'auth', path: 'auth status', params: {} })
      return options.auth ?? { installed: true, authenticated: true, detail: 'Logged in to github.com' }
    },
    authToken: async () => {
      calls.push({ kind: 'auth', path: 'auth token', params: {} })
      return options.token === undefined ? 'gh-test-token' : options.token
    },
  }
}

export const TEST_REPO = { owner: 'acme', name: 'widgets' }

/** A test that does not expect an outbound request fails loudly instead of reaching the network. */
const notFetched: typeof fetch = input => {
  throw new Error(`unexpected fetch: ${String(input)}`)
}

export interface TestContextOptions {
  git?: Git
  gh?: HostClient
  /** The forge the context serves; GitHub unless a test says otherwise. */
  host?: Host
  capabilities?: CapabilityProbe
  fetch?: typeof fetch
  fixtureArtifact?: ReviewArtifact | null
  projectConfig?: LoadedProjectConfig
  runner?: AgentRunner
  /** `serve --agent/--model` for this context. */
  chatOverrides?: RuntimeConfig['chatOverrides']
  now?: () => Date
  vendorRoots?: VendorRoots
}

export interface TestContext {
  ctx: AppContext
  dataDir: string
  cleanup: () => Promise<void>
}

export async function makeTempDir(prefix = 'pr-review-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

/** A full AppContext with real stores under a fresh temp data dir. */
export async function makeTestContext(opts: TestContextOptions = {}): Promise<TestContext> {
  const dataDir = await makeTempDir()
  const config: RuntimeConfig = {
    port: 3010,
    repoRoot: '/repo',
    commonDir: '/repo/.git',
    dataDir,
    repo: TEST_REPO,
    host: opts.host ?? GITHUB_HOST,
    fixtureCanvasPath: null,
    chatOverrides: opts.chatOverrides ?? {},
  }
  const git = opts.git ?? createFakeGit()
  const now = opts.now ?? (() => new Date('2026-09-10T12:00:00.000Z'))
  const gh = opts.gh ?? createFakeGh()
  const stores = createStores(dataDir, config, git, now)
  const ctx: AppContext = {
    log: () => undefined,
    config,
    projectConfig: opts.projectConfig ?? { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null },
    git,
    gh,
    capabilities:
      opts.capabilities ?? createCapabilityProbe(() => config.host.probeCapabilities(gh, TEST_REPO), now),
    fetch: opts.fetch ?? notFetched,
    ...stores,
    ...createChatSet(
      config,
      opts.runner ?? createFakeRunner(),
      stores,
      now,
      opts.projectConfig?.config.prompts
    ),
    now,
    version: '0.0.0-test',
    staticDir: STATIC_DIR,
    vendorRoots: opts.vendorRoots ?? {
      diff: '/nonexistent/diff',
      marked: '/nonexistent/marked.js',
      dompurify: '/nonexistent/purify.js',
      hljs: '/nonexistent/hljs.js',
      mermaid: '/nonexistent/mermaid',
    },
    fixtureArtifact: opts.fixtureArtifact ?? null,
  }
  return { ctx, dataDir, cleanup: () => rm(dataDir, { recursive: true, force: true }) }
}
