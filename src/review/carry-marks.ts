// Review marks following an incremental canvas forward. A canvas names the basis it was generated
// from; which of the reviewer's marks may follow is decided here, on the reviewer's own machine,
// from the two canvases and the two diffs it can read itself. The published canvas is a pointer to
// the basis and never a statement about what anyone reviewed.
import { sanitizeKey } from '../contract/keys.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { AppContext } from '../server/context.js'
import { fileDelta } from './incremental.js'

/** The reviewed-mark id of a layer, or of one file of it; the ids the page writes. */
export function markId(layerKey: string, filePath?: string): string {
  return filePath === undefined ? `layer:${layerKey}` : `layer:${layerKey}/file:${sanitizeKey(filePath)}`
}

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b)
  return a.length === b.length && a.every(p => set.has(p))
}

/**
 * The marks that still describe code the reviewer has seen. A file mark follows when that file is
 * in both canvases under the same layer key and its patch is byte-identical; a layer mark follows
 * only when the layer holds exactly the same files and the head touched none of them, since a
 * layer mark claims the whole layer was read. Marks on anything else are left behind.
 */
export function carriedMarks(
  basis: ReviewArtifact,
  next: ReviewArtifact,
  unchangedPaths: ReadonlySet<string>,
  reviewed: Readonly<Record<string, true>>
): Record<string, true> {
  const carried: Record<string, true> = {}
  for (const layer of next.layers) {
    const before = basis.layers.find(l => l.key === layer.key)
    if (before === undefined) {
      continue
    }
    const paths = layer.files.map(f => f.path)
    const beforePaths = before.files.map(f => f.path)
    for (const path of paths) {
      const id = markId(layer.key, path)
      if (unchangedPaths.has(path) && beforePaths.includes(path) && reviewed[id] === true) {
        carried[id] = true
      }
    }
    const id = markId(layer.key)
    if (reviewed[id] === true && samePaths(paths, beforePaths) && paths.every(p => unchangedPaths.has(p))) {
      carried[id] = true
    }
  }
  return carried
}

export interface MarksForCanvas {
  /** The stored state as it applies to this canvas: only the marks that count for it. */
  state: PrState
  /** The basis canvas the marks came from, when any did. The page says so. */
  carriedFrom?: string
}

/**
 * The marks to show for one canvas. Marks made on it stand. Marks made on the canvas it was
 * generated from follow it for the parts of the diff it leaves untouched. Anything else describes
 * other code and counts for nothing, which is also what happens when this machine cannot read the
 * basis canvas or rebuild either diff.
 */
export async function marksForCanvas(
  ctx: AppContext,
  artifact: ReviewArtifact,
  canvasSha: string,
  stored: PrState
): Promise<MarksForCanvas> {
  if (stored.reviewedCanvasSha === canvasSha) {
    return { state: stored }
  }
  const dropped: MarksForCanvas = { state: { ...stored, reviewed: {} } }
  const basisSha = artifact.basisCanvasSha
  if (basisSha === undefined || basisSha !== stored.reviewedCanvasSha) {
    return dropped
  }
  const [basisArtifact, basisManifest, manifest] = await Promise.all([
    ctx.canvases.readArtifact(basisSha),
    ctx.canvases.readManifest(basisSha),
    ctx.canvases.readManifest(canvasSha),
  ])
  if (basisArtifact === null || basisManifest === null || manifest === null) {
    return dropped
  }
  const [basisDiff, diff] = await Promise.all([
    ctx.derived.readOrBuild(basisSha, basisManifest.mergeBaseSha),
    ctx.derived.readOrBuild(canvasSha, manifest.mergeBaseSha),
  ])
  if (basisDiff === null || diff === null) {
    return dropped
  }
  const unchanged = new Set(fileDelta(basisDiff, diff).unchanged)
  const reviewed = carriedMarks(basisArtifact, artifact, unchanged, stored.reviewed)
  if (Object.keys(reviewed).length === 0) {
    return dropped
  }
  return { state: { ...stored, reviewed, reviewedCanvasSha: canvasSha }, carriedFrom: basisSha }
}
