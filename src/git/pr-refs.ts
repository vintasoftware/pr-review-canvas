import type { Git } from './git.js'
import type { Host } from '../host/host.js'
import type { PrMeta } from '../host/pr.js'

export function prHeadRef(number: number): string {
  return `refs/pr/${number}/head`
}

export function prBaseRef(number: number): string {
  return `refs/pr/${number}/base`
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
  await git.fetch('origin', [
    `+${host.remoteHeadRef(meta.number)}:${prHeadRef(meta.number)}`,
    `+refs/heads/${meta.baseRef}:${prBaseRef(meta.number)}`,
  ])
  const headSha = await git.revParse(prHeadRef(meta.number))
  const base = meta.mergeCommitSha === null ? prBaseRef(meta.number) : `${meta.mergeCommitSha}^1`
  const mergeBaseSha = await git.mergeBase(base, headSha)
  return { headSha, mergeBaseSha }
}
