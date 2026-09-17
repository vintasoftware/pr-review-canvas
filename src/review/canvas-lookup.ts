// Which stored canvas stands for a pull request head. A canvas explains a change set, not a
// commit: when the head moved on but its diff against the base is the canvas's diff byte for
// byte (the base branch merged in without touching the files under review), the canvas still
// applies, and so do the reviewer's marks. Every route that decides this goes through here.
import { isDeepStrictEqual } from 'node:util'
import type { MergesSinceInfo } from '../contract/api.js'
import type { Pr } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { AppContext } from '../server/context.js'
import type { CanvasLookup } from '../store/canvas-store.js'
import type { Derived } from '../store/derived-store.js'
import { stateForHead } from './review-body.js'

/** The store's answer, or a canvas of an earlier commit that carries the head's change set. */
export type ResolvedCanvas = CanvasLookup | { status: 'ready'; headSha: string; mergesSince: MergesSinceInfo }

/** Same files, hunks, and patches: the two commits carry one change set. */
export function sameChangeSet(a: Derived, b: Derived): boolean {
  return isDeepStrictEqual(a, b)
}

/** The diffs of one canvas: the stored ones, or freshly built when both commits are local. */
export async function readOrBuildDerived(
  ctx: AppContext,
  headSha: string,
  mergeBaseSha: string | undefined
): Promise<Derived | null> {
  const stored = await ctx.derived.read(headSha)
  if (stored !== null || mergeBaseSha === undefined) {
    return stored
  }
  if (!(await ctx.derived.derivable(headSha, mergeBaseSha))) {
    return null
  }
  return ctx.derived.ensure(headSha, mergeBaseSha)
}

/**
 * The canvas for this pull request. An outdated canvas of an ancestor commit is current after all
 * when the project ignores merge commits and its diff is the head's diff.
 */
export async function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<ResolvedCanvas> {
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (
    found.status !== 'stale' ||
    found.relation !== 'ancestor' ||
    !ctx.projectConfig.config.canvas.ignoreMergeCommits
  ) {
    return found
  }
  const head = await readOrBuildDerived(ctx, pr.headSha, pr.mergeBaseSha)
  const manifest = await ctx.canvases.readManifest(found.headSha)
  const canvas = await readOrBuildDerived(ctx, found.headSha, manifest?.mergeBaseSha)
  if (head === null || canvas === null || !sameChangeSet(canvas, head)) {
    return found
  }
  return {
    status: 'ready',
    headSha: found.headSha,
    mergesSince: {
      canvasHeadSha: found.headSha,
      currentHeadSha: pr.headSha,
      commitsBehind: found.commitsBehind,
    },
  }
}

/**
 * The review marks as they apply to this head. Marks made on a commit whose change set the head
 * still carries move along with it, so a merge commit does not reset the reviewer's progress;
 * marks made on other code count for nothing. The page and the sign-off both read through here.
 */
export async function reviewStateFor(ctx: AppContext, number: number, pr: Pr): Promise<PrState> {
  const stored = await ctx.state.read(number)
  const marked = stored.reviewedHeadSha
  if (marked !== undefined && marked !== pr.headSha && ctx.projectConfig.config.canvas.ignoreMergeCommits) {
    // The marks were made on a page that had built the diff of `marked`, so it is read, not rebuilt.
    const [head, then] = await Promise.all([
      readOrBuildDerived(ctx, pr.headSha, pr.mergeBaseSha),
      ctx.derived.read(marked),
    ])
    if (head !== null && then !== null && sameChangeSet(then, head)) {
      return ctx.state.moveReviewedHead(number, pr.headSha)
    }
  }
  return stateForHead(stored, pr.headSha)
}
