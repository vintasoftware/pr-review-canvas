import type { Pr, Repo } from '../contract/review-artifact.js'

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
