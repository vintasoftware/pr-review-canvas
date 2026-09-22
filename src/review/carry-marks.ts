// Review marks following an incremental canvas forward. Each canvas names the one it was generated
// from, and that line of descent decides which of the reviewer's marks may follow — worked out here,
// on the reviewer's own machine, from the two canvases and the two diffs it can read itself. The
// published canvas is a pointer along that line and never a statement about what anyone reviewed.
import { reviewedId } from '../contract/keys.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { AppContext } from '../server/context.js'
import { fileDelta } from './incremental.js'

function samePaths(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(b)
  return a.length === b.length && a.every(p => set.has(p))
}

/**
 * The marks that still describe code the reviewer has seen. `marked` is the canvas they made the
 * marks on. A file mark follows when that file is in both canvases under the same layer key and
 * its patch is byte-identical; a layer mark follows only when the layer holds exactly the same
 * files and none of them changed, since a layer mark claims the whole layer was read. Marks on
 * anything else are left behind.
 */
export function carriedMarks(
  marked: ReviewArtifact,
  next: ReviewArtifact,
  unchangedPaths: ReadonlySet<string>,
  reviewed: Readonly<Record<string, true>>
): Record<string, true> {
  const carried: Record<string, true> = {}
  for (const layer of next.layers) {
    const before = marked.layers.find(l => l.key === layer.key)
    if (before === undefined) {
      continue
    }
    const paths = layer.files.map(f => f.path)
    const beforePaths = before.files.map(f => f.path)
    for (const path of paths) {
      const id = reviewedId(layer.key, path)
      if (unchangedPaths.has(path) && beforePaths.includes(path) && reviewed[id] === true) {
        carried[id] = true
      }
    }
    const id = reviewedId(layer.key)
    if (reviewed[id] === true && samePaths(paths, beforePaths) && paths.every(p => unchangedPaths.has(p))) {
      carried[id] = true
    }
  }
  return carried
}

export interface MarksForCanvas {
  /** The stored state as it applies to this canvas: only the marks that count for it. */
  state: PrState
  /** The canvas the marks were made on, when any of them followed. The page says so. */
  carriedFrom?: string
}

/**
 * Whether the line of descent that starts at `basisSha` reaches `ancestorSha`. The canvas on screen
 * states its own basis, so the walk starts from the artifact's own pointer; the canvases further
 * back are read from the index, which one read already holds, so following the line costs no extra
 * canvas reads on the page's hot path.
 *
 * The line matters because the reviewer's marks only move to a canvas generated from the one they
 * were made on. It has to be a line rather than a single step: the stored commit advances only when
 * the reviewer marks something (`setReviewed` is its only writer), so a reviewer who opens a canvas,
 * finds it already ticked, and clicks nothing leaves their marks keyed to a canvas two or more
 * generations back.
 */
async function descendsFrom(
  ctx: AppContext,
  basisSha: string | undefined,
  ancestorSha: string
): Promise<boolean> {
  const index = await ctx.canvases.readIndex()
  const seen = new Set<string>()
  let at = basisSha
  while (at !== undefined && !seen.has(at)) {
    if (at === ancestorSha) {
      return true
    }
    seen.add(at)
    at = index.canvases[at]?.basisCanvasSha
  }
  return false
}

/**
 * The marks to show for one canvas. Marks made on it stand. Marks made on a canvas it descends
 * from follow it for the parts of the diff those two canvases share, whatever the canvases in
 * between did: a mark says the reviewer read one patch, so the patch they read and the patch on
 * screen are compared directly, and a file the intervening canvases changed and changed back reads
 * as untouched because it is. Anything else describes other code and counts for nothing, which is
 * also what happens when this machine cannot read the older canvas or rebuild either diff.
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
  const markedOn = stored.reviewedCanvasSha
  if (markedOn === undefined || !(await descendsFrom(ctx, artifact.basisCanvasSha, markedOn))) {
    return dropped
  }
  const [markedArtifact, markedManifest, manifest] = await Promise.all([
    ctx.canvases.readArtifact(markedOn),
    ctx.canvases.readManifest(markedOn),
    ctx.canvases.readManifest(canvasSha),
  ])
  if (markedArtifact === null || markedManifest === null || manifest === null) {
    return dropped
  }
  const [markedDiff, diff] = await Promise.all([
    ctx.derived.readOrBuild(markedOn, markedManifest.mergeBaseSha),
    ctx.derived.readOrBuild(canvasSha, manifest.mergeBaseSha),
  ])
  if (markedDiff === null || diff === null) {
    return dropped
  }
  const unchanged = new Set(fileDelta(markedDiff, diff).unchanged)
  const reviewed = carriedMarks(markedArtifact, artifact, unchanged, stored.reviewed)
  if (Object.keys(reviewed).length === 0) {
    return dropped
  }
  return { state: { ...stored, reviewed, reviewedCanvasSha: canvasSha }, carriedFrom: markedOn }
}
