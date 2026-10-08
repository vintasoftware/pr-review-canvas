import type { AppContext } from './context.js'

/**
 * The open PR whose head is the checked-out branch: null when there is none or HEAD is detached.
 * A failed lookup throws, so the caller can say why. The `start` page and `pr-review generate`
 * with no target both go by it.
 */
export async function branchPr(ctx: AppContext): Promise<number | null> {
  const branch = await ctx.git.currentBranch().catch(() => null)
  return branch === null ? null : ctx.config.host.findOpenPr(ctx.gh, ctx.config.repo, branch)
}

/**
 * The page `<base>start` sends the browser to: the review of the open PR whose head is the
 * checked-out branch, so a project opened from a PR's worktree lands on that PR. Anything else
 * goes to the project's home page, and a failed lookup does too, with a log line.
 */
export async function startPage(ctx: AppContext, log: (line: string) => void): Promise<string> {
  const home = ctx.config.basePath
  const { nounShort } = ctx.config.host
  let prNumber: number | null
  try {
    prNumber = await branchPr(ctx)
  } catch (err) {
    log(
      `could not find the open ${nounShort} of the checked-out branch (${err instanceof Error ? err.message : String(err)}); opening the home page`
    )
    return home
  }
  if (prNumber === null) {
    return home
  }
  log(`opening ${nounShort} #${prNumber}, the open review of this branch`)
  return `${home}review/${prNumber}`
}
