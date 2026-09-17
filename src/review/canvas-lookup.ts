// Which stored canvas, and which review marks, stand for a pull request head once the project's
// word on merge commits is applied. Every route and the CLI decide this here and nowhere else.
import type { Pr } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { AppContext } from '../server/context.js'
import { stateForHead } from './review-body.js'
import type { CanvasLookup } from '../store/canvas-store.js'

/** What the rule reads of a pull request; a `PrMeta` with its fetched shas fits as well as a `Pr`. */
type PrHead = Pick<Pr, 'headSha' | 'mergeBaseSha'>

/**
 * True when `sha` carries the same change set as the head: it is the head, or the head only
 * merged history that is already in the base onto it, each merge as git would have made it. That
 * needs the project to ignore merge commits. Any ordinary commit since `sha`, on the branch or
 * brought in by merging a branch the base does not contain, and any edit made while resolving a
 * merge by hand, marks the canvas outdated.
 */
export async function standsForHead(ctx: AppContext, sha: string, pr: PrHead): Promise<boolean> {
  if (sha === pr.headSha) {
    return true
  }
  if (!ctx.projectConfig.config.canvas.ignoreMergeCommits) {
    return false
  }
  return (
    (await ctx.git.isAncestor(sha, pr.headSha)) &&
    ctx.git.onlyAutomaticMergesBeyond(pr.headSha, [sha, pr.mergeBaseSha])
  )
}

/** The canvas for this pull request: the head's own, or one of an earlier commit that stands for it. */
export async function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasLookup> {
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (
    found.status !== 'stale' ||
    found.relation !== 'ancestor' ||
    !(await standsForHead(ctx, found.headSha, pr))
  ) {
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
 * The review marks as they apply to this head. Marks made on a commit that stands for the head
 * are re-keyed to it, so a merge commit does not reset the reviewer's progress; marks made on any
 * other commit describe other code and are never shown as reviewed.
 */
export async function reviewStateFor(ctx: AppContext, number: number, pr: Pr): Promise<PrState> {
  const stored = await ctx.state.read(number)
  const marked = stored.reviewedHeadSha
  if (marked !== undefined && marked !== pr.headSha && (await standsForHead(ctx, marked, pr))) {
    return ctx.state.update(number, state => ({ ...state, reviewedHeadSha: pr.headSha }))
  }
  return stateForHead(stored, pr.headSha)
}
