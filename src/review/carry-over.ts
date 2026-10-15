// A canvas carried over to a later head: the head's diff is identical to the diff the canvas was
// generated from, so the canvas stands for it. The one place that reads the rule.
import type { CarriedOverInfo, StaleRelation } from '../contract/api.js'
import type { Pr } from '../contract/review-artifact.js'
import type { AppContext } from '../server/context.js'
import { type CanvasLookup, relateToHead } from '../store/canvas-store.js'
import { sameDiff } from '../../static/js/diff-identity.js'
import type { Derived, DiffedCommit } from '../store/derived-store.js'

export type { DiffedCommit } from '../store/derived-store.js'

/**
 * True when `commit` stands for the head: it is the head diffed from the same merge base, or the
 * head's diff against its merge base is identical to `commit`'s diff against its own, file by file
 * and byte for byte, whether `commit` is another commit or the head diffed from another base. Layers, hunk ids, folds, and attention points all assume the diff on screen is
 * the one the canvas was generated from, and identity is what guarantees that; a base merge that
 * only moves a hunk down already breaks it. How the head reached that diff does not matter. A diff
 * missing on this machine, and a change set that is empty on both sides, keep the strict reading.
 * Off when the project marks the canvas outdated on any commit.
 */
export async function standsForHead(
  ctx: AppContext,
  pr: DiffedCommit,
  commit: DiffedCommit
): Promise<boolean> {
  if (sameDiff(commit, pr)) {
    return true
  }
  if (!ctx.projectConfig.config.canvas.keepForIdenticalDiff) {
    return false
  }
  const [older, head] = await Promise.all([ctx.derived.readOrBuild(commit), ctx.derived.readOrBuild(pr)])
  if (older === null || head === null) {
    return false
  }
  // Two empty diffs are equal by having nothing to compare, which is no evidence that the canvas
  // explains the head. An empty change set has nothing to review either way, so the strict
  // reading costs the reviewer nothing here.
  return Object.keys(head.patches).length > 0 && samePatches(older, head)
}

/**
 * Whether two diffs change the same code: the same patch keys, each with the same patch body.
 * The patches are the diff; the files array beside them only counts and flags what the patches
 * already say, so comparing the patches is comparing the whole change.
 */
export function samePatches(a: Derived, b: Derived): boolean {
  const keys = Object.keys(a.patches)
  return keys.length === Object.keys(b.patches).length && keys.every(k => a.patches[k] === b.patches[k])
}

/**
 * How a canvas of `canvas` that does not stand for the head relates to it: the head itself diffed
 * from another merge base, or another commit the head was built on or left behind. The page and
 * the import both read it here.
 */
export async function staleRelation(
  ctx: AppContext,
  pr: DiffedCommit,
  canvas: DiffedCommit
): Promise<StaleRelation> {
  return canvas.headSha === pr.headSha
    ? {
        relation: 'other-base',
        canvasMergeBaseSha: canvas.mergeBaseSha,
        currentMergeBaseSha: pr.mergeBaseSha,
      }
    : relateToHead(ctx.git, canvas.headSha, pr.headSha)
}

/**
 * The canvas for this pull request: the store's answer, with a canvas of another commit read as
 * ready when that commit stands for the head, and the head's own canvas read as stale when it was
 * generated against another merge base, as after the pull request moved to another base branch. A
 * canvas has a manifest naming its merge base; one whose manifest is gone cannot be compared.
 */
export async function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasLookup> {
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (found.status === 'missing') {
    return found
  }
  const manifest = await ctx.canvases.readManifest(found.headSha)
  if (found.status === 'ready') {
    return manifest === null || (await standsForHead(ctx, pr, manifest))
      ? found
      : { status: 'stale', headSha: found.headSha, ...(await staleRelation(ctx, pr, manifest)) }
  }
  if (manifest !== null && (await standsForHead(ctx, pr, manifest))) {
    const carriedOver: CarriedOverInfo = { canvasHeadSha: found.headSha, currentHeadSha: pr.headSha }
    // How far the head moved, when the head was built on the canvas's commit. A head that
    // reached the identical diff another way, by a rebase, is no distance from it at all.
    if (found.relation === 'ancestor') {
      carriedOver.commitsBehind = found.commitsBehind
    }
    return { status: 'ready', headSha: found.headSha, carriedOver }
  }
  return found
}
