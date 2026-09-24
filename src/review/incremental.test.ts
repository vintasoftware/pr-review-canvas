// @vitest-environment node
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../git/diff-collector.js'
import type { Derived } from '../store/derived-store.js'
import { createFakeGit } from '../testing/fakes.js'
import {
  HEAD_SHA,
  SYNTHETIC_DIFF,
  SYNTHETIC_DIFF_MOVED_BY_BASE,
  syntheticArtifact,
} from '../testing/synthetic.js'
import { fileDelta, findBasisCanvas, splitBasis } from './incremental.js'
import { matchLines, pointLinesInHead, type SideText } from './point-carry.js'
import type { CanvasStore } from '../store/canvas-store.js'
import type { CanvasIndex } from '../contract/canvas-manifest.js'

const OLD = 'e'.repeat(40)
const OLDER = 'd'.repeat(40)
const FORCE_PUSHED = 'f'.repeat(40)

function derivedOf(diff: string): Derived {
  const collected = parseUnifiedDiff(diff)
  return { files: collected.map(toFileEntry), patches: toPatchMap(collected) }
}

/** The diff with one file's changed line rewritten: that file changed, the rest did not. */
const TOUCHED_APP = SYNTHETIC_DIFF.replace('+  const y = 2', '+  const y = 3')

describe('fileDelta', () => {
  it('calls a file unchanged only when its whole patch is byte-identical', () => {
    const basis = derivedOf(SYNTHETIC_DIFF)
    expect(fileDelta(basis, derivedOf(SYNTHETIC_DIFF)).changed).toEqual([])
    const touched = fileDelta(basis, derivedOf(TOUCHED_APP))
    expect(touched.changed).toEqual(['src/app.ts'])
    expect(touched.unchanged).toContain('src/app.test.ts')
    expect(touched.added).toEqual([])
    expect(touched.removed).toEqual([])
  })

  it('reads a hunk the base moved as a change, since the canvas anchors on line numbers', () => {
    const moved = fileDelta(derivedOf(SYNTHETIC_DIFF), derivedOf(SYNTHETIC_DIFF_MOVED_BY_BASE))
    expect(moved.changed.length).toBeGreaterThan(0)
    expect(moved.unchanged).not.toContain('src/app.ts')
  })

  it('names the files each side has alone', () => {
    const basis = derivedOf(SYNTHETIC_DIFF)
    const head: Derived = {
      files: basis.files.filter(f => f.path !== 'src/gone.ts'),
      patches: Object.fromEntries(Object.entries(basis.patches).filter(([key]) => key !== 'src_gone_ts')),
    }
    const extra = basis.files.find(f => f.path === 'src/new.ts')
    expect(extra).toBeDefined()
    head.files.push({ ...(extra as (typeof basis.files)[number]), path: 'src/later.ts', key: 'src_later_ts' })
    head.patches['src_later_ts'] = 'whatever this file changed'
    const delta = fileDelta(basis, head)
    expect(delta.removed).toEqual(['src/gone.ts'])
    expect(delta.added).toEqual(['src/later.ts'])
  })

  it('matches the two sides by path, so two paths that sanitize alike are not confused', () => {
    // `a-b.ts` and `a_b.ts` share a sanitized key; uniqueKey separates them by their order in
    // whichever diff holds both, so the plain key names a different file on each side.
    const patch = 'whatever this file changed'
    const entry = derivedOf(SYNTHETIC_DIFF).files[0]
    if (entry === undefined) {
      throw new Error('no file')
    }
    const basis: Derived = {
      files: [{ ...entry, path: 'src/a-b.ts', key: 'src_a_b_ts' }],
      patches: { src_a_b_ts: patch },
    }
    const head: Derived = {
      files: [
        { ...entry, path: 'src/a_b.ts', key: 'src_a_b_ts' },
        { ...entry, path: 'src/a-b.ts', key: 'src_a_b_ts_2' },
      ],
      patches: { src_a_b_ts: patch, src_a_b_ts_2: patch },
    }
    const delta = fileDelta(basis, head)
    // The file the basis canvas describes is the one that kept its patch, whatever its key is now.
    expect(delta.unchanged).toEqual(['src/a-b.ts'])
    expect(delta.added).toEqual(['src/a_b.ts'])
    expect(delta.removed).toEqual([])
  })
})

describe('splitBasis', () => {
  it('carries a layer whole only when the head touches none of its files', () => {
    const delta = fileDelta(derivedOf(SYNTHETIC_DIFF), derivedOf(TOUCHED_APP))
    const split = splitBasis(syntheticArtifact(), delta)
    // Both layers of the fixture hold a hunk of src/app.ts, so both are re-judged.
    expect(split.layers.map(l => [l.key, l.status])).toEqual([
      ['run-path', 're-judged'],
      ['other', 're-judged'],
    ])
    const runPath = split.layers[0]
    expect(runPath?.reJudgedFiles).toEqual(['src/app.ts'])
    // The untouched files of a re-judged layer still keep their note, folds, and annotations.
    expect(runPath?.carriedFiles).toEqual(['src/new-name.ts', 'src/app.test.ts'])
  })

  it('carries every layer and point when the head changed nothing in the diff', () => {
    const same = derivedOf(SYNTHETIC_DIFF)
    const split = splitBasis(syntheticArtifact(), fileDelta(same, same))
    expect(split.layers.every(l => l.status === 'carried')).toBe(true)
    expect(split.points.every(p => p.status === 'carried')).toBe(true)
  })

  it('re-judges a point whose file the head touched, and carries the rest with their titles', () => {
    const delta = fileDelta(derivedOf(SYNTHETIC_DIFF), derivedOf(TOUCHED_APP))
    const split = splitBasis(syntheticArtifact(), delta)
    const onApp = split.points.filter(p => p.path === 'src/app.ts')
    expect(onApp.length).toBeGreaterThan(0)
    expect(onApp.every(p => p.status === 're-judged')).toBe(true)
    const elsewhere = split.points.filter(p => p.path !== 'src/app.ts')
    expect(elsewhere.every(p => p.status === 'carried')).toBe(true)
    // The title travels, so a carried point keeps its fingerprint and any dismissal with it.
    expect(split.points.map(p => p.title)).toEqual(syntheticArtifact().points.map(p => p.title))
  })
})

describe('splitBasis with line-level carry', () => {
  it('carries a point of a changed file at the lines it is given, and keeps its title', () => {
    const artifact = syntheticArtifact()
    const onApp = artifact.points.find(p => p.path === 'src/app.ts')
    if (onApp === undefined) {
      throw new Error('fixture changed')
    }
    const delta = fileDelta(derivedOf(SYNTHETIC_DIFF), derivedOf(TOUCHED_APP))
    const headLines = { side: 'new', line: 9, endLine: 9 } as const
    const split = splitBasis(artifact, delta, new Map([[onApp, headLines]]))
    expect(split.points.find(p => p.title === onApp.title)).toEqual({
      kind: onApp.kind,
      path: 'src/app.ts',
      title: onApp.title,
      status: 'carried',
      headLines,
    })
    // The layers still follow the file rule: the file changed, so its layer is re-judged.
    expect(split.layers[0]?.status).toBe('re-judged')
  })

  it('leaves the file rule alone for an untouched file: carried, with no new lines', () => {
    const same = derivedOf(SYNTHETIC_DIFF)
    const artifact = syntheticArtifact()
    const first = artifact.points[0]
    if (first === undefined) {
      throw new Error('fixture changed')
    }
    const split = splitBasis(
      artifact,
      fileDelta(same, same),
      new Map([[first, { side: 'new', line: 1, endLine: 1 }]])
    )
    expect(split.points.every(p => p.status === 'carried' && p.headLines === undefined)).toBe(true)
  })
})

// The merge base holds a..h. The basis canvas's commit rewrites f; later heads edit around it.
const BASE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
const BASIS: SideText = {
  lines: ['a', 'b', 'c', 'd', 'e', 'F!', 'g', 'h'],
  patch: ['@@ -5,3 +5,3 @@', ' e', '-f', '+F!', ' g'].join('\n'),
}
/** A line added at the top: everything below moves down by one. */
const SHIFTED: SideText = {
  lines: ['z', ...BASIS.lines],
  patch: ['@@ -1 +1,2 @@', '+z', ' a', '@@ -5,3 +6,3 @@', ' e', '-f', '+F!', ' g'].join('\n'),
}
const old = (text: SideText): SideText => ({ lines: BASE, patch: text.patch })

describe('pointLinesInHead', () => {
  it('carries a point whose lines an edit above shifted, at its new lines', () => {
    expect(pointLinesInHead({ side: 'new', line: 6 }, BASIS, SHIFTED)).toEqual({
      side: 'new',
      line: 7,
      endLine: 7,
    })
    // A range over a context line and a changed line moves as one block.
    expect(pointLinesInHead({ side: 'new', line: 5, endLine: 6 }, BASIS, SHIFTED)).toEqual({
      side: 'new',
      line: 6,
      endLine: 7,
    })
  })

  it('re-judges a point when one of its anchored lines was edited', () => {
    const edited: SideText = {
      lines: ['a', 'b', 'c', 'd', 'e', 'F?', 'g', 'h'],
      patch: ['@@ -5,3 +5,3 @@', ' e', '-f', '+F?', ' g'].join('\n'),
    }
    expect(pointLinesInHead({ side: 'new', line: 6 }, BASIS, edited)).toBeNull()
  })

  it('re-judges a point when its anchored lines were deleted', () => {
    const deleted: SideText = {
      lines: ['A', 'b', 'c', 'd', 'e', 'g', 'h'],
      patch: ['@@ -1,2 +1,2 @@', '-a', '+A', ' b', '@@ -5,3 +5,2 @@', ' e', '-f', ' g'].join('\n'),
    }
    expect(pointLinesInHead({ side: 'new', line: 6 }, BASIS, deleted)).toBeNull()
  })

  it('re-judges a range that a new line now splits, since it no longer moved as one block', () => {
    const split: SideText = {
      lines: ['a', 'b', 'c', 'd', 'e', 'new', 'F!', 'g', 'h'],
      patch: ['@@ -5,3 +5,4 @@', ' e', '-f', '+new', '+F!', ' g'].join('\n'),
    }
    expect(pointLinesInHead({ side: 'new', line: 5, endLine: 7 }, BASIS, split)).toBeNull()
  })

  it('re-judges a point whose line is the same text but no longer a change in the diff', () => {
    // The head keeps F! but the base now has it too: the row became context.
    const merged: SideText = {
      lines: ['z', ...BASIS.lines],
      patch: ['@@ -1 +1,2 @@', '+z', ' a'].join('\n'),
    }
    expect(pointLinesInHead({ side: 'new', line: 6 }, BASIS, merged)).toBeNull()
  })

  it('carries an old-side point on a deleted line while it is still deleted', () => {
    expect(pointLinesInHead({ side: 'old', line: 6 }, old(BASIS), old(SHIFTED))).toEqual({
      side: 'old',
      line: 6,
      endLine: 6,
    })
    // The head puts f back, so the old line is context now, not the deletion the point was about.
    const restored: SideText = {
      lines: BASE,
      patch: ['@@ -5,3 +5,4 @@', ' e', ' f', '+F!', ' g'].join('\n'),
    }
    expect(pointLinesInHead({ side: 'old', line: 6 }, old(BASIS), restored)).toBeNull()
  })
})

describe('matchLines', () => {
  it('matches the lines a shortest edit keeps, and only those', () => {
    const matches = matchLines(['a', 'b', 'x', 'c', 'd'], ['a', 'y', 'b', 'c', 'q', 'd'])
    expect([...(matches ?? new Map()).entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, 1],
      [2, 3],
      [4, 4],
      [5, 6],
    ])
    expect(matchLines([], [])).toEqual(new Map())
    expect(matchLines(['a'], [])).toEqual(new Map())
  })

  it('keeps as many lines as a longest common subsequence, in order, on equal text', () => {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed
    }
    const text = (): string[] => Array.from({ length: next() % 30 }, () => 'abcd'.charAt(next() % 4))
    const lcs = (a: string[], b: string[]): number => {
      const row = Array.from({ length: b.length + 1 }, () => 0)
      for (const x of a) {
        let diagonal = 0
        for (let j = 1; j <= b.length; j += 1) {
          const above = row[j] ?? 0
          row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1] ?? 0)
          diagonal = above
        }
      }
      return row[b.length] ?? 0
    }
    for (let round = 0; round < 200; round += 1) {
      const [a, b] = [text(), text()]
      const pairs = [...(matchLines(a, b) ?? new Map<number, number>()).entries()].sort(([x], [y]) => x - y)
      expect(pairs).toHaveLength(lcs(a, b))
      pairs.forEach(([x, y], i) => {
        expect(a[x - 1]).toBe(b[y - 1])
        expect(i === 0 || y > (pairs[i - 1]?.[1] ?? 0)).toBe(true)
      })
    }
  })
})

describe('findBasisCanvas', () => {
  const index = (canvases: CanvasIndex['canvases']): CanvasStore =>
    ({ readIndex: async () => ({ canvases }) }) as unknown as CanvasStore

  const git = createFakeGit({
    ancestors: { [`${OLD}..${HEAD_SHA}`]: true, [`${OLDER}..${HEAD_SHA}`]: true },
  })

  it('takes the newest canvas of a commit the head was built on', async () => {
    const store = index({
      [OLDER]: { prNumber: 42, generatedAt: '2026-09-01T00:00:00Z', source: 'local' },
      [OLD]: { prNumber: 42, generatedAt: '2026-09-09T00:00:00Z', source: 'local' },
    })
    expect(await findBasisCanvas(store, git, 42, HEAD_SHA)).toBe(OLD)
  })

  it('never takes a canvas of a line the head no longer contains, however recent', async () => {
    const store = index({
      [OLDER]: { prNumber: 42, generatedAt: '2026-09-01T00:00:00Z', source: 'local' },
      [FORCE_PUSHED]: { prNumber: 42, generatedAt: '2026-09-17T00:00:00Z', source: 'local' },
    })
    expect(await findBasisCanvas(store, git, 42, HEAD_SHA)).toBe(OLDER)
  })

  it('leaves out the head itself, and canvases stamped with another pull request', async () => {
    expect(
      await findBasisCanvas(
        index({ [HEAD_SHA]: { prNumber: 42, generatedAt: '2026-09-09T00:00:00Z', source: 'local' } }),
        git,
        42,
        HEAD_SHA
      )
    ).toBeNull()
    expect(
      await findBasisCanvas(
        index({ [OLD]: { prNumber: 7, generatedAt: '2026-09-09T00:00:00Z', source: 'local' } }),
        git,
        42,
        HEAD_SHA
      )
    ).toBeNull()
  })

  it('takes a canvas made before the pull request existed, for a PR run and a refs run alike', async () => {
    const store = index({ [OLD]: { generatedAt: '2026-09-09T00:00:00Z', source: 'local' } })
    expect(await findBasisCanvas(store, git, 42, HEAD_SHA)).toBe(OLD)
    expect(await findBasisCanvas(store, git, undefined, HEAD_SHA)).toBe(OLD)
  })

  it('has no basis when the store is empty', async () => {
    expect(await findBasisCanvas(index({}), git, 42, HEAD_SHA)).toBeNull()
  })
})
