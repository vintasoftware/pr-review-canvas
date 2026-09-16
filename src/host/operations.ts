import type { Capabilities, ReviewSummary } from '../contract/api.js'
import type { PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { FileEntry, Pr, Repo } from '../contract/review-artifact.js'
import type { Git } from '../git/git.js'
import { probeCapabilities } from '../github/capabilities.js'
import { fetchComments, type FetchCommentsResult } from '../github/comments.js'
import type { GitHubClient } from '../github/gh.js'
import { postComment as postGithubComment } from '../github/post-comment.js'
import { type ReviewEvent, postReview as postGithubReview } from '../github/post-review.js'
import {
  fetchPrMeta as fetchGithubPrMeta,
  fetchPrRefs as fetchGithubPrRefs,
  type PrMeta as GithubPrMeta,
  toPr as githubToPr,
} from '../github/pr.js'
import { probeGitlabCapabilities } from '../gitlab/capabilities.js'
import { fetchGitlabComments } from '../gitlab/comments.js'
import { fetchMrMeta, fetchMrRefs, type PrMeta as GitlabPrMeta } from '../gitlab/mr.js'
import { postGitlabComment } from '../gitlab/post-comment.js'
import { postGitlabReview } from '../gitlab/post-review.js'
import type { HostInfo } from './host.js'

export type PrMeta = GithubPrMeta | GitlabPrMeta

export async function fetchPrMeta(
  client: GitHubClient,
  host: HostInfo,
  repo: Repo,
  number: number
): Promise<PrMeta> {
  return host.kind === 'gitlab' ? fetchMrMeta(client, repo, number) : fetchGithubPrMeta(client, repo, number)
}

export async function fetchPrRefs(
  git: Git,
  host: HostInfo,
  meta: PrMeta
): Promise<{ headSha: string; mergeBaseSha: string }> {
  return host.kind === 'gitlab' ? fetchMrRefs(git, meta) : fetchGithubPrRefs(git, meta)
}

export function toPr(meta: PrMeta, repo: Repo, shas: { headSha: string; mergeBaseSha: string }): Pr {
  return githubToPr(meta, repo, shas)
}

export async function fetchHostComments(
  client: GitHubClient,
  host: HostInfo,
  repo: Repo,
  number: number,
  headSha: string,
  now: () => Date
): Promise<FetchCommentsResult> {
  return host.kind === 'gitlab'
    ? fetchGitlabComments(client, repo, number, headSha, now, host.webBase)
    : fetchComments(client, repo, number, headSha, now)
}

export async function postHostComment(
  client: GitHubClient,
  host: HostInfo,
  repo: Repo,
  number: number,
  headSha: string,
  input: PostCommentInput,
  files?: ReadonlyArray<FileEntry>
): Promise<PostCommentResult> {
  return host.kind === 'gitlab'
    ? postGitlabComment(client, repo, number, headSha, input, {
        webBase: host.webBase,
        ...(files === undefined ? {} : { files }),
      })
    : postGithubComment(client, repo, number, headSha, input)
}

export async function postHostReview(
  client: GitHubClient,
  host: HostInfo,
  repo: Repo,
  number: number,
  headSha: string,
  input: { event: ReviewEvent; body: string }
): Promise<ReviewSummary> {
  return host.kind === 'gitlab'
    ? postGitlabReview(client, repo, number, headSha, input, host.webBase)
    : postGithubReview(client, repo, number, headSha, input)
}

export async function probeHostCapabilities(
  client: GitHubClient,
  host: HostInfo,
  repo: Repo
): Promise<Capabilities> {
  return host.kind === 'gitlab' ? probeGitlabCapabilities(client, repo) : probeCapabilities(client, repo)
}
