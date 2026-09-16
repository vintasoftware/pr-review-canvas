import { z } from 'zod'
import type { Pr, Repo } from '../contract/review-artifact.js'
import type { Git } from '../git/git.js'
import { GitHubApiError, type GitHubClient } from './gh.js'

/** The subset of GitHub's pull request object the tool reads. */
const GhPullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  updated_at: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changed_files: z.number().int(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
})

export class PrNotFoundError extends Error {
  readonly number: number

  constructor(number: number) {
    super(`pull request #${number} not found`)
    this.name = 'PrNotFoundError'
    this.number = number
  }
}

export interface PrMeta {
  number: number
  title: string
  body: string
  author: string
  url: string
  state: string
  draft: boolean
  updatedAt: string
  baseRef: string
  headRef: string
  headSha: string
  /** The commit that merged the PR into its base, once merged. */
  mergeCommitSha: string | null
  additions: number
  deletions: number
  changedFiles: number
}

export function mapPull(raw: unknown): PrMeta {
  const p = GhPullSchema.parse(raw)
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    author: p.user?.login ?? 'ghost',
    url: p.html_url,
    state: p.merged === true ? 'merged' : p.state,
    draft: p.draft === true,
    updatedAt: p.updated_at,
    baseRef: p.base.ref,
    headRef: p.head.ref,
    headSha: p.head.sha,
    mergeCommitSha: p.merged === true ? (p.merge_commit_sha ?? null) : null,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
  }
}

export async function fetchPrMeta(gh: GitHubClient, repo: Repo, number: number): Promise<PrMeta> {
  try {
    return mapPull(await gh.api(`repos/${repo.owner}/${repo.name}/pulls/${number}`))
  } catch (err) {
    if (err instanceof GitHubApiError && err.notFound) {
      throw new PrNotFoundError(number)
    }
    throw err
  }
}

export function prHeadRef(number: number): string {
  return `refs/pr/${number}/head`
}

export function prBaseRef(number: number): string {
  return `refs/pr/${number}/base`
}

/**
 * Fetches the PR head and base into local refs and resolves the two commits the diff needs.
 * The refs are the same ones the prior-art skill used, so an existing clone keeps working.
 *
 * A merged PR is diffed against the base as it was at merge time: the merge commit's first
 * parent (a merge commit, a squash, or the last rebased commit all sit on the base branch, so
 * it is local once the base was fetched). Today's base tip would contain the PR and give an
 * empty diff.
 */
export async function fetchPrRefs(
  git: Git,
  meta: PrMeta
): Promise<{ headSha: string; mergeBaseSha: string }> {
  await git.fetch('origin', [
    `+pull/${meta.number}/head:${prHeadRef(meta.number)}`,
    `+refs/heads/${meta.baseRef}:${prBaseRef(meta.number)}`,
  ])
  const headSha = await git.revParse(prHeadRef(meta.number))
  const base = meta.mergeCommitSha === null ? prBaseRef(meta.number) : `${meta.mergeCommitSha}^1`
  const mergeBaseSha = await git.mergeBase(base, headSha)
  return { headSha, mergeBaseSha }
}

export function toPr(meta: PrMeta, repo: Repo, shas: { headSha: string; mergeBaseSha: string }): Pr {
  return {
    number: meta.number,
    title: meta.title,
    body: meta.body,
    author: meta.author,
    url: meta.url,
    state: meta.state,
    draft: meta.draft,
    updatedAt: meta.updatedAt,
    baseRef: meta.baseRef,
    headRef: meta.headRef,
    headSha: shas.headSha,
    mergeBaseSha: shas.mergeBaseSha,
    additions: meta.additions,
    deletions: meta.deletions,
    changedFiles: meta.changedFiles,
    repo,
  }
}
