// @vitest-environment node
import { copyFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TEXT_CAPS } from './contract/review-artifact.js'
import {
  DEFAULT_LAYERS,
  DEFAULT_PROJECT_CONFIG,
  loadProjectConfig,
  mergeProjectConfig,
  ProjectConfigSchema,
} from './project-config.js'
import { DEFAULT_TEST_PATTERNS } from './review/test-paths.js'
import { PACKAGE_ROOT } from './server/context.js'
import { makeTempDir } from './testing/fakes.js'

describe('mergeProjectConfig', () => {
  it('fills every missing key from the defaults', () => {
    expect(mergeProjectConfig({})).toEqual({ config: DEFAULT_PROJECT_CONFIG, warnings: [] })
    expect(DEFAULT_LAYERS.map(l => l.id)).toEqual([
      'contracts',
      'data-access',
      'mappers',
      'hooks-state',
      'views',
      'routes-wiring',
      'policy-config',
      'mechanical',
    ])
  })

  it('takes user values and keeps caps overrides', () => {
    const { config, warnings } = mergeProjectConfig({
      rulebook: 'docs/REVIEW.md',
      layers: [{ id: 'one', title: 'One', description: 'd', paths: ['a/**'] }],
      highRisk: [{ pattern: '**/x', label: 'x' }],
      generation: { maxRepairRounds: 5, caps: { rationale: 500 } },
      chat: { enabled: false },
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
        caps: { rationale: 500 },
      },
      tests: { patterns: [...DEFAULT_TEST_PATTERNS] },
      chat: { enabled: false },
    })
    expect(ProjectConfigSchema.parse(config)).toEqual(config)
    const allCaps = Object.fromEntries(Object.keys(TEXT_CAPS).map(k => [k, 1]))
    expect(mergeProjectConfig({ generation: { caps: allCaps } }).config.generation.caps).toEqual(allCaps)
    expect(mergeProjectConfig({ generation: { caps: { unknown: 1 } } }).config.generation.caps).toEqual({})
    const noTests = mergeProjectConfig({ tests: { patterns: [] } })
    expect(noTests.config.tests).toEqual({ patterns: [] })
    expect(noTests.warnings).toEqual(['pr-review.config.yml: "tests.patterns" is empty, so no file counts as a test'])
    expect(mergeProjectConfig({ tests: { patterns: ['**/test_*.py'] } }).config.tests).toEqual({
      patterns: ['**/test_*.py'],
    })
    expect(mergeProjectConfig({ generation: {}, chat: {} }).config.generation).toEqual({
      mode: 'strict',
      maxRepairRounds: 3,
      inlineDiffMaxLines: 1500,
      smallPrHunks: 10,
    })
    expect(mergeProjectConfig({ generation: { smallPrHunks: 25 } }).config.generation.smallPrHunks).toBe(25)
  })

  it.each(['strict', 'surfacing'] as const)('accepts the %s generation mode', mode => {
    expect(mergeProjectConfig({ generation: { mode } })).toEqual({
      config: { ...DEFAULT_PROJECT_CONFIG, generation: { ...DEFAULT_PROJECT_CONFIG.generation, mode } },
      warnings: [],
    })
  })

  it('warns and uses defaults for an unknown generation mode', () => {
    const result = mergeProjectConfig({ generation: { mode: 'relaxed' } })
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(result.warnings).toEqual([expect.stringContaining('generation.mode')])
  })

  it('falls back to defaults with a warning when the shape is wrong', () => {
    const { config, warnings } = mergeProjectConfig({ layers: 'nope', generation: { maxRepairRounds: -1 } })
    expect(config).toEqual(DEFAULT_PROJECT_CONFIG)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^pr-review\.config\.yml is invalid, using defaults: layers: /)
    expect(warnings[0]).toMatch(/generation\.maxRepairRounds/)
  })

  it('warns about empty layers and duplicate ids', () => {
    expect(mergeProjectConfig({ layers: [] }).warnings).toEqual([
      'pr-review.config.yml: "layers" is empty, the model gets no default taxonomy',
    ])
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
    expect(await loadProjectConfig(dir)).toEqual({ config: DEFAULT_PROJECT_CONFIG, warnings: [], source: null })
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
    await copyFile(path.join(PACKAGE_ROOT, 'pr-review.config.example.yml'), path.join(dir, 'pr-review.config.yml'))
    const loaded = await loadProjectConfig(dir)
    expect(loaded.warnings).toEqual([])
    expect(loaded.config.generation).toEqual(DEFAULT_PROJECT_CONFIG.generation)
    expect(loaded.config.layers.map(layer => layer.id)).toEqual(DEFAULT_LAYERS.map(layer => layer.id))
    expect(loaded.config.highRisk).toEqual([
      { pattern: '**/migrations/**', label: 'schema' },
      { pattern: '**/*auth*', label: 'auth' },
    ])
  })
})
