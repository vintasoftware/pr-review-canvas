// Where a review of work that has no pull request yet takes its two commits from: the branch the
// change will be opened against, and either the tip of the current branch or a snapshot of the
// working tree as it stands.
import type { Pr, Repo } from '../contract/review-artifact.js'
import type { LocalKey } from '../contract/review-key.js'
import { type Git, GitError } from './git.js'

/** Tried in order when the user names no base: the remote's default branch first. */
export const BASE_CANDIDATES = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'] as const

/** `origin/HEAD` is a pointer, and a canvas that says `origin/main` reads better than one that
 * says the pointer's name. */
const ORIGIN_HEAD = 'origin/HEAD'

export class LocalTargetError extends Error {
  readonly hint: string

  constructor(message: string, hint: string) {
    super(message)
    this.name = 'LocalTargetError'
    this.hint = hint
  }
}

/**
 * The branch the current work will be opened against. `origin/HEAD` is the remote's own answer,
 * so it is preferred over guessing at names; a repository that never fetched it falls back to the
 * two usual ones.
 */
export async function resolveLocalBase(git: Git, override?: string | undefined): Promise<string> {
  if (override !== undefined && override !== '') {
    return override
  }
  const found = await git.firstExistingRef(BASE_CANDIDATES)
  if (found === null) {
    throw new LocalTargetError(
      'no default branch to compare against',
      'pass --base <ref>, or fetch origin so origin/HEAD resolves'
    )
  }
  if (found !== ORIGIN_HEAD) {
    return found
  }
  return (await git.symbolicRef(`refs/remotes/${ORIGIN_HEAD}`)) ?? ORIGIN_HEAD
}

export interface LocalHead {
  headSha: string
  /** The checked-out branch, or null on a detached HEAD. */
  branch: string | null
  /** True when the head is a snapshot of the working tree rather than a commit on the branch. */
  uncommitted: boolean
}

/**
 * Who the local work belongs to. Uncommitted edits are nobody's commit yet, so the name this
 * clone commits as says more than the author of whatever HEAD happens to be.
 */
export async function localAuthor(git: Git, uncommitted: boolean): Promise<string> {
  if (uncommitted) {
    const configured = await git.configuredUser()
    if (configured !== null) {
      return configured
    }
  }
  return git.commitAuthor('HEAD')
}

export interface DescribeLocalOptions {
  base: string
  source: LocalKey
  repo: Repo
  now: () => Date
}

/**
 * The local work in the shape the rest of the tool reads a pull request in. `prepare` writes it to
 * `prs/local/pr.json` and the page resolves it again on a refresh, so both have to agree on the
 * head, the title, and the words the header shows; they are decided here, once.
 *
 * The line counts are left at zero: only the collected diff knows them, and `prepare` fills them
 * in once it has one.
 */
export async function describeLocalWork(git: Git, opts: DescribeLocalOptions): Promise<Pr> {
  const head = await resolveLocalHead(git, opts.source)
  const branch = head.branch ?? 'HEAD'
  return {
    number: null,
    title: head.uncommitted ? `Uncommitted work on ${branch}` : branch,
    body: '',
    author: await localAuthor(git, head.uncommitted),
    // Nothing is pushed yet, so there is no page on the forge to link to.
    url: '',
    state: head.uncommitted ? UNCOMMITTED_STATE : BRANCH_STATE,
    draft: false,
    updatedAt: opts.now().toISOString(),
    baseRef: opts.base,
    headRef: branch,
    headSha: head.headSha,
    mergeBaseSha: await git.mergeBase(opts.base, head.headSha),
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    repo: opts.repo,
  }
}

/** What `pr.state` reads for each local review. One word, because the header paints it as a pill. */
export const BRANCH_STATE = 'branch'
export const UNCOMMITTED_STATE = 'uncommitted'

/**
 * The commit a local review describes. The `uncommitted` review snapshots the edits and the
 * untracked files into a commit of their own; when there are none, and for the `branch` review
 * always, that is the tip of the current branch.
 */
export async function resolveLocalHead(git: Git, source: LocalKey): Promise<LocalHead> {
  const branch = await git.currentBranch()
  let head: string
  try {
    head = await git.revParse('HEAD')
  } catch (err) {
    if (err instanceof GitError) {
      throw new LocalTargetError(
        'this branch has no commits yet, so there is nothing to compare against',
        'make one commit first, then run the review again'
      )
    }
    throw err
  }
  if (source === 'branch') {
    return { headSha: head, branch, uncommitted: false }
  }
  const snapshot = await git.snapshotWorktree()
  return snapshot === null
    ? { headSha: head, branch, uncommitted: false }
    : { headSha: snapshot, branch, uncommitted: true }
}
