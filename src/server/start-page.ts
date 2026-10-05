import type { AppContext } from './context.js'

/**
 * The page the browser opens at startup: the review of the open PR whose head is the checked-out
 * branch, so a server started in a PR's worktree lands on that PR. Anything else opens the home
 * page, and a failed lookup does too: the server runs either way.
 */
export async function startPage(ctx: AppContext): Promise<{ path: string; prNumber: number | null }> {
  const home = { path: '/', prNumber: null }
  const branch = await ctx.git.currentBranch().catch(() => null)
  if (branch === null) {
    return home
  }
  const prNumber = await ctx.config.host.findOpenPr(ctx.gh, ctx.config.repo, branch).catch(() => null)
  return prNumber === null ? home : { path: `/review/${prNumber}`, prNumber }
}
