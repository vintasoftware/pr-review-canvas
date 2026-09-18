// A canvas carried over to a later head: the head's diff is identical to the diff the canvas was
// generated from, so the canvas stands for it. The one place that reads the rule.
import { isDeepStrictEqual } from 'node:util'
import type { Pr } from '../contract/review-artifact.js'
import type { AppContext } from '../server/context.js'
import type { CanvasLookup } from '../store/canvas-store.js'
import type { Derived } from '../store/derived-store.js'

/** A commit with the merge base its diff runs from; `Pr`, a prepared context, and a canvas manifest all provide it. */
export interface DiffedCommit {
  headSha: string
  mergeBaseSha: string
}

/**
 * True when `commit` stands for the head: it is the head, or the head's diff against its merge
 * base is identical to `commit`'s diff against its own, file by file and byte for byte. Layers,
 * hunk ids, folds, and attention points all assume the diff on screen is the one the canvas was
 * generated from, and identity is what guarantees that; a base merge that only moves a hunk down
 * already breaks it. How the head reached that diff does not matter. A diff missing on this
 * machine keeps the strict reading. Off when the project marks the canvas outdated on any commit.
 */
export async function standsForHead(
  ctx: AppContext,
  pr: DiffedCommit,
  commit: DiffedCommit
): Promise<boolean> {
  if (commit.headSha === pr.headSha) {
    return true
  }
  if (!ctx.projectConfig.config.canvas.keepForIdenticalDiff) {
    return false
  }
  const [older, head] = await Promise.all([
    ctx.derived.readOrBuild(commit.headSha, commit.mergeBaseSha),
    ctx.derived.readOrBuild(pr.headSha, pr.mergeBaseSha),
  ])
  return older !== null && head !== null && sameDiff(older, head)
}

/** Whether two diffs are the same: the same files in the same order, each with the same patch. */
export function sameDiff(a: Derived, b: Derived): boolean {
  return isDeepStrictEqual(a, b)
}

/**
 * The canvas for this pull request: the store's answer, with a canvas of another commit read as
 * ready when that commit stands for the head. A canvas has a manifest naming its merge base;
 * one whose manifest is gone cannot be compared.
 */
export async function lookupCanvas(ctx: AppContext, number: number, pr: Pr): Promise<CanvasLookup> {
  const found = await ctx.canvases.findForPr(number, pr.headSha)
  if (found.status !== 'stale') {
    return found
  }
  const manifest = await ctx.canvases.readManifest(found.headSha)
  if (manifest !== null && (await standsForHead(ctx, pr, manifest))) {
    return {
      status: 'ready',
      headSha: found.headSha,
      carriedOver: { canvasHeadSha: found.headSha, currentHeadSha: pr.headSha },
    }
  }
  return found
}
