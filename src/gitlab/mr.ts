import { z } from 'zod'
import type { Pr, Repo } from '../contract/review-artifact.js'
import type { Git } from '../git/git.js'
import { GitHubApiError, type GitHubClient } from '../github/gh.js'
import { PrNotFoundError, prBaseRef, prHeadRef } from '../github/pr.js'
import { GitLabApiError } from './glab.js'
import { gitlabProjectApi } from './project.js'

const GlMergeRequestSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  updated_at: z.string(),
  merge_commit_sha: z.string().nullable().optional(),
  target_branch: z.string(),
  source_branch: z.string(),
  sha: z.string().optional(),
  author: z.object({ username: z.string() }).nullable().optional(),
  diff_refs: z
    .object({
      base_sha: z.string(),
      head_sha: z.string(),
      start_sha: z.string(),
    })
    .nullable()
    .optional(),
  changes_count: z.union([z.string(), z.number()]).optional(),
})

const DiffStatsSchema = z.object({
  project: z
    .object({
      mergeRequest: z
        .object({
          diffStatsSummary: z
            .object({
              additions: z.number().int(),
              deletions: z.number().int(),
              fileCount: z.number().int(),
            })
            .nullable()
            .optional(),
        })
        .nullable(),
    })
    .nullable(),
})

export const MR_STATS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      diffStatsSummary { additions deletions fileCount }
    }
  }
}`

export interface MrDiffRefs {
  baseSha: string
  startSha: string
  headSha: string
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
  mergeCommitSha: string | null
  additions: number
  deletions: number
  changedFiles: number
  diffRefs?: MrDiffRefs
}

function mapState(state: string): string {
  if (state === 'opened') {
    return 'open'
  }
  if (state === 'locked') {
    return 'closed'
  }
  return state
}

export function mapMergeRequest(
  raw: unknown,
  stats: { additions: number; deletions: number; changedFiles: number }
): PrMeta {
  const m = GlMergeRequestSchema.parse(raw)
  const diffRefs = m.diff_refs
  const headSha = diffRefs?.head_sha ?? m.sha ?? ''
  const meta: PrMeta = {
    number: m.iid,
    title: m.title,
    body: m.description ?? '',
    author: m.author?.username ?? 'ghost',
    url: m.web_url,
    state: mapState(m.state),
    draft: m.draft === true || m.work_in_progress === true,
    updatedAt: m.updated_at,
    baseRef: m.target_branch,
    headRef: m.source_branch,
    headSha,
    mergeCommitSha: m.state === 'merged' ? (m.merge_commit_sha ?? null) : null,
    additions: stats.additions,
    deletions: stats.deletions,
    changedFiles: stats.changedFiles,
  }
  if (diffRefs !== undefined && diffRefs !== null) {
    meta.diffRefs = { baseSha: diffRefs.base_sha, startSha: diffRefs.start_sha, headSha: diffRefs.head_sha }
  }
  return meta
}

async function fetchDiffStats(
  client: GitHubClient,
  repo: Repo,
  iid: number
): Promise<{ additions: number; deletions: number; changedFiles: number }> {
  try {
    const page = DiffStatsSchema.parse(
      await client.graphql(MR_STATS_QUERY, { path: `${repo.owner}/${repo.name}`, iid: String(iid) })
    )
    const summary = page.project?.mergeRequest?.diffStatsSummary
    if (summary === undefined || summary === null) {
      return { additions: 0, deletions: 0, changedFiles: 0 }
    }
    return { additions: summary.additions, deletions: summary.deletions, changedFiles: summary.fileCount }
  } catch {
    return { additions: 0, deletions: 0, changedFiles: 0 }
  }
}

export async function fetchMrMeta(client: GitHubClient, repo: Repo, number: number): Promise<PrMeta> {
  const path = `${gitlabProjectApi(repo)}/merge_requests/${number}`
  try {
    const raw = await client.api(path)
    const parsed = GlMergeRequestSchema.parse(raw)
    const fromCount =
      parsed.changes_count === undefined
        ? 0
        : typeof parsed.changes_count === 'number'
          ? parsed.changes_count
          : Number.parseInt(parsed.changes_count, 10) || 0
    const stats = await fetchDiffStats(client, repo, number)
    return mapMergeRequest(raw, {
      additions: stats.additions,
      deletions: stats.deletions,
      changedFiles: stats.changedFiles || fromCount,
    })
  } catch (err) {
    if ((err instanceof GitLabApiError || err instanceof GitHubApiError) && err.notFound) {
      throw new PrNotFoundError(number)
    }
    throw err
  }
}

/**
 * Same local refs as GitHub (`refs/pr/<n>/…`) so the rest of the tool does not branch. The remote
 * spec is GitLab's merge-request head.
 */
export async function fetchMrRefs(
  git: Git,
  meta: PrMeta
): Promise<{ headSha: string; mergeBaseSha: string }> {
  await git.fetch('origin', [
    `+merge-requests/${meta.number}/head:${prHeadRef(meta.number)}`,
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
