// @vitest-environment node
import { DEFAULT_TEST_PATTERNS } from '../review/test-paths.js'
import { syntheticArtifact } from '../testing/synthetic.js'
import { ERROR_CODES } from './api.js'
import { CanvasIndexSchema, CanvasManifestSchema } from './canvas-manifest.js'
import { CommentsPayloadSchema, emptyComments } from './comments.js'
import { GenerationContextSchema, isLargePr, LARGE_PR } from './generation-context.js'
import { LIMITS, TEXT_CAPS } from './review-artifact.js'
import { appearanceForRequest } from './settings.js'
import { emptyState, PrStateSchema } from './state.js'

const SHA = 'a'.repeat(40)

describe('appearanceForRequest', () => {
  it('lets a known ?skin and ?theme win over the saved ones and ignores anything else', () => {
    const saved = { skin: 'github', theme: 'dark' } as const
    expect(appearanceForRequest(saved, { skin: 'terminal', theme: 'light' })).toEqual({
      skin: 'terminal',
      theme: 'light',
    })
    expect(appearanceForRequest(saved, {})).toEqual(saved)
    expect(appearanceForRequest(saved, { skin: 'neon', theme: 'sepia' })).toEqual(saved)
    // Either half can be picked on its own.
    expect(appearanceForRequest(saved, { theme: 'auto' })).toEqual({ skin: 'github', theme: 'auto' })
  })
})

describe('small contracts', () => {
  it('emptyState is a valid PrState', () => {
    const state = emptyState('2026-09-10T12:00:00.000Z')
    expect(PrStateSchema.parse(state)).toEqual({
      version: 1,
      rev: 0,
      reviewed: {},
      hiddenThreads: {},
      posted: [],
      dismissed: {},
      chat: { threads: [] },
      updatedAt: '2026-09-10T12:00:00.000Z',
    })
  })

  it('rejects the previous tool version state shape', () => {
    expect(PrStateSchema.safeParse({ version: 1, reviewed: {}, updatedAt: 'x' }).success).toBe(false)
  })

  it('emptyComments is a valid payload', () => {
    const payload = emptyComments(SHA, '2026-09-10T12:00:00.000Z')
    expect(CommentsPayloadSchema.parse(payload)).toEqual({
      fetchedAt: '2026-09-10T12:00:00.000Z',
      headSha: SHA,
      reviewComments: [],
      issueComments: [],
    })
  })

  it('validates a manifest and an index', () => {
    const manifest = {
      formatVersion: 1,
      tool: { name: 'pr-review', version: '0.1.0' },
      repo: { owner: 'acme', name: 'widgets' },
      prNumber: 42,
      headSha: SHA,
      mergeBaseSha: 'b'.repeat(40),
      baseRef: 'main',
      headRef: 'feat/b',
      generatedAt: '2026-09-10T12:00:00.000Z',
      generator: { agent: 'claude', harness: 'claude-code', attempts: 1 },
    }
    expect(CanvasManifestSchema.parse(manifest)).toEqual(manifest)
    expect(CanvasManifestSchema.safeParse({ ...manifest, headSha: 'short' }).success).toBe(false)
    const index = { canvases: { [SHA]: { prNumber: 42, generatedAt: 'x', source: 'local' } } }
    expect(CanvasIndexSchema.parse(index)).toEqual(index)
  })

  it('names the error codes once each', () => {
    expect(ERROR_CODES).toContain('PR_NOT_FOUND')
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length)
  })
})

describe('GenerationContextSchema', () => {
  it('fills the test patterns and isLargePr reads the two thresholds', () => {
    const artifact = syntheticArtifact()
    // A context.json written before `tests` existed still reads, with the built-in patterns.
    const context = GenerationContextSchema.parse({
      version: 1,
      target: { kind: 'pr', number: 42 },
      repo: artifact.pr.repo,
      pr: artifact.pr,
      headSha: artifact.pr.headSha,
      mergeBaseSha: artifact.pr.mergeBaseSha,
      canvasDir: '/tmp/canvas',
      paths: { head: 'h', base: 'b', patches: 'p', model: 'm' },
      files: artifact.files,
      defaultLayers: [],
      rulebook: { path: null, text: null },
      highRisk: [],
      caps: TEXT_CAPS,
      limits: LIMITS,
      generation: { maxRepairRounds: 3, inlineDiffMaxLines: 1500, smallPrChunks: 10 },
      smallPr: true,
      largePr: false,
      preparedAt: '2026-09-10T12:00:00.000Z',
    })
    expect(context.tests).toEqual({ patterns: [...DEFAULT_TEST_PATTERNS] })
    expect(context.generation.mode).toBe('strict')
    const { smallPrChunks, ...generation } = context.generation
    expect(
      GenerationContextSchema.parse({
        ...context,
        generation: { ...generation, smallPrHunks: smallPrChunks },
        files: context.files.map(({ chunks, ...file }) => ({ ...file, hunks: chunks })),
      })
    ).toEqual(context)
    expect(isLargePr({ files: LARGE_PR.files, additions: 1, deletions: 1 })).toBe(false)
    expect(isLargePr({ files: LARGE_PR.files + 1, additions: 0, deletions: 0 })).toBe(true)
    expect(isLargePr({ files: 1, additions: LARGE_PR.lines, deletions: 0 })).toBe(false)
    expect(isLargePr({ files: 1, additions: LARGE_PR.lines, deletions: 1 })).toBe(true)
  })
})
