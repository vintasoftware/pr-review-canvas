// @ts-check
// Reviewed state per layer. Other changes never count.
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
import { sanitizeKey } from './keys.js'

/**
 * @param {Layer} layer
 * @param {PrState} state
 * @returns {'done' | 'partial' | 'none'}
 */
export function layerProgress(layer, state) {
  if (state.reviewed[`layer:${layer.id}`] === true) {
    return 'done'
  }
  const files = layer.files.length
  let reviewedFiles = 0
  for (const f of layer.files) {
    if (state.reviewed[`layer:${layer.id}/file:${sanitizeKey(f.path)}`] === true) {
      reviewedFiles++
    }
  }
  if (files > 0 && reviewedFiles === files) {
    return 'done'
  }
  return reviewedFiles > 0 ? 'partial' : 'none'
}

/**
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @returns {{ done: number, total: number, percent: number }}
 */
export function progressSummary(artifact, state) {
  const layers = artifact.layers.filter(l => l.kind !== 'other')
  const done = layers.filter(l => layerProgress(l, state) === 'done').length
  const total = layers.length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * Files reviewed in a layer, for the rail meta ("2 of 3 files").
 * @param {Layer} layer
 * @param {PrState} state
 */
export function filesReviewed(layer, state) {
  return layer.files.filter(f => state.reviewed[`layer:${layer.id}/file:${sanitizeKey(f.path)}`] === true)
    .length
}
