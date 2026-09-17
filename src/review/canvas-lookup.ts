// Which stored canvas stands for a pull request head, with the project's word on merge commits.
import type { Pr } from '../contract/review-artifact.js'
import type { ProjectConfig } from '../project-config.js'
import type { AppContext } from '../server/context.js'
import { type CanvasLookup, onlyMergesSince } from '../store/canvas-store.js'

/**
 * Whether a canvas of an earlier commit may stand for this head: the project ignores merge
 * commits, and the host reports that the head merges cleanly. A pending or negative conflict
 * check keeps the strict reading, so a merge that resolved conflicts by hand marks the canvas
 * outdated.
 */
export function followsMerges(config: ProjectConfig, pr: Pr): boolean {
  return config.canvas.ignoreMergeCommits && pr.mergeable === true
}

/** The canvas for this pull request, read with the project's merge-commit setting applied. */
export function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasLookup> {
  return ctx.canvases.findForPr(number, pr.headSha, {
    followMerges: followsMerges(ctx.projectConfig.config, pr),
  })
}

/**
 * True when `sha` describes the same change set as the head: it is the head, or the head only
 * merged other branches onto it and the project lets that pass.
 */
export async function standsForHead(ctx: AppContext, sha: string, pr: Pr): Promise<boolean> {
  if (sha === pr.headSha) {
    return true
  }
  return followsMerges(ctx.projectConfig.config, pr) && onlyMergesSince(ctx.git, sha, pr.headSha)
}
