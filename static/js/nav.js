// @ts-check
// The page order of layers and file cards, for the rail, scrollspy, and the j/k n/p keys. Other
// comes last with its files, mirroring the ids layers.js renders.
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
import { fileAnchorId, layerAnchorId, sanitizeKey } from './keys.js'

/**
 * `layerId` names the layer for chat targets; `layerKey` is what a reviewed mark is keyed by, and
 * a file item carries its layer's key so it can name the layer's mark without looking the layer up.
 * @typedef {{ kind: 'overview', id: 'overview' }
 *   | { kind: 'layer', id: string, layerId: string, layerKey: string, key: string, other: boolean }
 *   | { kind: 'file', id: string, layerId: string, layerKey: string, key: string, path: string, isTest: boolean, other: boolean }} NavItem
 */

/**
 * Overview, then every layer followed by its file cards, with the Other layer last.
 * @param {ReviewArtifact} artifact
 * @returns {NavItem[]}
 */
export function buildNavOrder(artifact) {
  /** @type {NavItem[]} */
  const out = [{ kind: 'overview', id: 'overview' }]
  const layers = [
    ...artifact.layers.filter(l => l.kind !== 'other'),
    ...artifact.layers.filter(l => l.kind === 'other'),
  ]
  /** @type {Set<string>} */
  const seen = new Set()
  for (const layer of layers) {
    const other = layer.kind === 'other'
    out.push({
      kind: 'layer',
      id: layerAnchorId(layer.key),
      layerId: layer.id,
      layerKey: layer.key,
      key: layer.key,
      other,
    })
    for (const f of layer.files) {
      const key = sanitizeKey(f.path)
      // The first card of a file carries the plain id; later cards of the same file add the layer key.
      const id = seen.has(key) ? `${fileAnchorId(key)}-${layer.key}` : fileAnchorId(key)
      seen.add(key)
      out.push({
        kind: 'file',
        id,
        layerId: layer.id,
        layerKey: layer.key,
        key,
        path: f.path,
        isTest: f.isTest,
        other,
      })
    }
  }
  return out
}

/**
 * @param {ReadonlyArray<NavItem>} order
 * @param {string | null} currentId
 * @param {'layer' | 'file'} kind
 * @param {1 | -1} direction
 * @returns {NavItem | null}
 */
function step(order, currentId, kind, direction) {
  const from =
    currentId === null ? (direction === 1 ? -1 : order.length) : order.findIndex(i => i.id === currentId)
  const start = from === -1 && currentId !== null ? (direction === 1 ? -1 : order.length) : from
  for (let i = start + direction; i >= 0 && i < order.length; i += direction) {
    const item = order[i]
    if (item !== undefined && item.kind === kind) {
      return item
    }
  }
  return null
}

/** @param {ReadonlyArray<NavItem>} order @param {string | null} currentId */
export function nextLayer(order, currentId) {
  return step(order, currentId, 'layer', 1)
}

/** @param {ReadonlyArray<NavItem>} order @param {string | null} currentId */
export function prevLayer(order, currentId) {
  return step(order, currentId, 'layer', -1)
}

/** @param {ReadonlyArray<NavItem>} order @param {string | null} currentId */
export function nextFile(order, currentId) {
  return step(order, currentId, 'file', 1)
}

/** @param {ReadonlyArray<NavItem>} order @param {string | null} currentId */
export function prevFile(order, currentId) {
  return step(order, currentId, 'file', -1)
}

/**
 * The layer an item belongs to: itself for a layer, its owner for a file, null for the overview.
 * @param {ReadonlyArray<NavItem>} order
 * @param {string} id
 */
export function layerOf(order, id) {
  const item = order.find(i => i.id === id)
  if (!item || item.kind === 'overview') {
    return null
  }
  return item.kind === 'layer'
    ? item
    : (order.find(i => i.kind === 'layer' && i.layerId === item.layerId) ?? null)
}
