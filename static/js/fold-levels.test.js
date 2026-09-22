// @ts-check
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  collapsesAt,
  coveredRows,
  foldLevelOf,
  foldsForLevel,
  hiddenLines,
  hidesAt,
  isFoldLevel,
  nextFoldLevel,
} from './fold-levels.js'

const HUNKS = [
  { id: 'a#1', oldLines: 4, newLines: 6 },
  { id: 'a#2', oldLines: 10, newLines: 8 },
  { id: 'b#1', oldLines: 3, newLines: 3 },
]

/** @param {Partial<import('./fold-levels.js').FoldedFile>} [over] */
function file(over = {}) {
  return { hunks: ['a#1', 'a#2'], annotations: [], ...over }
}

describe('hidesAt', () => {
  it('hides a level at itself and above, so the levels nest', () => {
    expect(hidesAt('light', 'light')).toBe(true)
    expect(hidesAt('light', 'aggressive')).toBe(true)
    expect(hidesAt('moderate', 'light')).toBe(false)
    expect(hidesAt('aggressive', 'moderate')).toBe(false)
  })
})

describe('foldLevelOf', () => {
  it('reads a canvas written before levels existed as light', () => {
    expect(foldLevelOf(true)).toBe('light')
    expect(foldLevelOf('aggressive')).toBe('aggressive')
    expect(foldLevelOf(false)).toBeNull()
    expect(foldLevelOf(undefined)).toBeNull()
  })
})

describe('nextFoldLevel', () => {
  it('steps through the levels and back to the first', () => {
    expect(nextFoldLevel('light')).toBe('moderate')
    expect(nextFoldLevel('moderate')).toBe('aggressive')
    expect(nextFoldLevel('aggressive')).toBe('light')
  })
})

describe('isFoldLevel', () => {
  it('accepts the three levels and nothing else', () => {
    expect(isFoldLevel('moderate')).toBe(true)
    expect(isFoldLevel('none')).toBe(false)
    expect(isFoldLevel(null)).toBe(false)
  })
})

describe('foldsForLevel', () => {
  const outer = {
    side: /** @type {const} */ ('new'),
    startLine: 1,
    endLine: 20,
    level: /** @type {const} */ ('moderate'),
  }
  const inner = {
    side: /** @type {const} */ ('new'),
    startLine: 4,
    endLine: 8,
    level: /** @type {const} */ ('light'),
  }
  const other = { side: /** @type {const} */ ('new'), startLine: 30, endLine: 33 }

  it('keeps a fold with no level at light', () => {
    expect(foldsForLevel([other], 'light')).toEqual([other])
  })

  it('drops the folds the level does not reach', () => {
    expect(foldsForLevel([outer, inner], 'light')).toEqual([inner])
  })

  it('keeps only the outermost fold once the level reaches it', () => {
    expect(foldsForLevel([outer, inner], 'aggressive')).toEqual([outer])
  })

  it('keeps folds that do not contain each other', () => {
    expect(foldsForLevel([inner, other], 'light')).toEqual([inner, other])
  })
})

describe('collapsesAt', () => {
  it('collapses a file from its own level upwards', () => {
    expect(collapsesAt(file({ collapsed: 'moderate' }), 'light')).toBe(false)
    expect(collapsesAt(file({ collapsed: 'moderate' }), 'aggressive')).toBe(true)
  })

  it('never collapses an annotated file, whatever level it names', () => {
    const annotated = { annotations: [{ side: /** @type {const} */ ('new'), startLine: 2, endLine: 2 }] }
    expect(collapsesAt(file({ collapsed: 'moderate', ...annotated }), 'aggressive')).toBe(false)
    expect(collapsesAt(file({ collapsed: 'aggressive', ...annotated }), 'aggressive')).toBe(false)
  })
})

describe('coveredRows', () => {
  const side = /** @type {const} */ ('new')

  it('counts each row once where ranges nest, touch, or sit on another side', () => {
    expect(coveredRows([])).toBe(0)
    expect(
      coveredRows([
        { side, startLine: 1, endLine: 10 },
        { side, startLine: 4, endLine: 6 },
        { side, startLine: 11, endLine: 12 },
        { side: 'old', startLine: 1, endLine: 3 },
      ])
    ).toBe(15)
  })
})

describe('hiddenLines', () => {
  it('counts the rows of the file own hunks, the longer side of each', () => {
    expect(hiddenLines(file(), HUNKS, 'light')).toEqual({ total: 16, hidden: 0 })
  })

  it('counts a collapsed file as wholly hidden', () => {
    expect(hiddenLines(file({ collapsed: true }), HUNKS, 'light')).toEqual({ total: 16, hidden: 16 })
  })

  it('counts the folds the level applies, and never more than the file shows', () => {
    const folds = [
      { side: /** @type {const} */ ('new'), startLine: 1, endLine: 4 },
      {
        side: /** @type {const} */ ('new'),
        startLine: 8,
        endLine: 10,
        level: /** @type {const} */ ('moderate'),
      },
    ]

    expect(hiddenLines(file({ folds }), HUNKS, 'light')).toEqual({ total: 16, hidden: 4 })
    expect(hiddenLines(file({ folds }), HUNKS, 'moderate')).toEqual({ total: 16, hidden: 7 })
  })
})
