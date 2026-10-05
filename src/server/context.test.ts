// @vitest-environment node
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ChatBusyError, type ChatTarget } from '../chat/chat-manager.js'
import type { RuntimeConfig } from '../config.js'
import { toFileEntry, toPatchMap } from '../git/diff-collector.js'
import { GITHUB_HOST, gitlabHost } from '../host/host.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { createFakeRunner } from '../testing/fake-runner.js'
import {
  createFakeCheckoutGit,
  createFakeGh,
  createFakeGit,
  makeTempDir,
  TEST_REPO,
} from '../testing/fakes.js'
import { HEAD_SHA, SYNTHETIC_FILES, syntheticArtifact } from '../testing/synthetic.js'
import {
  type AppContext,
  createAppContext,
  createCloneShared,
  PACKAGE_ROOT,
  readPackageVersion,
  resolveVendorRoots,
  STATIC_DIR,
} from './context.js'

describe('context', () => {
  it('resolves the vendored browser libraries to files that exist', async () => {
    const roots = resolveVendorRoots()
    for (const file of [path.join(roots.diff, 'index.js'), roots.marked, roots.dompurify, roots.hljs]) {
      expect((await stat(file)).isFile()).toBe(true)
    }
    expect(roots.marked.endsWith('marked.esm.js')).toBe(true)
    expect(roots.dompurify.endsWith('purify.es.mjs')).toBe(true)
    expect(roots.hljs.endsWith(path.join('es', 'highlight.min.js'))).toBe(true)
  })

  it('reads the package version and knows where static files live', () => {
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(STATIC_DIR).toBe(path.join(PACKAGE_ROOT, 'static'))
  })

  it('assembles an AppContext with real stores and the given adapters', async () => {
    const dataDir = await makeTempDir()
    try {
      const git = createFakeGit()
      const gh = createFakeGh()
      const now = () => new Date(0)
      const ctx = createAppContext({
        config: {
          port: 1,
          repoRoot: '/r',
          commonDir: '/r/.git',
          dataDir,
          repo: TEST_REPO,
          host: GITHUB_HOST,
          slug: 'acme/widgets',
          basePath: '/r/acme/widgets/',
          fixtureCanvasPath: null,
          chatOverrides: {},
        },
        projectConfig: { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null },
        fixtureArtifact: null,
        git,
        gh,
        now,
      })
      expect(ctx.git).toBe(git)
      expect(ctx.gh).toBe(gh)
      expect(ctx.now).toBe(now)
      expect(ctx.canvases.root).toBe(path.join(dataDir, 'repos', 'acme__widgets'))
      expect(ctx.prs.prDir(3)).toBe(path.join(dataDir, 'repos', 'acme__widgets', 'prs', '3'))
      expect(ctx.fixtureArtifact).toBeNull()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('builds the real adapters when none are given', async () => {
    const dataDir = await makeTempDir()
    try {
      const ctx = createAppContext({
        config: {
          port: 1,
          repoRoot: PACKAGE_ROOT,
          commonDir: '/r/.git',
          dataDir,
          repo: TEST_REPO,
          host: GITHUB_HOST,
          slug: 'acme/widgets',
          basePath: '/r/acme/widgets/',
          fixtureCanvasPath: null,
          chatOverrides: {},
        },
        projectConfig: { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null },
        fixtureArtifact: null,
      })
      expect(typeof ctx.git.topLevel).toBe('function')
      expect(typeof ctx.gh.authStatus).toBe('function')
      expect(ctx.now()).toBeInstanceOf(Date)
      // The log goes to stderr, and fetch is the platform's.
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      try {
        ctx.log('hello')
        expect(write).toHaveBeenCalledWith('hello\n')
      } finally {
        write.mockRestore()
      }
      expect(await (await ctx.fetch('data:text/plain,fetched')).text()).toBe('fetched')
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  describe('for a project the shared server opened', () => {
    let dir: string
    const config = (host = GITHUB_HOST): RuntimeConfig => ({
      port: 1,
      repoRoot: dir,
      commonDir: path.join(dir, '.git'),
      dataDir: path.join(dir, 'data'),
      repo: TEST_REPO,
      host,
      slug: 'acme/widgets',
      basePath: '/r/acme/widgets/',
      fixtureCanvasPath: null,
      chatOverrides: {},
    })
    const projectConfig = { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null }

    beforeEach(async () => {
      dir = await makeTempDir()
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    /** A command on the shell's PATH that prints what it was run with. */
    async function onPath(name: string, script: string): Promise<string> {
      const bin = path.join(dir, 'bin')
      await mkdir(bin, { recursive: true })
      await writeFile(path.join(bin, name), `#!/bin/sh\n${script}\n`)
      await chmod(path.join(bin, name), 0o755)
      return bin
    }

    it("runs git, the host CLI, and the agent under the shell's environment, with the host's own variables on top", async () => {
      const print = 'echo "$PR_REVIEW_MARK/${PR_REVIEW_PROCESS_ONLY:-unset}"'
      await onPath('git', print)
      await onPath('glab', 'echo "{\\"mark\\":\\"$PR_REVIEW_MARK\\",\\"host\\":\\"$GITLAB_HOST\\"}"')
      const bin = await onPath('acpx', `echo "acpx $(${print})"`)
      // Set in this process only: a child of a project opened from another shell does not see it.
      process.env['PR_REVIEW_PROCESS_ONLY'] = 'leaked'
      try {
        const ctx = createAppContext({
          config: config(gitlabHost('gitlab.example.com')),
          projectConfig,
          fixtureArtifact: null,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            PR_REVIEW_MARK: 'from-shell',
            GITLAB_HOST: 'gitlab.other.example',
            UNSET: undefined,
          },
        })
        expect(await ctx.git.topLevel()).toBe('from-shell/unset')
        expect(await ctx.gh.api('user')).toEqual({ mark: 'from-shell', host: 'gitlab.example.com' })
        expect(await ctx.runner.acpxVersion()).toBe('acpx from-shell/unset')
      } finally {
        delete process.env['PR_REVIEW_PROCESS_ONLY']
      }
    })

    it('logs through the log it is given', () => {
      const logs: string[] = []
      const ctx = createAppContext({
        config: config(),
        projectConfig,
        fixtureArtifact: null,
        git: createFakeGit(),
        gh: createFakeGh(),
        log: line => logs.push(line),
      })
      ctx.log('hello')
      expect(logs).toEqual(['hello'])
    })

    it('shares the clone part it is given, so a sibling context refuses a chat turn and a generation', async () => {
      const now = () => new Date(0)
      const clone = createCloneShared(config(), now, createFakeCheckoutGit())
      const contexts = ['a', 'b'].map(name =>
        createAppContext({
          config: { ...config(), repoRoot: path.join(dir, name) },
          projectConfig,
          fixtureArtifact: null,
          git: createFakeGit(),
          gh: createFakeGh(),
          runner: createFakeRunner({ delayMs: 5 }),
          now,
          clone,
        })
      )
      const [a, b] = contexts as [AppContext, AppContext]
      expect(a.clone).toBe(clone)
      expect(b.checkouts).toBe(a.checkouts)
      const first = a.chat.send(target(), { message: 'x', context: { kind: 'pr' } })
      const turn = first[Symbol.asyncIterator]()
      await turn.next()
      expect([...clone.chatTurns]).toEqual([42])
      const second = b.chat.send(target(), { message: 'y', context: { kind: 'pr' } })
      await expect(second[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ChatBusyError)
      await turn.return?.(undefined)
      clone.generationLane.key = 7
      await expect(b.generation.start(8, { force: false })).rejects.toMatchObject({ key: 7 })
    })

    it('gives a context a clone part of its own when none is given', () => {
      const build = () =>
        createAppContext({
          config: config(),
          projectConfig,
          fixtureArtifact: null,
          git: createFakeGit(),
          gh: createFakeGh(),
        })
      const a = build()
      const b = build()
      expect(a.clone).not.toBe(b.clone)
      expect(a.checkouts).toBe(a.clone.checkouts)
      expect(a.checkouts.root).toBe(path.join(dir, 'data', 'repos', 'acme__widgets', 'checkouts'))
    })

    function target(): ChatTarget {
      return {
        key: 42,
        headSha: HEAD_SHA,
        artifact: syntheticArtifact(),
        files: SYNTHETIC_FILES.map(toFileEntry),
        patches: toPatchMap(SYNTHETIC_FILES),
        derivedDir: path.join(dir, 'derived'),
        readLines: async () => [],
      }
    }
  })
})
