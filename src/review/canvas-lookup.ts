// Which stored canvas the page shows for a pull request head, with the diff it is shown with. A
// canvas explains a change set, not a commit: when the head moved on but its diff against the
// base is the canvas's diff byte for byte (the base branch merged in without touching the files
// under review), the canvas still applies, and so do the reviewer's marks. The bundle, the
// sign-off, the chat, and the export all read the same resolution.
import { isDeepStrictEqual } from 'node:util'
import type { Pr } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { AppContext } from '../server/context.js'
import type { Derived } from '../store/derived-store.js'
import { stateForHead } from './review-body.js'

/** Where a pull request stands: the head's diff, and the canvas that explains it. */
export type CanvasResolution = { head: Derived | null } & (
  | { status: 'missing' }
  /** `headSha` is the canvas's commit: the head, or `commitsSince` commits before it with the same diff. */
  | { status: 'ready'; headSha: string; commitsSince: number }
  /** An outdated canvas is shown with the diff of its own commit, when the clone can build it. */
  | { status: 'stale'; headSha: string; relation: 'ancestor'; commitsBehind: number; diff: Derived | null }
  | { status: 'stale'; headSha: string; relation: 'unrelated'; diff: Derived | null }
)

/** Same files, hunks, and patches: the two commits carry one change set. */
export function sameChangeSet(a: Derived, b: Derived): boolean {
  return isDeepStrictEqual(a, b)
}

/**
 * The diffs of one commit against its merge base. Built when the clone has both commits, which
 * also refreshes a stored copy made against an older base; otherwise the stored copy, which is
 * all an imported canvas has until its commits are fetched.
 */
export async function readOrBuildDerived(
  ctx: AppContext,
  headSha: string,
  mergeBaseSha: string | undefined
): Promise<Derived | null> {
  if (mergeBaseSha !== undefined && (await ctx.derived.derivable(headSha, mergeBaseSha))) {
    return ctx.derived.ensure(headSha, mergeBaseSha)
  }
  return ctx.derived.read(headSha)
}

/**
 * The canvas for this pull request and the diffs around it. An outdated canvas of an ancestor
 * commit is current after all when the project keeps canvases across unchanged diffs and its
 * diff is the head's.
 */
export async function resolveCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasResolution> {
  const head = await readOrBuildDerived(ctx, pr.headSha, pr.mergeBaseSha)
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (found.status === 'missing') {
    return { head, status: 'missing' }
  }
  if (found.status === 'ready') {
    return { head, status: 'ready', headSha: found.headSha, commitsSince: 0 }
  }
  const manifest = await ctx.canvases.readManifest(found.headSha)
  const diff = await readOrBuildDerived(ctx, found.headSha, manifest?.mergeBaseSha)
  if (
    found.relation === 'ancestor' &&
    ctx.projectConfig.config.canvas.keepWhenDiffUnchanged &&
    head !== null &&
    diff !== null &&
    sameChangeSet(diff, head)
  ) {
    return { head, status: 'ready', headSha: found.headSha, commitsSince: found.commitsBehind }
  }
  return { ...found, head, diff }
}

/**
 * The review marks as they apply to this head. Marks made on a commit whose diff the head still
 * carries move along with it, so a merge commit does not reset the reviewer's progress; marks
 * made on other code count for nothing. The page and the sign-off both read through here.
 */
export async function reviewStateFor(
  ctx: AppContext,
  number: number,
  pr: Pr,
  head: Derived | null
): Promise<PrState> {
  const stored = await ctx.state.read(number)
  const marked = stored.reviewedHeadSha
  if (
    marked !== undefined &&
    marked !== pr.headSha &&
    head !== null &&
    ctx.projectConfig.config.canvas.keepWhenDiffUnchanged
  ) {
    // The marks were made on a page that had built the diff of `marked`, so it is read, not rebuilt.
    const then = await ctx.derived.read(marked)
    if (then !== null && sameChangeSet(then, head)) {
      return ctx.state.moveReviewedHead(number, pr.headSha)
    }
  }
  return stateForHead(stored, pr.headSha)
}
