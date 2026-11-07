// @ts-check
// The stops of the one-point-at-a-time view, in reading order: layer by layer, as the canvas tells
// the change, each layer with points or tests opening with a stop of its own, then its points in
// the canvas's order, which lists the most severe first (`sortPoints` in `src/review/normalize.ts`).
// A stop is named by the fragment of what it shows, so a link to it works in every view.
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {ReviewArtifact['layers'][number]} Layer */
import { layerAnchorId, pointAnchorId } from './keys.js'

/**
 * A layer's opening, with how many points follow it, or a point, with its number among all of them.
 * @typedef {{ kind: 'layer', id: string, layer: Layer, points: number }
 *   | { kind: 'point', id: string, layer: Layer, point: Point, number: number }} Stop
 */

/**
 * Every point sits in a listed layer: validation keeps a point inside a chunk, and every chunk is in
 * a layer, the Other layer for the rest.
 * @param {ReviewArtifact} artifact
 * @returns {Stop[]}
 */
export function stopsOf(artifact) {
  /** @type {Stop[]} */
  const stops = []
  // A canvas with no points has nothing to read point by point; its layers show as they are.
  if (artifact.points.length === 0) {
    return stops
  }
  let number = 0
  for (const layer of artifact.layers) {
    const points = artifact.points.filter(p => p.layerId === layer.id)
    if (points.length === 0 && layer.tests.length === 0) {
      continue
    }
    stops.push({ kind: 'layer', id: layerAnchorId(layer.key), layer, points: points.length })
    for (const point of points) {
      number += 1
      stops.push({ kind: 'point', id: pointAnchorId(point.id), layer, point, number })
    }
  }
  return stops
}
