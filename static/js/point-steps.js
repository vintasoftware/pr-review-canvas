// @ts-check
// The order the one-point-at-a-time view walks the attention points in: layer by layer, as the
// canvas tells the change, and within a layer what most needs a decision first.
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {ReviewArtifact['layers'][number]} Layer */
import { LEVELS } from './point-level.js'

/** Worst first, as the generator ranks a `decide` point's impact. */
const IMPACTS = /** @type {const} */ (['critical', 'high', 'low'])

/**
 * How urgent a point reads: its level first (decide, check, fyi), then a decide point's impact. A
 * point without an impact comes after those with one at its level.
 * @param {Point} p
 * @returns {[number, number]}
 */
function severity(p) {
  const impact = p.impact === undefined ? IMPACTS.length : IMPACTS.indexOf(p.impact)
  return [LEVELS.indexOf(p.level), impact]
}

/**
 * @param {Point} first
 * @param {Point} second
 */
function bySeverity(first, second) {
  const [firstLevel, firstImpact] = severity(first)
  const [secondLevel, secondImpact] = severity(second)
  return firstLevel - secondLevel || firstImpact - secondImpact
}

/**
 * One stop of the view: a point, and the layer it belongs to. A point whose layer the canvas does
 * not list has none.
 * @typedef {{ point: Point, layer: Layer | null }} PointStep
 */

/**
 * The points, layer by layer in the canvas's order, each layer's from the most severe. Points of
 * the same severity keep the canvas's order, which is the generator's. Points of no listed layer
 * come last.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<Point>} points the points to walk, such as the reader's open ones
 * @returns {PointStep[]}
 */
export function pointSteps(artifact, points) {
  const layerIds = new Set(artifact.layers.map(layer => layer.id))
  const steps = artifact.layers.flatMap(layer =>
    points
      .filter(p => p.layerId === layer.id)
      .sort(bySeverity)
      .map(point => ({ point, layer }))
  )
  const unlayered = points
    .filter(p => p.layerId === undefined || !layerIds.has(p.layerId))
    .sort(bySeverity)
    .map(point => ({ point, layer: null }))
  return [...steps, ...unlayered]
}
