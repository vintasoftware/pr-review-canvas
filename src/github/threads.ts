import { z } from 'zod'
import type { Repo } from '../contract/review-artifact.js'
import type { GitHubClient } from './gh.js'

const ThreadsPageSchema = z.object({
  repository: z.object({
    pullRequest: z.object({
      reviewThreads: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            isResolved: z.boolean(),
            comments: z.object({ nodes: z.array(z.object({ databaseId: z.number().int().nullable() })) }),
          })
        ),
      }),
    }),
  }),
})

export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 100) { nodes { databaseId } } }
      }
    }
  }
}`

/**
 * The ids of every review comment that sits in a resolved thread. REST has no resolved flag,
 * so this one GraphQL query is joined to the REST comments by id.
 */
export async function fetchResolvedCommentIds(gh: GitHubClient, repo: Repo, number: number): Promise<Set<number>> {
  const resolved = new Set<number>()
  let after: string | null = null
  for (;;) {
    const vars: Record<string, string | number> = {
      owner: repo.owner,
      name: repo.name,
      number,
      ...(after === null ? {} : { after }),
    }
    const page = ThreadsPageSchema.parse(await gh.graphql(THREADS_QUERY, vars))
    const threads = page.repository.pullRequest.reviewThreads
    for (const t of threads.nodes) {
      if (!t.isResolved) {
        continue
      }
      for (const c of t.comments.nodes) {
        if (c.databaseId !== null) {
          resolved.add(c.databaseId)
        }
      }
    }
    if (!threads.pageInfo.hasNextPage || threads.pageInfo.endCursor === null) {
      return resolved
    }
    after = threads.pageInfo.endCursor
  }
}
