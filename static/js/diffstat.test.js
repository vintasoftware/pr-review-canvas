// @ts-check
// @vitest-environment happy-dom

import { toPatchMap } from '../../src/git/diff-collector.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { diffstatHtml, layerChanges, testChanges } from './diffstat.js'

const artifact = syntheticArtifact()
const files = artifact.files
const patches = toPatchMap(SYNTHETIC_FILES)
const layer = artifact.layers[0]
if (!layer) {
  throw new Error('fixture has no layer')
}

describe('layerChanges', () => {
  it('counts only the hunks of the layer, and whole files without patches', () => {
    const tests = { additions: 2, deletions: 1 }
    // The layer holds the first of the two hunks of src/app.ts; the second adds one line.
    expect(layerChanges(layer, files, patches)).toEqual({ total: { additions: 5, deletions: 3 }, tests })
    expect(layerChanges(layer, files, null)).toEqual({ total: { additions: 6, deletions: 3 }, tests })
    const noHunks = { ...layer, files: layer.files.map(lf => ({ ...lf, hunks: [] })) }
    const none = { additions: 0, deletions: 0 }
    expect(layerChanges(noHunks, files, patches)).toEqual({ total: none, tests: none })
  })
})

describe('testChanges', () => {
  it('sums the whole files the layers mark as tests', () => {
    expect(testChanges(artifact, files)).toEqual({ additions: 2, deletions: 1 })
  })
})

describe('diffstatHtml', () => {
  it('draws the split bar only when tests changed', () => {
    document.body.innerHTML = diffstatHtml({ additions: 7, deletions: 3 })
    expect(document.querySelector('.diffstat')?.className).toBe('diffstat')
    document.body.innerHTML = diffstatHtml({ additions: 7, deletions: 3 }, { additions: 0, deletions: 0 })
    expect(document.querySelector('.diffstat')?.className).toBe('diffstat')
    document.body.innerHTML = diffstatHtml({ additions: 7, deletions: 3 }, { additions: 2, deletions: 0 })
    const stat = document.querySelector('.diffstat')
    expect(stat?.className).toBe('diffstat split')
    expect(stat?.getAttribute('style')).toBe('--tests:20%')
    expect(stat?.getAttribute('title')).toBe('code +5 −3 · tests +2 −0')
    expect(stat?.textContent).toBe('+7 −3 (code +5 −3 · tests +2 −0)')
  })
})
