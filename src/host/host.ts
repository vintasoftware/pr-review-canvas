import { shareGithubCanvas } from '../github/canvas-comment.js'
import { shareGitlabCanvas } from '../gitlab/canvas-comment.js'
import type { Capabilities, PublicHost, ReviewSummary } from '../contract/api.js'
import type { FetchCommentsResult, PostCommentInput, PostCommentResult } from '../contract/comments.js'
import type { Repo } from '../contract/review-artifact.js'
import { GITHUB_ATTACHMENTS } from '../github/attachments.js'
import { probeCapabilities } from '../github/capabilities.js'
import { fetchComments } from '../github/comments.js'
import { postComment } from '../github/post-comment.js'
import type { PendingComment } from '../contract/pending.js'
import type { ReviewEvent } from '../contract/reviews.js'
import { postReview } from '../github/post-review.js'
import { fetchPrMeta } from '../github/pr.js'
import type { PrMeta } from './pr.js'
import { gitlabAttachments } from '../gitlab/attachments.js'
import { probeGitlabCapabilities } from '../gitlab/capabilities.js'
import { fetchGitlabComments } from '../gitlab/comments.js'
import { fetchMrMeta } from '../gitlab/mr.js'
import { postGitlabComment } from '../gitlab/post-comment.js'
import { postGitlabReview } from '../gitlab/post-review.js'
import type { Derived } from '../store/derived-store.js'
import type { AttachmentLink } from './attachments.js'
import { GH_CLI, glabCli, type HostClient, type HostCliSpec } from './client.js'

export type HostKind = PublicHost['kind']

/** How canvas zips attached to a review are found and fetched on one forge. */
export interface HostAttachments {
  /** Zip links in one markdown text, as absolute URLs this host serves. */
  findLinks(text: string, repo: Repo): AttachmentLink[]
  /** Where an attachment may be served from. Everything else is refused before any request. */
  allowedHosts: ReadonlySet<string>
  /** The header that carries the CLI token to the forge itself; a storage redirect gets none. */
  authHeader(token: string): Record<string, string>
}

/**
 * One forge: the words the page uses for it, the CLI that talks to it, and every operation whose
 * request or answer differs between GitHub and GitLab. Everything that is the same for both (the
 * local refs, the stored Pr, the download loop, the routes) takes a Host and never asks its kind.
 */
export interface Host {
  kind: HostKind
  hostname: string
  /** `GitHub` or `GitLab`, for messages. */
  label: string
  cli: HostCliSpec
  webBase: string
  /** `pull request` or `merge request`, and its abbreviation. */
  noun: string
  nounShort: string
  /** The remote ref that holds a review's head, fetched into the same local ref for both hosts. */
  remoteHeadRef(number: number): string
  compareUrl(repo: Repo, base: string, head: string): string
  fetchPrMeta(client: HostClient, repo: Repo, number: number): Promise<PrMeta>
  fetchComments(
    client: HostClient,
    repo: Repo,
    number: number,
    headSha: string,
    now: () => Date
  ): Promise<FetchCommentsResult>
  /** GitLab needs the diff for renamed paths and both coordinates of context lines. */
  postComment(
    client: HostClient,
    repo: Repo,
    number: number,
    headSha: string,
    input: PostCommentInput,
    diff: Derived
  ): Promise<PostCommentResult>
  /**
   * Submits the review, with the comments the reviewer had waiting. GitHub takes them in the one
   * call that creates the review; GitLab posts them itself before the verdict, which is why the
   * diff is passed here too.
   */
  postReview(
    client: HostClient,
    repo: Repo,
    number: number,
    headSha: string,
    input: { event: ReviewEvent; body: string; comments?: ReadonlyArray<PendingComment> },
    diff: Derived
  ): Promise<ReviewSummary>
  probeCapabilities(client: HostClient, repo: Repo): Promise<Capabilities>
  canvasCommentLimit: number
  shareCanvas(client: HostClient, repo: Repo, number: number, body: string): Promise<string>
  attachments: HostAttachments
}

export const GITHUB_HOST: Host = {
  kind: 'github',
  hostname: 'github.com',
  label: 'GitHub',
  cli: GH_CLI,
  webBase: 'https://github.com',
  noun: 'pull request',
  nounShort: 'PR',
  remoteHeadRef: number => `pull/${number}/head`,
  compareUrl: (repo, base, head) => `https://github.com/${repo.owner}/${repo.name}/compare/${base}...${head}`,
  fetchPrMeta,
  fetchComments,
  postComment,
  postReview,
  probeCapabilities,
  canvasCommentLimit: 65_536,
  shareCanvas: shareGithubCanvas,
  attachments: GITHUB_ATTACHMENTS,
}

/** A GitLab instance. `hostname` is gitlab.com or the self-hosted instance the origin names. */
export function gitlabHost(hostname: string): Host {
  const webUrl = new URL(`https://${hostname}`)
  hostname = webUrl.host
  const webBase = webUrl.origin
  return {
    kind: 'gitlab',
    hostname,
    label: 'GitLab',
    cli: glabCli(hostname),
    webBase,
    noun: 'merge request',
    nounShort: 'MR',
    remoteHeadRef: number => `merge-requests/${number}/head`,
    compareUrl: (repo, base, head) => `${webBase}/${repo.owner}/${repo.name}/-/compare/${base}...${head}`,
    fetchPrMeta: fetchMrMeta,
    fetchComments: (client, repo, number, headSha, now) =>
      fetchGitlabComments(client, repo, number, headSha, now, webBase),
    postComment: (client, repo, number, headSha, input, diff) =>
      postGitlabComment(client, repo, number, headSha, input, { webBase, ...diff }),
    postReview: (client, repo, number, headSha, input, diff) =>
      postGitlabReview(client, repo, number, headSha, input, webBase, diff),
    probeCapabilities: probeGitlabCapabilities,
    canvasCommentLimit: 1_000_000,
    shareCanvas: (client, repo, number, body) => shareGitlabCanvas(client, repo, number, body, webBase),
    attachments: gitlabAttachments(hostname, webBase),
  }
}

/** The part of a Host the page and the health endpoint are told. */
export function publicHost(host: Host): PublicHost {
  return { kind: host.kind, label: host.label, webBase: host.webBase }
}
