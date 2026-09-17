// @ts-check
// File keys and DOM anchor ids. One implementation for the server (re-exported by
// src/contract/keys.ts) and the browser, so chunk ids and line anchors never drift.

/**
 * Turns a repo path into a key safe for ids and file names: every character that is not a
 * letter or digit becomes "_". Two paths can collide (`a-b.ts` and `a_b.ts`); the diff collector
 * adds a numeric suffix through `uniqueKey` when that happens.
 * @param {string} path
 * @returns {string}
 */
export function sanitizeKey(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '_')
}

/**
 * Returns `base` when unused, otherwise `base_2`, `base_3`, and so on.
 * @param {string} base
 * @param {Set<string>} used
 * @returns {string}
 */
export function uniqueKey(base, used) {
  let key = base
  let n = 2
  while (used.has(key)) {
    key = `${base}_${n}`
    n += 1
  }
  used.add(key)
  return key
}

/**
 * @param {string} key
 * @param {number} n 1-based position of the chunk in the file's patch
 * @returns {string}
 */
export function chunkId(key, n) {
  return `${key}#${n}`
}

/**
 * @param {string} id
 * @returns {{ key: string, n: number } | null}
 */
export function parseChunkId(id) {
  const m = /^(.+)#(\d+)$/.exec(id)
  if (!m || m[1] === undefined || m[2] === undefined) {
    return null
  }
  return { key: m[1], n: Number(m[2]) }
}

/**
 * @param {string} key
 * @param {'new' | 'old'} side
 * @param {number} line
 * @returns {string}
 */
export function buildLineId(key, side, line) {
  return `L-${key}-${side}-${line}`
}

/**
 * @param {string} id
 * @returns {{ key: string, side: 'new' | 'old', line: number } | null}
 */
export function parseLineId(id) {
  const m = /^L-(.+)-(new|old)-(\d+)$/.exec(id)
  if (!m || m[1] === undefined || m[3] === undefined) {
    return null
  }
  return { key: m[1], side: m[2] === 'old' ? 'old' : 'new', line: Number(m[3]) }
}

/** @param {string} key */
export function fileAnchorId(key) {
  return `file-${key}`
}

/**
 * @param {string} key
 * @param {number} n
 */
export function chunkAnchorId(key, n) {
  return `chunk-${key}-${n}`
}

/** @param {string} layerKey */
export function layerAnchorId(layerKey) {
  return `layer-${layerKey}`
}

/** @param {string} pointId */
export function pointAnchorId(pointId) {
  return `point-${pointId}`
}
