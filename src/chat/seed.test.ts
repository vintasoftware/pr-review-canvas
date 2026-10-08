// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import { syntheticArtifact } from '../testing/synthetic.js'
import {
  layersMarkdown,
  loadSeedTemplate,
  pointsMarkdown,
  prMetaMarkdown,
  renderSeed,
  testsMarkdown,
} from './seed.js'

const artifact = syntheticArtifact()
const PATHS = {
  headDir: '/data/canvases/aaa/derived/head',
  baseDir: '/data/canvases/aaa/derived/base',
  patchDir: '/data/canvases/aaa/derived/patches',
  repoRoot: '/repo',
  code: { kind: 'reader-checkout', cwd: '/repo' },
} as const
const REVIEWER = { readerIsAuthor: false }

describe('renderSeed', () => {
  it('fills every token of the shipped template', async () => {
    const seed = renderSeed(await loadSeedTemplate(), artifact, PATHS, REVIEWER)
    expect(seed).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(seed).toContain('#42 **feat: add b** by octocat')
    expect(seed).toContain('- **Run path**')
    expect(seed).toContain('/data/canvases/aaa/derived/head')
    expect(seed).toContain('/repo')
  })

  it('states the length rule and the answer protocol the chat depends on', async () => {
    const seed = renderSeed(await loadSeedTemplate(), artifact, PATHS, REVIEWER)
    expect(seed).toContain('At most six sentences')
    expect(seed).toContain('No, and it should be.')
    expect(seed).toContain('```comment')
    expect(seed).toContain('```resolve')
    expect(seed).toContain('Do not invent problems')
  })

  it('tells the agent whether the reader wrote the pull request', async () => {
    const template = await loadSeedTemplate()
    expect(renderSeed(template, artifact, PATHS, REVIEWER)).toContain(
      'The reader reviews this pull request; someone else wrote it.'
    )
    expect(renderSeed(template, artifact, PATHS, { readerIsAuthor: true })).toContain(
      'The reader wrote this pull request. They answer attention points; they do not review them.'
    )
  })

  it('leaves a token the data does not name alone, so a template typo is visible', () => {
    expect(renderSeed('{{NOPE}}', artifact, PATHS, REVIEWER)).toBe('{{NOPE}}')
  })
})

describe('where the code is', () => {
  it('names the review checkout as the working directory, and the lockfile caveat', async () => {
    const seed = renderSeed(
      await loadSeedTemplate(),
      artifact,
      {
        ...PATHS,
        code: { kind: 'checkout', cwd: '/data/checkouts/42', sha: 'b'.repeat(40) },
      },
      REVIEWER
    )
    expect(seed).toContain('Your working directory, `/data/checkouts/42`, is a checkout of the')
    expect(seed).toContain('Git submodules are not checked out')
    expect(seed).toContain('`bbbbbbb`')
    expect(seed).toContain("reader's checkout at `/repo`")
    expect(seed).toContain('may not be what the pull request uses')
    expect(seed).not.toContain('/data/canvases/aaa/derived/head')
  })

  it('says the working tree is the work under review for uncommitted work', async () => {
    const seed = renderSeed(
      await loadSeedTemplate(),
      artifact,
      {
        ...PATHS,
        code: { kind: 'working-tree', cwd: '/repo' },
      },
      REVIEWER
    )
    expect(seed).toContain('uncommitted edits included')
  })

  it("warns that the reader's checkout may be on another branch without a review checkout", async () => {
    const seed = renderSeed(await loadSeedTemplate(), artifact, PATHS, REVIEWER)
    expect(seed).toContain('may be on')
    expect(seed).toContain('another branch')
  })
})

describe('the seed sections', () => {
  it('describes a change set that has no pull request number yet', () => {
    const pre: ReviewArtifact['pr'] = { ...artifact.pr, number: null }
    expect(prMetaMarkdown(pre)).toContain('(not opened yet)')
  })

  it('lists every layer with its files, and marks the mechanical one', () => {
    const text = layersMarkdown(artifact)
    expect(text).toContain('- **Run path**\n  - `src/app.ts`')
    expect(text).toContain('(mechanical)')
  })

  it('lists the attention points with their level, kind, audience, anchor, and the author’s answer', () => {
    const settled = { ...artifact, settled: { 'fp-1': { reason: 'The spec says sum.', at: 'now' } } }
    expect(pointsMarkdown(settled).split('\n')).toEqual([
      '- decide · decision · for the reviewer · Sum instead of product (`src/app.ts:4`) · point `fp-1` — settled by the author: The spec says sum.',
      '- check · tests · for the author · other() has no test (`src/app.ts:13`) · point `fp-2`',
      '- fyi · debt · for the author · Deleted file had no owner (`src/gone.ts:1`) · point `fp-3`',
    ])
  })

  it('lists the test map with its paths', () => {
    const text = testsMarkdown(artifact)
    expect(text).toContain('- covered · run() adds b() — `src/app.test.ts`')
    expect(text).toContain('- missing · other() returns x')
  })

  it('says "none" for a canvas with no layers, points, or tests', () => {
    const empty: ReviewArtifact = { ...artifact, layers: [], points: [] }
    expect(layersMarkdown(empty)).toBe('_none_')
    expect(pointsMarkdown(empty)).toBe('_none_')
    expect(testsMarkdown(empty)).toBe('_none_')
  })

  it('names a layer that has no files without an empty list under it', () => {
    const one = artifact.layers[0]
    if (one === undefined) {
      throw new Error('fixture changed')
    }
    expect(layersMarkdown({ ...artifact, layers: [{ ...one, files: [] }] })).toBe('- **Run path**')
  })
})
