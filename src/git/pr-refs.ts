import { type Git, GitError } from './git.js'
import type { Host } from '../host/host.js'
import type { PrMeta } from '../host/pr.js'

export function prHeadRef(number: number): string {
  return `refs/pr/${number}/head`
}

export function prBaseRef(number: number): string {
  return `refs/pr/${number}/base`
}

/** True when a fetch failed because the remote has no branch of that name any more. */
function isMissingRemoteRef(err: unknown, branch: string): boolean {
  return err instanceof GitError && err.stderr.includes(`couldn't find remote ref refs/heads/${branch}`)
}

/**
 * Fetches the review's head and base into local refs and resolves the two commits the diff needs.
 * The local refs are the ones the prior-art skill used, so an existing clone keeps working, and
 * they are the same for both hosts; only the remote ref that holds the head differs.
 *
 * A merged PR is diffed against the base as it was at merge time: the merge commit's first
 * parent (a merge commit, a squash, or the last rebased commit all sit on the base branch, so
 * it is local once the base was fetched). Today's base tip would contain the PR and give an
 * empty diff.
 */
export async function fetchPrRefs(
  git: Git,
  host: Host,
  meta: PrMeta
): Promise<{ headSha: string; mergeBaseSha: string }> {
  const head = `+${host.remoteHeadRef(meta.number)}:${prHeadRef(meta.number)}`
  try {
    await git.fetch('origin', [head, `+refs/heads/${meta.baseRef}:${prBaseRef(meta.number)}`])
  } catch (err) {
    // A merged PR whose base branch was deleted since, as a stacked PR's is once the PR below it
    // merges. Its diff needs only the merge commit, which the forge still serves by its sha.
    if (meta.mergeCommitSha === null || !isMissingRemoteRef(err, meta.baseRef)) {
      throw err
    }
    await git.fetch('origin', [head, meta.mergeCommitSha])
  }
  const headSha = await git.revParse(prHeadRef(meta.number))
  const base = meta.mergeCommitSha === null ? prBaseRef(meta.number) : `${meta.mergeCommitSha}^1`
  const mergeBaseSha = await git.mergeBase(base, headSha)
  return { headSha, mergeBaseSha }
}
