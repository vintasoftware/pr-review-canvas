import { z } from 'zod'
import { PrNotFoundError, type PrMeta } from '../host/pr.js'
import type { Repo } from '../contract/review-artifact.js'
import { type HostClient, HostCliError } from '../host/client.js'

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
  /** Null while GitHub is still computing whether the head merges cleanly. */
  mergeable: z.boolean().nullable().optional(),
  updated_at: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changed_files: z.number().int(),
  user: z.object({ login: z.string() }).nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
})

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
    mergeable: p.mergeable ?? null,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
  }
}

export async function fetchPrMeta(client: HostClient, repo: Repo, number: number): Promise<PrMeta> {
  try {
    return mapPull(await client.api(`repos/${repo.owner}/${repo.name}/pulls/${number}`))
  } catch (err) {
    if (err instanceof HostCliError && err.notFound) {
      throw new PrNotFoundError(number)
    }
    throw err
  }
}
