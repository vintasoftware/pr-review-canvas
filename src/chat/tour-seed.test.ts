// @vitest-environment node
import { syntheticTour } from '../testing/synthetic-tour.js'
import type { SeedPaths } from './seed.js'
import {
  decisionsMarkdown,
  guideMarkdown,
  landmarksMarkdown,
  loadTourSeedTemplate,
  renderTourSeed,
} from './tour-seed.js'

const PATHS: SeedPaths = {
  headDir: '/d/head',
  baseDir: '/d/base',
  patchDir: '/d/patches',
  repoRoot: '/repo',
  code: { kind: 'checkout', cwd: '/checkouts/42', sha: 'a'.repeat(40) },
}

describe('renderTourSeed', () => {
  it('fills every token of the shipped template with the tour', async () => {
    const seed = renderTourSeed(await loadTourSeedTemplate(), syntheticTour(), PATHS)
    expect(seed).not.toContain('{{')
    expect(seed).toContain('#42 **feat: add b** by octocat')
    expect(seed).toContain(
      '- **run() now adds b()** (world): A caller of run() gets a() plus b(); the test expects 3. Guarded by `src/app.test.ts` (run() returns 3).'
    )
    expect(seed).toContain('- `sum-over-product` · trade-off · **Sum over product?** (`src/app.ts:4`)')
    expect(seed).toContain('  - recommended: keep; the reason to keep: Sum is what the spec says.')
    expect(seed).toContain('The project has no tour guide.')
    expect(seed).toContain('```restatement')
    expect(seed).toContain('```plan')
    expect(seed).toContain('/checkouts/42')
  })

  it('names the guide and the state landmark, and says when there are no decisions', () => {
    const tour = syntheticTour({ guide: 'docs/pr-tour.md', decisions: [] })
    const [first] = tour.landmarks
    if (first === undefined) throw new Error('synthetic tour')
    expect(guideMarkdown(tour)).toContain('`docs/pr-tour.md`')
    expect(decisionsMarkdown(tour)).toBe('_none_')
    expect(landmarksMarkdown({ ...tour, landmarks: [{ ...first, state: true }] })).toContain(
      '(background, state landmark)'
    )
    expect(renderTourSeed('{{NOPE}} {{GUIDE}}', tour, PATHS)).toBe('{{NOPE}} ' + guideMarkdown(tour))
  })
})
