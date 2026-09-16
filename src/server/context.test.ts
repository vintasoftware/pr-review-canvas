// @vitest-environment node
import { rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { createFakeGh, createFakeGit, makeTempDir, TEST_REPO } from '../testing/fakes.js'
import {
  createAppContext,
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
          fixtureCanvasPath: null,
          chatOverrides: {},
        },
        projectConfig: { config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null },
        fixtureArtifact: null,
      })
      expect(typeof ctx.git.topLevel).toBe('function')
      expect(typeof ctx.gh.authStatus).toBe('function')
      expect(ctx.now()).toBeInstanceOf(Date)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
