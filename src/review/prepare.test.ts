// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GenerationContextSchema } from '../contract/generation-context.js'
import { TEXT_CAPS } from '../contract/review-artifact.js'
import { toFileEntry } from '../git/diff-collector.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { makeTestContext, type TestContext } from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  gitFor42,
  HEAD_SHA,
  SYNTHETIC_FILES,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { type PrepareOptions, prepare } from './prepare.js'
import { DEFAULT_TEST_PATTERNS } from './test-paths.js'

let t: TestContext
afterEach(() => t?.cleanup())

function opts(force = false): PrepareOptions & { phases: string[] } {
  const phases: string[] = []
  return { force, log: p => phases.push(p), phases }
}

describe('prepare', () => {
  it('renders a project override with bundled format and project data', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    t.ctx.config.repoRoot = t.dataDir
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, prompts: { 'generation-strict.md': 'strict.md' } },
      warnings: [],
      source: null,
    }
    await writeFile(path.join(t.dataDir, 'strict.md'), 'Project instructions {{HEAD_SHA}}\n{{FORMAT}}')
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain(`Project instructions ${HEAD_SHA}`)
    expect(prompt).toContain('model.json')
    expect(prompt).not.toContain('{{')
  })

  it('fetches the PR, builds derived/, and writes prompt.md + context.json for a PR target', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const o = opts()
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, o)
    const canvasDir = t.ctx.canvases.canvasDir(HEAD_SHA)
    expect(result).toEqual({
      canvasDir,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      promptPath: path.join(canvasDir, 'prompt.md'),
      contextPath: path.join(canvasDir, 'context.json'),
      status: 'prepared',
    })
    expect(o.phases).toEqual(['fetch-pr', 'fetch-refs', 'collect-diffs', 'prompt'])
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    const derived = t.ctx.derived.derivedDir(HEAD_SHA)
    expect(context).toEqual({
      version: 1,
      target: { kind: 'pr', number: 42 },
      repo: { owner: 'acme', name: 'widgets' },
      pr: syntheticArtifact().pr,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      canvasDir,
      paths: {
        head: path.join(derived, 'head'),
        base: path.join(derived, 'base'),
        patches: path.join(derived, 'patches'),
        model: path.join(canvasDir, 'model.json'),
      },
      files: SYNTHETIC_FILES.map(toFileEntry),
      defaultLayers: DEFAULT_PROJECT_CONFIG.layers,
      rulebook: { path: null, text: null },
      highRisk: [],
      caps: TEXT_CAPS,
      limits: { maxPoints: 12, maxDiagramsPerLayer: 1, maxDiagramLinks: 12 },
      generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrChunks: 10 },
      tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
      smallPr: true,
      largePr: false,
      preparedAt: '2026-09-10T12:00:00.000Z',
    })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('# Review canvas for a pull request')
    expect(prompt).toContain('Produce a code-quality review')
    expect(prompt).toContain('### chunk src_app_ts#1')
    expect(prompt).toContain(`\`<model>\` = \`${path.join(canvasDir, 'model.json')}\``)
    expect(prompt).not.toContain('{{')
    // The PR is cached for the server, and derived/ is on disk for the browser.
    expect(await t.ctx.prs.readPr(42)).toEqual(syntheticArtifact().pr)
    expect(await t.ctx.derived.read(HEAD_SHA)).not.toBeNull()
  })

  it('reports exists when a canvas is already stored for the head, and rebuilds with --force', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const first = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const artifact = syntheticArtifact()
    await t.ctx.canvases.write(HEAD_SHA, artifact, {
      formatVersion: 1,
      tool: { name: 'pr-review', version: 'x' },
      repo: artifact.pr.repo,
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: artifact.generatedAt,
      generator: artifact.generator,
    })
    const again = opts()
    expect(await prepare(t.ctx, { kind: 'pr', number: 42 }, again)).toEqual({ ...first, status: 'exists' })
    expect(again.phases).toEqual(['fetch-pr', 'fetch-refs'])
    const { writeFile: write, mkdir } = await import('node:fs/promises')
    await write(path.join(first.canvasDir, 'model.json'), '{}')
    await write(path.join(first.canvasDir, 'events.ndjson'), '{}')
    await mkdir(path.join(first.canvasDir, 'scratch'))
    await write(path.join(first.canvasDir, 'scratch', 'notes.md'), 'x')
    await write(path.join(first.canvasDir, 'publish.log'), 'old run\n')
    const forced = opts(true)
    expect(await prepare(t.ctx, { kind: 'pr', number: 42 }, forced)).toEqual(first)
    expect(forced.phases).toEqual(['fetch-pr', 'fetch-refs', 'collect-diffs', 'prompt'])
    // A new context starts a fresh generation: everything an earlier run left goes, except the
    // rebuilt derived/ and the log, which records where the new attempt count starts.
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(first.canvasDir)).sort()).toEqual([
      'context.json',
      'derived',
      'manifest.json',
      'prompt.md',
      'publish.log',
      'review.json',
    ])
    const { readText } = await import('../store/atomic-json.js')
    expect(await readText(path.join(first.canvasDir, 'publish.log'))).toBe(
      `old run\n2026-09-10T12:00:00.000Z prepared ${HEAD_SHA}\n`
    )
    // The old canvas keeps serving until publish replaces it.
    expect(await t.ctx.canvases.exists(HEAD_SHA)).toBe(true)
    expect(await t.ctx.canvases.readArtifact(HEAD_SHA)).toEqual(artifact)
    expect(await t.ctx.derived.read(HEAD_SHA)).not.toBeNull()
  })

  it('describes a change set from two refs with fallbacks for the PR fields', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const o = opts()
    const result = await prepare(t.ctx, { kind: 'refs', base: 'main', head: 'feat/b' }, o)
    expect(result.status).toBe('prepared')
    expect(o.phases).toEqual(['fetch-refs', 'collect-diffs', 'prompt'])
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.target).toEqual({ kind: 'refs', base: 'main', head: 'feat/b' })
    expect(context.pr).toEqual({
      number: null,
      title: 'feat/b',
      body: '',
      author: 'octocat',
      url: 'https://github.com/acme/widgets/compare/main...feat/b',
      state: 'pre-pr',
      draft: false,
      updatedAt: '2026-09-10T12:00:00.000Z',
      baseRef: 'main',
      headRef: 'feat/b',
      headSha: HEAD_SHA,
      mergeBaseSha: BASE_SHA,
      // Counted from the diff itself: GitHub's numbers are not available before a PR exists.
      additions: 8,
      deletions: 5,
      changedFiles: 7,
      repo: { owner: 'acme', name: 'widgets' },
    })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('# Review canvas for a change set')
    expect(prompt).toContain('- Change set: no pull request yet — feat/b')
    expect(prompt).toContain('_No description._')
    expect(await t.ctx.prs.readPr(42)).toBeNull()
  })

  it('reads the rulebook and the caps from the project config', async () => {
    const dir = await import('../testing/fakes.js').then(m => m.makeTempDir())
    const { rm } = await import('node:fs/promises')
    await writeFile(path.join(dir, 'RULES.md'), '---\nname: x\n---\n# Rules\n\n## Be kind\n')
    t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42(),
      projectConfig: {
        config: {
          ...DEFAULT_PROJECT_CONFIG,
          rulebook: 'RULES.md',
          highRisk: [{ pattern: 'src/gone.ts', label: 'legacy' }],
          generation: {
            mode: 'surfacing',
            maxRepairRounds: 5,
            inlineDiffMaxLines: 10,
            smallPrChunks: 3,
            caps: { summary: 50 },
          },
        },
        warnings: [],
        source: path.join(dir, 'pr-review.config.yml'),
      },
    })
    t.ctx.config.repoRoot = dir
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.rulebook).toEqual({ path: 'RULES.md', text: '---\nname: x\n---\n# Rules\n\n## Be kind\n' })
    expect(context.caps).toEqual({ ...TEXT_CAPS, summary: 50 })
    expect(context.highRisk).toEqual([{ pattern: 'src/gone.ts', label: 'legacy' }])
    expect(context.generation).toEqual({
      mode: 'surfacing',
      maxRepairRounds: 5,
      inlineDiffMaxLines: 10,
      smallPrChunks: 3,
    })
    expect(context.smallPr).toBe(false)
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('- summary: 50 characters')
    expect(prompt).toContain('Build a visual walkthrough')
    expect(prompt).toContain('### Bundled standards')
    expect(prompt).toContain('### Rules\n\n#### Be kind')
    expect(prompt).toContain('above the 10-line inline limit')
    expect(prompt).toContain('- `src/gone.ts` → **legacy**')
    expect(prompt).toContain('at most\n5 times')
    await rm(dir, { recursive: true, force: true })
  })

  it('records a missing rulebook file as null text, keeping the path', async () => {
    t = await makeTestContext({
      git: gitFor42(),
      gh: ghFor42(),
      projectConfig: {
        config: { ...DEFAULT_PROJECT_CONFIG, rulebook: 'nope.md' },
        warnings: [],
        source: null,
      },
    })
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.rulebook).toEqual({ path: 'nope.md', text: null })
    expect(GH_PULL.number).toBe(42)
  })
})
