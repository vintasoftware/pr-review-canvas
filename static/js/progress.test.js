// @ts-check
// @vitest-environment node
import { emptyState } from '../../src/contract/state.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { filesReviewed, layerProgress, progressSummary } from './progress.js'

describe('progress', () => {
  const artifact = syntheticArtifact()
  const layer = artifact.layers[0]
  if (!layer) {
    throw new Error('no layer')
  }

  it('reports none, partial, and done from layer and file marks', () => {
    const none = emptyState('x')
    expect(layerProgress(layer, none)).toBe('none')
    expect(filesReviewed(layer, none)).toBe(0)
    const partial = { ...none, reviewed: { 'layer:layer-1/file:src_app_ts': /** @type {const} */ (true) } }
    expect(layerProgress(layer, partial)).toBe('partial')
    expect(filesReviewed(layer, partial)).toBe(1)
    const allFiles = {
      ...none,
      reviewed: {
        'layer:layer-1/file:src_app_ts': /** @type {const} */ (true),
        'layer:layer-1/file:src_new_name_ts': /** @type {const} */ (true),
        'layer:layer-1/file:src_app_test_ts': /** @type {const} */ (true),
      },
    }
    expect(layerProgress(layer, allFiles)).toBe('done')
    const whole = { ...none, reviewed: { 'layer:layer-1': /** @type {const} */ (true) } }
    expect(layerProgress(layer, whole)).toBe('done')
  })

  it('counts only non-Other layers in the summary', () => {
    const none = emptyState('x')
    expect(progressSummary(artifact, none)).toEqual({ done: 0, total: 1, percent: 0 })
    const done = {
      ...none,
      reviewed: { 'layer:layer-1': /** @type {const} */ (true), 'layer:layer-2': /** @type {const} */ (true) },
    }
    expect(progressSummary(artifact, done)).toEqual({ done: 1, total: 1, percent: 100 })
    expect(progressSummary({ ...artifact, layers: artifact.layers.filter(l => l.kind === 'other') }, none)).toEqual({
      done: 0,
      total: 0,
      percent: 0,
    })
  })
})
