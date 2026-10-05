import type { AppContext } from './context.js'

/**
 * The page the browser opens at startup: the review of the open PR whose head is the checked-out
 * branch, so a server started in a PR's worktree lands on that PR. Anything else opens the home
 * page, and a failed lookup does too, with a log line: the server runs either way.
 */
export async function startPage(ctx: AppContext, log: (line: string) => void): Promise<string> {
  const branch = await ctx.git.currentBranch().catch(() => null)
  if (branch === null) {
    return '/'
  }
  const { host, repo } = ctx.config
  try {
    const prNumber = await host.findOpenPr(ctx.gh, repo, branch)
    if (prNumber === null) {
      return '/'
    }
    log(`opening ${host.nounShort} #${prNumber}, the open review of this branch`)
    return `/review/${prNumber}`
  } catch (err) {
    log(
      `could not find the open ${host.nounShort} of ${branch} (${err instanceof Error ? err.message : String(err)}); opening the home page`
    )
    return '/'
  }
}
