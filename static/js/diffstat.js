// @ts-check
// The `+N −M` totals of the header and the rail. Where tests changed, a thin bar under the
// numbers shows how much of it is tests, and the title and the screen reader give the split.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {{ additions: number, deletions: number }} Changes */
import { hunkId } from './keys.js'

/**
 * Lines added and removed by each hunk of a patch, by hunk id.
 * @param {string} key
 * @param {string} patch
 * @returns {Map<string, Changes>}
 */
function hunkChanges(key, patch) {
  /** @type {Map<string, Changes>} */
  const out = new Map()
  /** @type {Changes | null} */
  let cur = null
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      cur = { additions: 0, deletions: 0 }
      out.set(hunkId(key, out.size + 1), cur)
    } else if (cur !== null && line.startsWith('+')) {
      cur.additions++
    } else if (cur !== null && line.startsWith('-')) {
      cur.deletions++
    }
  }
  return out
}

/**
 * Lines a layer adds and removes, and the part of them in test files. A file split across
 * layers counts only the hunks of this layer; without its patch, the file counts whole.
 * @param {Layer} layer
 * @param {ReadonlyArray<FileEntry>} files
 * @param {Record<string, string> | null} patches
 * @returns {{ total: Changes, tests: Changes }}
 */
export function layerChanges(layer, files, patches) {
  const total = { additions: 0, deletions: 0 }
  const tests = { additions: 0, deletions: 0 }
  for (const lf of layer.files) {
    const entry = files.find(f => f.path === lf.path)
    if (!entry) {
      continue
    }
    const patch = patches?.[entry.key]
    const byHunk = patch === undefined ? null : hunkChanges(entry.key, patch)
    const file = byHunk
      ? lf.hunks.reduce((sum, id) => add(sum, byHunk.get(id)), { additions: 0, deletions: 0 })
      : entry
    add(total, file)
    if (lf.isTest) {
      add(tests, file)
    }
  }
  return { total, tests }
}

/**
 * Lines the change set adds and removes in test files, whole files.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<FileEntry>} files
 * @returns {Changes}
 */
export function testChanges(artifact, files) {
  const testPaths = new Set(artifact.layers.flatMap(l => l.files.filter(f => f.isTest).map(f => f.path)))
  return files
    .filter(f => testPaths.has(f.path))
    .reduce((sum, f) => add(sum, f), { additions: 0, deletions: 0 })
}

/**
 * @param {Changes} sum
 * @param {Changes | undefined} part
 */
function add(sum, part) {
  sum.additions += part?.additions ?? 0
  sum.deletions += part?.deletions ?? 0
  return sum
}

/**
 * @param {Changes} total
 * @param {Changes} [tests] the part of `total` in test files; no bar when none
 * @returns {string}
 */
export function diffstatHtml(total, tests) {
  const numbers = `<span class="ok">+${total.additions}</span> <span class="bad">&minus;${total.deletions}</span>`
  const testLines = tests ? tests.additions + tests.deletions : 0
  if (!tests || testLines === 0) {
    return `<span class="diffstat">${numbers}</span>`
  }
  const code = {
    additions: Math.max(total.additions - tests.additions, 0),
    deletions: Math.max(total.deletions - tests.deletions, 0),
  }
  const share = Math.round((testLines / Math.max(total.additions + total.deletions, testLines)) * 100)
  const split = `code +${code.additions} &minus;${code.deletions} · tests +${tests.additions} &minus;${tests.deletions}`
  return `<span class="diffstat split" style="--tests:${share}%" title="${split}">${numbers}<span class="sr"> (${split})</span></span>`
}
