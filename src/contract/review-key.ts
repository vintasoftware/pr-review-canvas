import { z } from 'zod'

/**
 * The two reviews of work that has no pull request yet. They are separate targets, so reviewing a
 * branch does not disturb the review of what is not committed, and each keeps its own progress
 * marks and chat threads.
 */
export const LOCAL_KEYS = ['branch', 'uncommitted'] as const

/** The current branch against the base it will be opened against, uncommitted edits left out. */
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
