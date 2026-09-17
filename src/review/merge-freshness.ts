// What stands for a pull request head after merge commits: the stored canvas and the review
// marks, with the project's word on merge commits. The one place that reads the rule.
import type { Pr } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { Git } from '../git/git.js'
import type { ProjectConfig } from '../project-config.js'
import type { AppContext } from '../server/context.js'
import type { CanvasLookup } from '../store/canvas-store.js'
import { stateForHead } from './review-body.js'

/** The head as the rule reads it; `Pr` and a fetched `PrMeta` with its refs both provide it. */
export type HeadOfPr = Pick<Pr, 'headSha' | 'mergeBaseSha' | 'mergeable'>

/**
 * True when `sha` carries the change set of the head: it is the head, or the head only merged the
 * base branch onto it. The head's diff runs from its merge base, so a commit inside that base
 * leaves the diff, and every other commit the head gained since `sha`, its own or merged in from
 * another branch, changes it. This passes only while the project ignores merge commits and the
 * host reports the head as mergeable; a pending or negative report keeps the strict reading. How a
 * merge was resolved is not inspected.
 */
export async function standsForHead(
  git: Git,
  config: ProjectConfig,
  pr: HeadOfPr,
  sha: string
): Promise<boolean> {
  if (sha === pr.headSha) {
    return true
  }
  return (
    config.canvas.ignoreMergeCommits &&
    pr.mergeable === true &&
    (await git.isAncestor(sha, pr.headSha)) &&
    (await git.countOwnCommitsSince(sha, pr.headSha, pr.mergeBaseSha)) === 0
  )
}

/** The canvas for this pull request: the store's answer, with a canvas that stands for the head read as ready. */
export async function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasLookup> {
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (
    found.status === 'stale' &&
    found.relation === 'ancestor' &&
    (await standsForHead(ctx.git, ctx.projectConfig.config, pr, found.headSha))
  ) {
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
  return found
}

/**
 * The review marks as they apply to this head. Marks made on a commit that stands for the head
 * are re-keyed to it, so a merge commit does not reset the reviewer's progress; marks made on any
 * other commit describe other code, so they never show as reviewed.
 */
export async function reviewStateFor(ctx: AppContext, number: number, pr: Pr): Promise<PrState> {
  const stored = await ctx.state.read(number)
  const marked = stored.reviewedHeadSha
  if (marked !== undefined && marked !== pr.headSha) {
    if (await standsForHead(ctx.git, ctx.projectConfig.config, pr, marked)) {
      return ctx.state.moveReviewedHead(number, pr.headSha)
    }
  }
  return stateForHead(stored, pr.headSha)
}
