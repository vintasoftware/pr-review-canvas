// Incremental generation: the basis canvas an update starts from, the per-file delta between that
// canvas's diff and the head's, and the split of the basis into content the head leaves untouched
// and content the generator has to decide anew. Everything here is a function of two diffs and one
// stored canvas, so `prepare` states the split instead of asking the generator to work it out.
import type {
  BasisSplit,
  BasisSplitLayer,
  BasisSplitPoint,
  FileDelta,
} from '../contract/generation-context.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import type { Git } from '../git/git.js'
import type { CanvasStore } from '../store/canvas-store.js'
import type { Derived } from '../store/derived-store.js'

/**
 * Which files the head changes relative to the basis canvas's diff. A file is unchanged only when
 * its whole patch is byte-identical: line numbers, context, and all. Anything less would let a
 * fold or an annotation of the basis land on a line it was never written for. Renames arrive as a
 * removal and an addition, since a file's key follows its path.
 */
export function fileDelta(basis: Derived, head: Derived): FileDelta {
  const pathOf = (d: Derived): Map<string, string> => new Map(d.files.map(f => [f.key, f.path]))
  const basisPaths = pathOf(basis)
  const headPaths = pathOf(head)
  const delta: FileDelta = { unchanged: [], changed: [], added: [], removed: [] }
  for (const [key, path] of headPaths) {
    if (!basisPaths.has(key)) {
      delta.added.push(path)
    } else if (basis.patches[key] === head.patches[key]) {
      delta.unchanged.push(path)
    } else {
      delta.changed.push(path)
    }
  }
  for (const [key, path] of basisPaths) {
    if (!headPaths.has(key)) {
      delta.removed.push(path)
    }
  }
  for (const list of Object.values(delta)) {
    list.sort()
  }
  return delta
}

/**
 * The basis canvas divided in two. A layer is carried whole when the head touches none of its
 * files; otherwise the layer is re-judged, and only the files the head leaves alone keep their
 * note, folds, and annotations. A point is carried when the file it sits in is untouched, which
 * keeps its title and so its fingerprint, and with it any dismissal the reviewer made.
 */
export function splitBasis(
  artifact: ReviewArtifact,
  delta: FileDelta
): Omit<BasisSplit, 'canvasSha' | 'reviewJsonPath' | 'files'> {
  const unchanged = new Set(delta.unchanged)
  const layers: BasisSplitLayer[] = artifact.layers.map(layer => {
    const carriedFiles = layer.files.filter(f => unchanged.has(f.path)).map(f => f.path)
    const reJudgedFiles = layer.files.filter(f => !unchanged.has(f.path)).map(f => f.path)
    return {
      key: layer.key,
      title: layer.title,
      status: reJudgedFiles.length === 0 ? 'carried' : 're-judged',
      carriedFiles,
      reJudgedFiles,
    }
  })
  const points: BasisSplitPoint[] = artifact.points.map(point => ({
    kind: point.kind,
    path: point.path,
    title: point.title,
    status: unchanged.has(point.path) ? 'carried' : 're-judged',
  }))
  return { layers, points }
}

/**
 * The canvas an incremental run builds on: the newest one generated for a commit this head was
 * built on. A canvas of a line of work the head no longer contains describes code that was
 * abandoned, so it is never a basis, however recent it is.
 */
export async function findBasisCanvas(
  canvases: CanvasStore,
  git: Git,
  prNumber: number | undefined,
  headSha: string
): Promise<string | null> {
  const index = await canvases.readIndex()
  const candidates = Object.entries(index.canvases)
    .filter(
      ([sha, entry]) => sha !== headSha && (entry.prNumber === undefined || entry.prNumber === prNumber)
    )
    .sort(([, a], [, b]) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0))
  for (const [sha] of candidates) {
    if (await git.isAncestor(sha, headSha)) {
      return sha
    }
  }
  return null
}
