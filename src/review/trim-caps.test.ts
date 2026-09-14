// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyTitleTrims, trimTitle, visiblePrefix } from './trim-caps.js'

describe('trimTitle', () => {
  it('drops the explainer after the first separator', () => {
    expect(trimTitle('Storage layer: one active-SHL query, tracked uploads, file swap', 30)).toBe('Storage layer')
    expect(trimTitle('Cleanup job — claims, batching, and retry', 20)).toBe('Cleanup job')
    expect(trimTitle('Endpoints - update and create', 15)).toBe('Endpoints')
  })

  it('leaves a title that already fits, apart from stray whitespace and a trailing period', () => {
    expect(trimTitle('Cleanup job', 60)).toBeNull()
    expect(trimTitle('  Cleanup   job.  ', 60)).toBe('Cleanup job')
  })

  it('refuses to cut when no cut helps, so a name is never truncated mid-phrase', () => {
    // No separator to cut at.
    expect(trimTitle('a very long title with no separator at all', 10)).toBeNull()
    // The head is still over the cap.
    expect(trimTitle('a very long head indeed: and a tail', 10)).toBeNull()
    // Nothing before the separator.
    expect(trimTitle(': leading separator', 5)).toBeNull()
  })
})

describe('visiblePrefix', () => {
  it('returns the whole visible text when it already fits', () => {
    expect(visiblePrefix('short', 60)).toBe('short')
  })

  it('measures the text a reader sees, not the markdown', () => {
    expect(visiblePrefix('[label](#file:a/very/long/path.ts) tail', 5)).toBe('label')
  })

  it('ends on a word boundary when one is near the cut', () => {
    expect(visiblePrefix('one two three four five', 13)).toBe('one two three')
  })

  it('cuts mid-word when the last boundary is far behind the cap', () => {
    expect(visiblePrefix(`a ${'b'.repeat(60)}`, 30)).toBe(`a ${'b'.repeat(28)}`)
  })
})

describe('applyTitleTrims', () => {
  const caps = { layerTitle: 20, pointTitle: 15 }

  it('trims layer, point, and fold titles in place and reports each one', () => {
    const model = {
      layers: [
        {
          title: 'Storage layer: tracked uploads and the manifest swap',
          files: [{ folds: [{ title: 'publishes it: and queues the previous one' }] }],
        },
        { title: 'Cleanup job' },
      ],
      points: [{ title: 'A stale claim: taken over after 15 minutes' }],
    }
    expect(applyTitleTrims(model, caps)).toEqual([
      { where: 'layers.0.title', from: 'Storage layer: tracked uploads and the manifest swap', to: 'Storage layer' },
      {
        where: 'layers.0.files.0.folds.0.title',
        from: 'publishes it: and queues the previous one',
        to: 'publishes it',
      },
      { where: 'points.0.title', from: 'A stale claim: taken over after 15 minutes', to: 'A stale claim' },
    ])
    expect(model.layers[0]?.title).toBe('Storage layer')
    expect(model.layers[1]?.title).toBe('Cleanup job')
  })

  it('reports nothing for a model whose titles all fit', () => {
    expect(applyTitleTrims({ layers: [{ title: 'Cleanup job' }], points: [] }, caps)).toEqual([])
  })

  it('ignores a shape it does not recognize rather than throwing', () => {
    expect(applyTitleTrims({}, caps)).toEqual([])
    expect(applyTitleTrims({ layers: [{}], points: [{}] }, caps)).toEqual([])
  })
})
