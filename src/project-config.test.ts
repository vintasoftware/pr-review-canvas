// @vitest-environment node
import { copyFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TEXT_CAPS } from './contract/review-artifact.js'
import {
  DEFAULT_PROJECT_CONFIG,
  loadProjectConfig,
  mergeProjectConfig,
  ProjectConfigSchema,
} from './project-config.js'
import { DEFAULT_TEST_PATTERNS } from './review/test-paths.js'
import { PACKAGE_ROOT } from './server/context.js'
import { makeTempDir } from './testing/fakes.js'

describe('mergeProjectConfig', () => {
  it('keeps prompt overrides and rejects misspelled template names or empty paths', () => {
    const prompts = { 'generation-format.md': 'docs/prompts/format.md', 'chat-seed.md': '/shared/chat.md' }
    expect(mergeProjectConfig({ prompts }).config.prompts).toEqual(prompts)
    expect(mergeProjectConfig({ prompts: { 'typo.md': 'x' } }).warnings[0]).toContain('invalid')
    expect(mergeProjectConfig({ prompts: { 'chat-seed.md': '' } }).warnings[0]).toContain('invalid')
  })

  it('fills every missing key from the defaults', () => {
    expect(mergeProjectConfig({})).toEqual({ config: DEFAULT_PROJECT_CONFIG, warnings: [] })
    expect(mergeProjectConfig({}).config.layers).toEqual([])
  })

  it('takes user values and keeps caps overrides', () => {
    const { config, warnings } = mergeProjectConfig({
      rulebook: 'docs/REVIEW.md',
      layers: [{ id: 'one', title: 'One', description: 'd', paths: ['a/**'] }],
      highRisk: [{ pattern: '**/x', label: 'x' }],
      generation: { maxRepairRounds: 5, caps: { rationale: 500 }, models: { claude: 'opus' } },
      chat: { enabled: false },
      selfReview: { maxCards: 6 },
    })
    expect(warnings).toEqual([])
    expect(config).toEqual({
      version: 1,
      rulebook: 'docs/REVIEW.md',
      layers: [{ id: 'one', title: 'One', description: 'd', paths: ['a/**'] }],
      highRisk: [{ pattern: '**/x', label: 'x' }],
      generation: {
        mode: 'strict',
        maxRepairRounds: 5,
        inlineDiffMaxLines: 1500,
        smallPrHunks: 10,
        models: { claude: 'opus' },
        caps: { rationale: 500 },
      },
      tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
      chat: { enabled: false },
      canvas: { keepForIdenticalDiff: true, incremental: true },
      selfReview: { maxCards: 6, linesPerCard: 100 },
    })
    expect(ProjectConfigSchema.parse(config)).toEqual(config)
    const allCaps = Object.fromEntries(Object.keys(TEXT_CAPS).map(k => [k, 1]))
    expect(mergeProjectConfig({ generation: { caps: allCaps } }).config.generation.caps).toEqual(allCaps)
    expect(mergeProjectConfig({ generation: { caps: { unknown: 1 } } }).config.generation.caps).toEqual({})
    const noTests = mergeProjectConfig({ tests: { patterns: [] } })
    expect(noTests.config.tests).toEqual({ patterns: [] })
    expect(noTests.warnings).toEqual([
      'pr-review.config.yml: "tests.patterns" is empty, so no file counts as a test',
    ])
    expect(mergeProjectConfig({ tests: { patterns: ['**/test_*.py'] } }).config.tests).toEqual({
      patterns: ['**/test_*.py'],
    })
    expect(mergeProjectConfig({ generation: {}, chat: {} }).config.generation).toEqual({
      mode: 'strict',
      maxRepairRounds: 3,
      inlineDiffMaxLines: 1500,
      smallPrHunks: 10,
      models: {},
    })
    expect(mergeProjectConfig({ generation: { models: { claude: '' } } }).warnings[0]).toContain('invalid')
    expect(mergeProjectConfig({ generation: { smallPrHunks: 25 } }).config.generation.smallPrHunks).toBe(25)
  })

  it.each(['strict', 'surfacing'] as const)('accepts the %s generation mode', mode => {
    expect(mergeProjectConfig({ generation: { mode } })).toEqual({
      config: { ...DEFAULT_PROJECT_CONFIG, generation: { ...DEFAULT_PROJECT_CONFIG.generation, mode } },
      warnings: [],
    })
  })

  it('reads the canvas settings and defaults both to on', () => {
    const on = { keepForIdenticalDiff: true, incremental: true }
    expect(mergeProjectConfig({}).config.canvas).toEqual(on)
    expect(mergeProjectConfig({ canvas: {} }).config.canvas).toEqual(on)
    expect(mergeProjectConfig({ canvas: { keepForIdenticalDiff: false } }).config.canvas).toEqual({
      keepForIdenticalDiff: false,
      incremental: true,
    })
    expect(mergeProjectConfig({ canvas: { incremental: false } }).config.canvas).toEqual({
      keepForIdenticalDiff: true,
      incremental: false,
    })
    expect(mergeProjectConfig({ canvas: { keepForIdenticalDiff: 'no' } }).warnings[0]).toContain(
      'canvas.keepForIdenticalDiff'
    )
  })

  it('warns and uses defaults for an unknown generation mode', () => {
    const result = mergeProjectConfig({ generation: { mode: 'relaxed' } })
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(result.warnings).toEqual([expect.stringContaining('generation.mode')])
  })

  it.each([null, [], 'layers: []'])('warns and uses defaults for a non-object config: %j', raw => {
    const result = mergeProjectConfig(raw)
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(result.warnings).toEqual([
      expect.stringMatching(/^pr-review\.config\.yml is invalid, using defaults: \(root\): /),
    ])
  })

  it('falls back to defaults with a warning when the shape is wrong', () => {
    const { config, warnings } = mergeProjectConfig({ layers: 'nope', generation: { maxRepairRounds: -1 } })
    expect(config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^pr-review\.config\.yml is invalid, using defaults: layers: /)
    expect(warnings[0]).toMatch(/generation\.maxRepairRounds/)
  })

  it('accepts empty layers and warns about duplicate ids', () => {
    expect(mergeProjectConfig({ layers: [] })).toEqual({ config: DEFAULT_PROJECT_CONFIG, warnings: [] })
    const dup = { id: 'a', title: 'A', description: '' }
    expect(mergeProjectConfig({ layers: [dup, dup] }).warnings).toEqual([
      'pr-review.config.yml: duplicate layer id "a"',
    ])
  })
})

describe('loadProjectConfig', () => {
  let dir: string
  beforeEach(async () => {
    dir = await makeTempDir()
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('returns defaults when the file is absent', async () => {
    expect(await loadProjectConfig(dir)).toEqual({
      config: DEFAULT_PROJECT_CONFIG,
      warnings: [],
      source: null,
    })
  })

  it('reads YAML and reports the source file', async () => {
    await writeFile(path.join(dir, 'pr-review.config.yml'), 'version: 1\nchat:\n  enabled: false\n')
    const loaded = await loadProjectConfig(dir)
    expect(loaded.source).toBe(path.join(dir, 'pr-review.config.yml'))
    expect(loaded.config.chat).toEqual({ enabled: false })
    expect(loaded.warnings).toEqual([])
  })

  it('treats an empty file as defaults and invalid YAML as a warning', async () => {
    await writeFile(path.join(dir, 'pr-review.config.yml'), '')
    expect((await loadProjectConfig(dir)).config).toEqual(DEFAULT_PROJECT_CONFIG)
    await writeFile(path.join(dir, 'pr-review.config.yml'), 'layers: [\n')
    const bad = await loadProjectConfig(dir)
    expect(bad.config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(bad.warnings[0]).toMatch(/^pr-review\.config\.yml is not valid YAML, using defaults: /)
  })

  it('loads the shipped example without warnings', async () => {
    await copyFile(
      path.join(PACKAGE_ROOT, 'pr-review.config.example.yml'),
      path.join(dir, 'pr-review.config.yml')
    )
    const loaded = await loadProjectConfig(dir)
    expect(loaded.warnings).toEqual([])
    expect(loaded.config.generation).toEqual(DEFAULT_PROJECT_CONFIG.generation)
    expect(loaded.config.layers).toEqual([])
    expect(loaded.config.highRisk).toEqual([
      { pattern: '**/migrations/**', label: 'schema' },
      { pattern: '**/*auth*', label: 'auth' },
    ])
  })
})
