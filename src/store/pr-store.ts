import { mkdir, realpath, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import {
  type CommentsPayload,
  CommentsPayloadSchema,
  type FetchCommentsResult,
  type PostCommentResult,
} from '../contract/comments.js'
import { type DiscoveryCache, DiscoveryCacheSchema } from '../contract/discovery.js'
import { type LocalPrepareTarget, LocalPrepareTargetSchema } from '../contract/generation-context.js'
import { isLocalKey, type LocalKey, type ReviewKey, reviewFolder } from '../contract/review-key.js'
import { type Pr, PrSchema } from '../contract/review-artifact.js'
import { readJson, readJsonOrDefault, writeJsonAtomic } from './atomic-json.js'

/** Target-keyed files: the cached PR meta and the last comments payload. */
export interface PrStore {
  prDir(key: ReviewKey): string
  readPr(key: ReviewKey): Promise<Pr | null>
  /** The key is passed in, because the local review's meta carries no number of its own. */
  writePr(key: ReviewKey, pr: Pr): Promise<void>
  readComments(number: number): Promise<CommentsPayload | null>
  /** Fetch and replace the complete snapshot under the same lock as posted updates. */
  refreshComments(number: number, fetch: () => Promise<FetchCommentsResult>): Promise<FetchCommentsResult>
  /** Acquire the cache lock before posting, then merge the returned comments. */
  postComments<T>(
    number: number,
    post: () => Promise<{ result: T; comments: ReadonlyArray<PostCommentResult> }>
  ): Promise<T>
  /** The last attachment scan, so an unchanged PR is not scanned again. */
  readDiscovery(number: number): Promise<DiscoveryCache | null>
  writeDiscovery(number: number, discovery: DiscoveryCache): Promise<void>
  /** PR numbers with a cached pr.json, newest first by file mtime. Local reviews are not ones. */
  listRecent(limit: number): Promise<Array<{ number: number; title: string; updatedAt: string }>>
  /** What this local review was last prepared for, so the page can resolve the same head again. */
  readLocalTarget(key: LocalKey): Promise<LocalPrepareTarget | null>
  writeLocalTarget(key: LocalKey, target: LocalPrepareTarget): Promise<void>
}

/**
 * `worktree` is the label of the linked worktree the store serves; null for the main checkout. A
 * pull request's files are every worktree's; a local review's are its own checkout's.
 */
export function createPrStore(repoRoot: string, worktree: string | null): PrStore {
  const prDir = (key: ReviewKey): string => {
    if (!isLocalKey(key) && (!Number.isInteger(key) || key <= 0)) {
      throw new Error(`not a pull request number: ${String(key)}`)
    }
    return path.join(repoRoot, 'prs', reviewFolder(key, worktree))
  }
  const commentsFile = (number: number) => path.join(prDir(number), 'comments.json')
  const readComments = (number: number) => readJson(commentsFile(number), CommentsPayloadSchema)
  // Like the canvas index, this cache has writers in both serve and CLI processes.
  const withCommentsLock = async <T>(number: number, write: () => Promise<T>): Promise<T> => {
    await mkdir(prDir(number), { recursive: true })
    const root = await realpath(prDir(number))
    const release = await lock(root, {
      lockfilePath: path.join(root, 'comments.json.lock'),
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    })
    try {
      return await write()
    } finally {
      await release()
    }
  }
  return {
    prDir,
    readPr: key => readJson(path.join(prDir(key), 'pr.json'), PrSchema),
    writePr: async (key, pr) => {
      if (!isLocalKey(key) && pr.number !== key) {
        throw new Error(`pull request ${String(key)} cannot hold the meta of ${String(pr.number)}`)
      }
      await writeJsonAtomic(path.join(prDir(key), 'pr.json'), pr)
    },
    readLocalTarget: key =>
      readJsonOrDefault(path.join(prDir(key), 'target.json'), LocalPrepareTargetSchema, () => null),
    writeLocalTarget: (key, target) => writeJsonAtomic(path.join(prDir(key), 'target.json'), target),
    readComments,
    refreshComments: (number, fetch) =>
      withCommentsLock(number, async () => {
        const result = await fetch()
        await writeJsonAtomic(commentsFile(number), result.payload)
        return result
      }),
    postComments: (number, post) =>
      withCommentsLock(number, async () => {
        const { result, comments: posted } = await post()
        const comments = await readComments(number)
        // With no cache, the next page load must fetch the complete forge conversation.
        if (comments === null || posted.length === 0) return result
        const reviewComments = new Map(comments.reviewComments.map(c => [c.id, c]))
        const issueComments = new Map(comments.issueComments.map(c => [c.id, c]))
        for (const entry of posted) {
          if (entry.kind === 'review') reviewComments.set(entry.comment.id, entry.comment)
          else issueComments.set(entry.comment.id, entry.comment)
        }
        await writeJsonAtomic(commentsFile(number), {
          ...comments,
          reviewComments: [...reviewComments.values()],
          issueComments: [...issueComments.values()],
        })
        return result
      }),
    readDiscovery: number =>
      readJsonOrDefault(path.join(prDir(number), 'discovery.json'), DiscoveryCacheSchema, () => null),
    writeDiscovery: (number, discovery) =>
      writeJsonAtomic(path.join(prDir(number), 'discovery.json'), discovery),
    listRecent: async limit => {
      let names: string[]
      try {
        names = await readdir(path.join(repoRoot, 'prs'))
      } catch {
        return []
      }
      const rows: Array<{ number: number; title: string; updatedAt: string; mtime: number }> = []
      for (const name of names) {
        const number = Number(name)
        if (!Number.isInteger(number) || number <= 0) {
          continue
        }
        const file = path.join(prDir(number), 'pr.json')
        // A directory without pr.json, or one written by an older tool version, is skipped.
        const pr = await readJsonOrDefault(file, PrSchema, () => null)
        if (pr === null) {
          continue
        }
        const s = await stat(file)
        rows.push({ number, title: pr.title, updatedAt: s.mtime.toISOString(), mtime: s.mtimeMs })
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      return rows.slice(0, limit).map(({ number, title, updatedAt }) => ({ number, title, updatedAt }))
    },
  }
}
