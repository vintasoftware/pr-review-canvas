import { z } from 'zod'

/**
 * The two reviews of work that has no pull request yet. They are separate targets, so reviewing a
 * branch does not disturb the review of what is not committed, and each keeps its own progress
 * marks and chat threads.
 */
export const LOCAL_KEYS = ['branch', 'uncommitted'] as const

/**
 * Which local review: `branch` is the current branch against the base it will be opened against,
 * uncommitted edits left out; `uncommitted` is that branch with the working tree on top.
 */
export type LocalKey = (typeof LOCAL_KEYS)[number]

/**
 * What a canvas, its review state, and its chat threads are filed under: a pull request or merge
 * request number, or one of the local reviews. It is also what the URLs carry, so `/review/12`
 * and `/review/uncommitted` are the same page over different targets.
 */
export type ReviewKey = number | LocalKey

export const LocalKeySchema = z.enum(LOCAL_KEYS)
export const ReviewKeySchema = z.union([LocalKeySchema, z.number().int().positive()])

export function isLocalKey(key: ReviewKey): key is LocalKey {
  return LOCAL_KEYS.some(local => local === key)
}

/** The key as it appears in a URL segment and as a directory name. */
export function keyToString(key: ReviewKey): string {
  return String(key)
}

/** What separates a linked worktree's label from the name it qualifies: a slug, a review folder. */
export const WORKTREE_MARK = '~'

/**
 * The name a review's files go by in its clone's data dir. A pull request is the same review in
 * every worktree of the clone, so its number is its name. A local review is the work of one
 * checkout, so a linked worktree's carries the worktree's label, as the checkout's slug does; the
 * main checkout's keeps the bare key.
 */
export function reviewFolder(key: ReviewKey, worktree: string | null): string {
  return isLocalKey(key) && worktree !== null ? `${key}${WORKTREE_MARK}${worktree}` : keyToString(key)
}

/** The review and the worktree a folder name stands for; null for a name that is neither. */
export function parseReviewFolder(name: string): { key: ReviewKey; worktree: string | null } | null {
  const cut = name.indexOf(WORKTREE_MARK)
  const key = parseReviewKey(cut === -1 ? name : name.slice(0, cut))
  if (key === null) {
    return null
  }
  if (cut === -1) {
    return { key, worktree: null }
  }
  const worktree = name.slice(cut + 1)
  return isLocalKey(key) && worktree !== '' ? { key, worktree } : null
}

/** What the page calls the target, for a title or a heading. */
export function keyLabel(key: ReviewKey): string {
  if (key === 'branch') {
    return 'Branch review'
  }
  return key === 'uncommitted' ? 'Uncommitted work' : `#${String(key)}`
}

/** The key a URL segment names, or null when it names none of them. */
export function parseReviewKey(raw: string): ReviewKey | null {
  const local = LocalKeySchema.safeParse(raw)
  if (local.success) {
    return local.data
  }
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}
