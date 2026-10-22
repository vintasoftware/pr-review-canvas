// @ts-check
import { describe, expect, it } from 'vitest'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import { pointSteps } from './point-steps.js'

/** @typedef {import('./contract-types.js').Point} Point */

const artifact = syntheticArtifact()
const [first, second] = artifact.layers
if (first === undefined || second === undefined) throw new Error('the synthetic canvas has two layers')
const template = /** @type {Point} */ (artifact.points[0])

/**
 * @param {string} id
 * @param {string | undefined} layerId
 * @param {Point['level']} level
 * @param {Point['impact']} [impact]
 * @returns {Point}
 */
function point(id, layerId, level, impact) {
  const { impact: _impact, layerId: _layerId, ...rest } = template
  return {
    ...rest,
    id,
    fingerprint: `fp-${id}`,
    level,
    ...(layerId === undefined ? {} : { layerId }),
    ...(impact === undefined ? {} : { impact }),
  }
}

/** @param {ReturnType<typeof pointSteps>} steps */
const ids = steps => steps.map(step => step.point.id)

describe('pointSteps', () => {
  it('walks the layers in the canvas’s order, whatever order the points come in', () => {
    const points = [point('b1', second.id, 'decide'), point('a1', first.id, 'fyi')]
    expect(ids(pointSteps(artifact, points))).toEqual(['a1', 'b1'])
  })

  it('puts a layer’s decide points first, then check, then fyi', () => {
    const points = [
      point('fyi', first.id, 'fyi'),
      point('check', first.id, 'check'),
      point('decide', first.id, 'decide'),
    ]
    expect(ids(pointSteps(artifact, points))).toEqual(['decide', 'check', 'fyi'])
  })

  it('orders decide points by impact, worst first, and those without one after', () => {
    const points = [
      point('none', first.id, 'decide'),
      point('low', first.id, 'decide', 'low'),
      point('critical', first.id, 'decide', 'critical'),
      point('high', first.id, 'decide', 'high'),
    ]
    expect(ids(pointSteps(artifact, points))).toEqual(['critical', 'high', 'low', 'none'])
  })

  it('keeps the canvas’s order between points of the same severity', () => {
    const points = [
      point('x', first.id, 'check'),
      point('y', first.id, 'check'),
      point('z', first.id, 'check'),
    ]
    expect(ids(pointSteps(artifact, points))).toEqual(['x', 'y', 'z'])
  })

  it('names each point’s layer, and puts points of no listed layer last, with none', () => {
    const steps = pointSteps(artifact, [point('lost', 'gone', 'decide'), point('a1', first.id, 'fyi')])
    expect(steps.map(step => [step.point.id, step.layer?.id ?? null])).toEqual([
      ['a1', first.id],
      ['lost', null],
    ])
  })
})
