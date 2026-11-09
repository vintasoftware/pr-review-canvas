// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { GenerationContextSchema } from '../contract/generation-context.js'
import { TEXT_CAPS } from '../contract/review-artifact.js'
import { toFileEntry } from '../git/diff-collector.js'
import { DEFAULT_PROJECT_CONFIG } from '../project-config.js'
import { ghJson, makeTestContext, type TestContext } from '../testing/fakes.js'
import {
  BASE_SHA,
  GH_PULL,
  ghFor42,
  gitFor42,
  HEAD_SHA,
  SYNTHETIC_DIFF,
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

  it("reads a pull request's settled decisions only when its author prepares the canvas", async () => {
    const commitWithDecision = {
      sha: HEAD_SHA,
      authorEmail: 'octocat@example.com',
      date: '2026-10-13T10:00:00-03:00',
      values: ['src/app.ts:2 keep the import'],
    }
    const prepareAs = async (login: string) => {
      const git = gitFor42()
      git.options.email = 'octocat@example.com'
      git.options.keyedLines = { [`${BASE_SHA}..${HEAD_SHA}`]: [commitWithDecision] }
      t = await makeTestContext({ git, gh: ghFor42({ routes: { user: ghJson({ login }) } }) })
      const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
      const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
      return { git, context }
    }
    const author = await prepareAs('octocat')
    expect(author.context.decisions.map(decision => [decision.text, decision.line])).toEqual([
      ['keep the import', 2],
    ])
    await t.cleanup()
    // Someone else's canvas of the same pull request asks git for no decision at all.
    const reviewer = await prepareAs('reviewer')
    expect(reviewer.context.decisions).toEqual([])
    expect(reviewer.git.calls.filter(call => call[0] === 'var' || call[1]?.startsWith('--keyed'))).toEqual([])
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
      models: { claude: 'opus' },
      sharing: 'shared',
      status: 'prepared',
    })
    expect(o.phases).toEqual(['fetch-pr', 'fetch-refs', 'collect-diffs', 'prompt'])
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    const derived = t.ctx.derived.derivedDir({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })
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
      generation: { mode: 'strict', maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrHunks: 10 },
      tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
      smallPr: true,
      largePr: false,
      decisions: [],
      preparedAt: '2026-09-10T12:00:00.000Z',
    })
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('# Review canvas for a pull request')
    expect(prompt).toContain('Produce a code-quality review')
    expect(prompt).toContain('### hunk src_app_ts#1')
    expect(prompt).toContain(`\`<model>\` = \`${path.join(canvasDir, 'model.json')}\``)
    expect(prompt).not.toContain('{{')
    // The PR is cached for the server, and derived/ is on disk for the browser.
    expect(await t.ctx.prs.readPr(42)).toEqual(syntheticArtifact().pr)
    expect(await t.ctx.derived.read({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })).not.toBeNull()
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
    expect(await t.ctx.derived.read({ headSha: HEAD_SHA, mergeBaseSha: BASE_SHA })).not.toBeNull()
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
    expect(prompt).toContain('- Ref comparison')
    expect(prompt).not.toContain('Author:')
    expect(prompt).not.toContain('state: pre-pr')
    expect(result.sharing).toBe('off')
    expect(prompt).toContain('_No description._')
    expect(await t.ctx.prs.readPr(42)).toBeNull()
  })

  it('reads the rulebook, the caps, and the models from the project config', async () => {
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
            smallPrHunks: 3,
            caps: { summary: 50 },
            models: { claude: 'opus', codex: 'gpt-6-sol' },
          },
        },
        warnings: [],
        source: path.join(dir, 'pr-review.config.yml'),
      },
    })
    t.ctx.config.repoRoot = dir
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    expect(result.models).toEqual({ claude: 'opus', codex: 'gpt-6-sol' })
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.rulebook).toEqual({ path: 'RULES.md', text: '---\nname: x\n---\n# Rules\n\n## Be kind\n' })
    expect(context.caps).toEqual({ ...TEXT_CAPS, summary: 50 })
    expect(context.highRisk).toEqual([{ pattern: 'src/gone.ts', label: 'legacy' }])
    expect(context.generation).toEqual({
      mode: 'surfacing',
      maxRepairRounds: 5,
      inlineDiffMaxLines: 10,
      smallPrHunks: 3,
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

describe('prepare with a basis canvas', () => {
  const OLD = 'e'.repeat(40)

  /** The clone as of PR 42, plus an earlier commit of the same branch that has a canvas. */
  function gitWithOld() {
    const git = gitFor42()
    Object.assign(git.options.refs ?? {}, { old: OLD })
    Object.assign(git.options.diffs ?? {}, { [`${BASE_SHA}..${OLD}`]: SYNTHETIC_DIFF })
    git.options.ancestors = { ...git.options.ancestors, [`${OLD}..${HEAD_SHA}`]: true }
    return git
  }

  async function withOldCanvas(incremental = true): Promise<TestContext> {
    t = await makeTestContext({ git: gitWithOld(), gh: ghFor42() })
    t.ctx.projectConfig = {
      config: { ...DEFAULT_PROJECT_CONFIG, canvas: { keepForIdenticalDiff: true, incremental } },
      warnings: [],
      source: null,
    }
    await t.ctx.canvases.write(
      OLD,
      syntheticArtifact(),
      {
        formatVersion: 1,
        tool: { name: 'pr-review', version: '0.5.0' },
        repo: syntheticArtifact().pr.repo,
        prNumber: 42,
        headSha: OLD,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: '2026-09-10T11:00:00.000Z',
        generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
      },
      42
    )
    return t
  }

  it('splits the basis canvas into the prompt and records it in the context', async () => {
    await withOldCanvas()
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.basis?.canvasSha).toBe(OLD)
    const basisModel = JSON.parse(await readFile(context.basis!.modelJsonPath!, 'utf8'))
    expect(basisModel.layers[0].files[0]).not.toHaveProperty('isTest')
    expect(basisModel.layers[0]).not.toHaveProperty('id')
    expect(basisModel.points.every((p: object) => !('fingerprint' in p) && !('origin' in p))).toBe(true)
    expect(context.basis?.points[0]?.headLines).toEqual({ side: 'new', line: 4, endLine: 4 })
    // The head's diff is the one the canvas was generated from, so everything carries.
    expect(context.basis?.files.changed).toEqual([])
    expect(context.basis?.layers.map(l => l.status)).toEqual(['carried', 'carried'])
    const prompt = await readFile(result.promptPath, 'utf8')
    expect(prompt).toContain('Update the review canvas')
    expect(prompt).toContain(OLD)
    expect(prompt).toContain('Carry these as they stand')
    expect(prompt).not.toContain('{{')
  })

  it.each(['artifact', 'manifest', 'diff'] as const)(
    'starts fresh when the basis %s is unavailable',
    async missing => {
      await withOldCanvas()
      if (missing === 'artifact') vi.spyOn(t.ctx.canvases, 'readArtifact').mockResolvedValue(null)
      if (missing === 'manifest') vi.spyOn(t.ctx.canvases, 'readManifest').mockResolvedValue(null)
      if (missing === 'diff') {
        const read = t.ctx.derived.readOrBuild.bind(t.ctx.derived)
        vi.spyOn(t.ctx.derived, 'readOrBuild').mockImplementation(diff =>
          diff.headSha === OLD ? Promise.resolve(null) : read(diff)
        )
      }
      const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
      const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
      expect(context.basis).toBeUndefined()
      expect(await readFile(result.promptPath, 'utf8')).not.toContain('Update the review canvas')
    }
  )

  it('starts from a blank page for --force and when the setting is off', async () => {
    await withOldCanvas()
    const forced = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts(true))
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(forced.contextPath, 'utf8')))
    expect(context.basis).toBeUndefined()
    expect(await readFile(forced.promptPath, 'utf8')).not.toContain('Update the review canvas')
    // A blank page still starts from the author's answers.
    expect(context.resolutions).toEqual({ canvasSha: OLD, points: [] })
    await t.cleanup()
    await withOldCanvas(false)
    const off = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const offContext = GenerationContextSchema.parse(JSON.parse(await readFile(off.contextPath, 'utf8')))
    expect(offContext.basis).toBeUndefined()
  })

  it('has no basis when the only other canvas is not a commit the head was built on', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    await t.ctx.canvases.write(
      OLD,
      syntheticArtifact(),
      {
        formatVersion: 1,
        tool: { name: 'pr-review', version: '0.5.0' },
        repo: syntheticArtifact().pr.repo,
        prNumber: 42,
        headSha: OLD,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: '2026-09-10T11:00:00.000Z',
        generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
      },
      42
    )
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.basis).toBeUndefined()
  })

  it('takes the resolutions of the pull request’s newest canvas, on a commit a rebase left behind too', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const settlement = { reason: 'Nothing imports it.', at: '2026-09-10T12:00:00.000Z' }
    const manifest = (headSha: string, generatedAt: string) => ({
      formatVersion: 1 as const,
      tool: { name: 'pr-review', version: '0.9.0' },
      repo: syntheticArtifact().pr.repo,
      prNumber: 42,
      headSha,
      mergeBaseSha: BASE_SHA,
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt,
      generator: { agent: 'claude' as const, harness: 'claude-code' as const, attempts: 1 },
    })
    const older = 'd'.repeat(40)
    // The older canvas still holds a resolution the author took back on the newer one.
    await t.ctx.canvases.write(
      older,
      {
        ...syntheticArtifact(),
        generatedAt: '2026-09-10T10:00:00.000Z',
        settled: { 'fp-1': settlement, 'fp-3': settlement },
      },
      manifest(older, '2026-09-10T10:00:00.000Z'),
      42
    )
    await t.ctx.canvases.write(
      OLD,
      { ...syntheticArtifact(), settled: { 'fp-3': settlement } },
      manifest(OLD, '2026-09-10T11:00:00.000Z'),
      42
    )
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.basis).toBeUndefined()
    expect(context.resolutions).toEqual({
      canvasSha: OLD,
      points: [
        {
          kind: 'debt',
          path: 'src/gone.ts',
          title: 'Deleted file had no owner',
          origin: 'model',
          reason: 'Nothing imports it.',
        },
      ],
    })
    expect(await readFile(result.promptPath, 'utf8')).toContain('### Points the author already resolved')
  })

  it('leaves a settled decision’s point out of the resolutions, since publish writes it again', async () => {
    t = await makeTestContext({ git: gitFor42(), gh: ghFor42() })
    const artifact = syntheticArtifact()
    const decisionPoint = {
      id: 'p-4',
      fingerprint: 'fp-4',
      kind: 'decision' as const,
      level: 'fyi' as const,
      title: 'keep the sum',
      path: 'src/app.ts',
      line: 4,
      side: 'new' as const,
      body: 'The author settled this in commit `abc1234` on 2026-10-13.',
      layerId: 'other',
      origin: 'model' as const,
      decisionCommit: 'a'.repeat(40),
      audience: 'author' as const,
    }
    await t.ctx.canvases.write(
      OLD,
      {
        ...artifact,
        points: [...artifact.points, decisionPoint],
        settled: { 'fp-4': { reason: 'the spec says sum', at: '2026-10-13T10:00:00.000Z' } },
      },
      {
        formatVersion: 1 as const,
        tool: { name: 'pr-review', version: '0.9.0' },
        repo: artifact.pr.repo,
        prNumber: 42,
        headSha: OLD,
        mergeBaseSha: BASE_SHA,
        baseRef: 'main',
        headRef: 'feat/b',
        generatedAt: '2026-09-10T11:00:00.000Z',
        generator: { agent: 'claude' as const, harness: 'claude-code' as const, attempts: 1 },
      },
      42
    )
    const result = await prepare(t.ctx, { kind: 'pr', number: 42 }, opts())
    const context = GenerationContextSchema.parse(JSON.parse(await readFile(result.contextPath, 'utf8')))
    expect(context.resolutions).toEqual({ canvasSha: OLD, points: [] })
  })
})
