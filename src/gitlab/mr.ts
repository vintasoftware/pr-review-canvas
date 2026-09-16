import { z } from 'zod'
import type { Repo } from '../contract/review-artifact.js'
import { type PrMeta, PrNotFoundError } from '../host/pr.js'
import { type HostClient, HostCliError } from '../host/client.js'
import { gitlabProjectApi } from './project.js'

/** The subset of GitLab's merge request object the tool reads. */
const GlMergeRequestSchema = z.object({
  iid: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  web_url: z.string(),
  state: z.enum(['opened', 'closed', 'locked', 'merged']),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  merge_commit_sha: z.string().nullable().optional(),
  target_branch: z.string(),
  source_branch: z.string(),
  sha: z.string(),
  /** The number of changed files, which REST reports as a string ("7" or "1000+"). */
  changes_count: z.string().nullable().optional(),
  author: z.object({ username: z.string() }).nullable(),
  diff_refs: z
    .object({ base_sha: z.string(), head_sha: z.string(), start_sha: z.string() })
    .nullable()
    .optional(),
})

/** Line counts live in GraphQL only; REST has the file count. */
export const MR_STATS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      diffStatsSummary { additions deletions }
    }
  }
}`

const DiffStatsSchema = z.object({
  project: z
    .object({
      mergeRequest: z
        .object({
          diffStatsSummary: z.object({ additions: z.number().int(), deletions: z.number().int() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
})

/** The three commits GitLab anchors an inline comment to. */
export type MrDiffRefs = NonNullable<z.infer<typeof GlMergeRequestSchema>['diff_refs']>

const STATES: Record<z.infer<typeof GlMergeRequestSchema>['state'], string> = {
  opened: 'open',
  closed: 'closed',
  locked: 'closed',
  merged: 'merged',
}

export function mapMergeRequest(raw: unknown, stats: { additions: number; deletions: number }): PrMeta {
  const m = GlMergeRequestSchema.parse(raw)
  return {
    number: m.iid,
    title: m.title,
    body: m.description ?? '',
    author: m.author?.username ?? 'ghost',
    url: m.web_url,
    state: STATES[m.state],
    draft: m.draft === true,
    updatedAt: m.updated_at,
    baseRef: m.target_branch,
    headRef: m.source_branch,
    headSha: m.diff_refs?.head_sha ?? m.sha,
    mergeCommitSha: m.state === 'merged' ? (m.merge_commit_sha ?? null) : null,
    additions: stats.additions,
    deletions: stats.deletions,
    changedFiles: Number.parseInt(m.changes_count ?? '0', 10) || 0,
  }
}

async function fetchMr(client: HostClient, repo: Repo, number: number): Promise<unknown> {
  try {
    return await client.api(`${gitlabProjectApi(repo)}/merge_requests/${number}`)
  } catch (err) {
    if (err instanceof HostCliError && err.notFound) {
      throw new PrNotFoundError(number)
    }
    throw err
  }
}

/**
 * The merge request as a PrMeta. The line counts are a separate GraphQL query; an instance that
 * refuses it still gets a review, with the header showing +0 −0.
 */
export async function fetchMrMeta(client: HostClient, repo: Repo, number: number): Promise<PrMeta> {
  const [raw, stats] = await Promise.all([
    fetchMr(client, repo, number),
    client
      .graphql(MR_STATS_QUERY, { path: `${repo.owner}/${repo.name}`, iid: String(number) })
      .then(page => DiffStatsSchema.parse(page).project?.mergeRequest?.diffStatsSummary ?? null)
      .catch(() => null),
  ])
  return mapMergeRequest(raw, stats ?? { additions: 0, deletions: 0 })
}

/** The refs an inline comment is positioned against, read live so they name the current head. */
export async function fetchMrDiffRefs(client: HostClient, repo: Repo, number: number): Promise<MrDiffRefs> {
  const m = GlMergeRequestSchema.parse(await fetchMr(client, repo, number))
  const refs = m.diff_refs
  if (refs === undefined || refs === null) {
    throw new Error(`merge request !${number} reports no diff refs; GitLab may still be computing its diff`)
  }
  return refs
}
