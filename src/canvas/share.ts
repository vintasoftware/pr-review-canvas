// Sharing a stored canvas on its pull request as the author's canvas comment. Publish shares a new
// canvas this way, and self-review shares the author's revision of it.
import type { CanvasSharing } from '../contract/self-review.js'
import type { AppContext } from '../server/context.js'
import { buildCanvasComment } from './comment.js'
import { tallyCanvas } from '../review/self-review.js'
import { exportCanvas, zipStoredCanvas } from './export.js'

/**
 * Creates or updates the canvas comment. A failure is returned, not thrown: the canvas is stored
 * either way, and the exported zip is the manual fallback.
 */
export async function shareCanvasOnPr(
  ctx: AppContext,
  headSha: string,
  number: number
): Promise<CanvasSharing> {
  try {
    const { zip, artifact } = await zipStoredCanvas(ctx, headSha, number)
    const body = buildCanvasComment(zip, tallyCanvas(artifact), ctx.config.host.canvasCommentLimit)
    const url = await ctx.config.host.shareCanvas(ctx.gh, ctx.config.repo, number, body)
    return { status: 'shared', url }
  } catch (err) {
    const exported = await exportCanvas(ctx, { headSha, prNumber: number })
    return {
      status: 'failed',
      warning: `Automatic canvas sharing failed: ${err instanceof Error ? err.message : String(err)}. Upload the ZIP to the ${ctx.config.host.noun} description manually.`,
      zipPath: exported.path,
    }
  }
}
