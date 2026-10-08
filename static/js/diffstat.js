// @ts-check
// The `+N −M` totals of the header and the rail. Where tests changed, the title and the screen
// reader give the split between code and tests.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {{ additions: number, deletions: number }} Changes */
import { splitHunks } from './hunks.js'
import { hunkId } from './keys.js'

/**
 * Lines each hunk adds and removes, by file key and hunk id. Kept per patch map, so redrawing the
 * rail on a state change sums counts instead of splitting the patches again.
 * @type {WeakMap<Record<string, string>, Map<string, Map<string, Changes>>>}
 */
const counted = new WeakMap()

/**
 * @param {Record<string, string>} patches
 * @param {string} key
 * @param {string} patch
 * @returns {Map<string, Changes>}
 */
function hunkChanges(patches, key, patch) {
  let byFile = counted.get(patches)
  if (byFile === undefined) {
    byFile = new Map()
    counted.set(patches, byFile)
  }
  let byHunk = byFile.get(key)
  if (byHunk === undefined) {
    byHunk = new Map(
      splitHunks(patch).map((h, i) => [
        hunkId(key, i + 1),
        {
          additions: h.lines.filter(l => l.startsWith('+')).length,
          deletions: h.lines.filter(l => l.startsWith('-')).length,
        },
      ])
    )
    byFile.set(key, byHunk)
  }
  return byHunk
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
    const byHunk = patches === null || patch === undefined ? null : hunkChanges(patches, entry.key, patch)
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
 * @param {Changes} [tests] the part of `total` in test files; no split when none
 * @returns {string}
 */
export function diffstatHtml(total, tests) {
  const numbers = `<span class="ok">+${total.additions}</span> <span class="bad">&minus;${total.deletions}</span>`
  if (!tests || tests.additions + tests.deletions === 0) {
    return `<span class="diffstat">${numbers}</span>`
  }
  const code = { additions: total.additions - tests.additions, deletions: total.deletions - tests.deletions }
  const split = `code +${code.additions} &minus;${code.deletions} · tests +${tests.additions} &minus;${tests.deletions}`
  return `<span class="diffstat" title="${split}">${numbers}<span class="sr"> (${split})</span></span>`
}
