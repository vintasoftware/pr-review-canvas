import type { AppContext } from './context.js'

/**
 * The page `<base>start` sends the browser to: the review of the open PR whose head is the
 * checked-out branch, so a project opened from a PR's worktree lands on that PR. Anything else
 * goes to the project's home page, and a failed lookup does too, with a log line.
 */
export async function startPage(ctx: AppContext, log: (line: string) => void): Promise<string> {
  const home = ctx.config.basePath
  const branch = await ctx.git.currentBranch().catch(() => null)
  if (branch === null) {
    return home
  }
  const { host, repo } = ctx.config
  try {
    const prNumber = await host.findOpenPr(ctx.gh, repo, branch)
    if (prNumber === null) {
      return home
    }
    log(`opening ${host.nounShort} #${prNumber}, the open review of this branch`)
    return `${home}review/${prNumber}`
  } catch (err) {
    log(
      `could not find the open ${host.nounShort} of ${branch} (${err instanceof Error ? err.message : String(err)}); opening the home page`
    )
    return home
  }
}
