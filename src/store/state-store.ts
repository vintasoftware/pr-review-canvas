import path from 'node:path'
import type { ReviewKey } from '../contract/review-key.js'
import { emptyState, type PrState, PrStateSchema } from '../contract/state.js'
import { readJsonOrDefault, writeJsonAtomic } from './atomic-json.js'
import type { PrStore } from './pr-store.js'

/** What the canvas posted to GitHub, so the sign-off body can list it. */
export interface PostedEntry {
  commentId: number
  pointFingerprint?: string
}

/** Per-target local state: reviewed cards, dismissed points, hidden threads, posted comments. */
export interface StateStore {
  /** Defaults when the file is missing or does not match the schema (an older tool version wrote it). */
  read(key: ReviewKey): Promise<PrState>
  /**
   * Read, change, write. Calls for the same target run one after another, so two requests that
   * arrive together both land instead of one overwriting the other.
   */
  update(key: ReviewKey, mutate: (state: PrState) => PrState): Promise<PrState>
  /**
   * Marks one layer or file. `headSha` is the commit the page was showing: when it differs from
   * the one the marks describe, the old marks are dropped, because they were about other code.
   */
  setReviewed(key: ReviewKey, id: string, reviewed: boolean, headSha?: string): Promise<PrState>
  setDismissed(key: ReviewKey, fingerprint: string, dismissed: boolean, reason?: string): Promise<PrState>
  setThreadHidden(key: ReviewKey, rootCommentId: number, hidden: boolean): Promise<PrState>
  addPosted(key: ReviewKey, entry: PostedEntry): Promise<PrState>
}

/** `layer:<id>` or `layer:<id>/file:<key>`, with the ids and keys the artifact uses. */
const REVIEWED_ID_RE = /^layer:[A-Za-z0-9_-]+(?:\/file:[A-Za-z0-9_]+)?$/

export function isReviewedId(id: string): boolean {
  return REVIEWED_ID_RE.test(id)
}

/** `layer:<id>` for both a layer id and one of its file ids. */
function layerOf(id: string): string {
  const at = id.indexOf('/file:')
  return at === -1 ? id : id.slice(0, at)
}

export function createStateStore(prs: PrStore, now: () => Date): StateStore {
  const file = (key: ReviewKey): string => path.join(prs.prDir(key), 'state.json')
  const read = (key: ReviewKey): Promise<PrState> =>
    readJsonOrDefault(file(key), PrStateSchema, () => emptyState(now().toISOString()))

  /** One chain per target; each update waits for the one before it. */
  const chains = new Map<ReviewKey, Promise<unknown>>()

  const update = (key: ReviewKey, mutate: (state: PrState) => PrState): Promise<PrState> => {
    const run = async (): Promise<PrState> => {
      const current = await read(key)
      // Every write counts up, so the page can tell which of two answers was written later.
      const next = { ...mutate(current), rev: (current.rev ?? 0) + 1, updatedAt: now().toISOString() }
      await writeJsonAtomic(file(key), next)
      return next
    }
    const chained = (chains.get(key) ?? Promise.resolve()).then(run, run)
    // The chain only orders the calls, so a failed update never blocks the next one.
    chains.set(
      key,
      chained.catch(() => undefined)
    )
    return chained
  }

  return {
    read,
    update,
    setReviewed: (key, id, reviewed, headSha) =>
      update(key, state => {
        const sameHead =
          headSha === undefined || state.reviewedHeadSha === undefined || state.reviewedHeadSha === headSha
        const next = sameHead ? { ...state.reviewed } : {}
        if (reviewed) {
          next[id] = true
        } else {
          for (const marked of Object.keys(next)) {
            // Reopening a layer reopens its files, and reopening a file reopens its layer:
            // both readings of "reviewed" have to agree.
            if (marked === id || marked.startsWith(`${id}/`) || marked === layerOf(id)) {
              delete next[marked]
            }
          }
        }
        return headSha === undefined
          ? { ...state, reviewed: next }
          : { ...state, reviewed: next, reviewedHeadSha: headSha }
      }),
    setDismissed: (key, fingerprint, dismissed, reason) =>
      update(key, state => {
        const next = { ...state.dismissed }
        if (dismissed) {
          next[fingerprint] =
            reason === undefined ? { at: now().toISOString() } : { at: now().toISOString(), reason }
        } else {
          delete next[fingerprint]
        }
        return { ...state, dismissed: next }
      }),
    setThreadHidden: (key, rootCommentId, hidden) =>
      update(key, state => {
        const next = { ...state.hiddenThreads }
        if (hidden) {
          next[String(rootCommentId)] = { at: now().toISOString() }
        } else {
          delete next[String(rootCommentId)]
        }
        return { ...state, hiddenThreads: next }
      }),
    addPosted: (key, entry) =>
      update(key, state => {
        if (state.posted.some(p => p.commentId === entry.commentId)) {
          return state
        }
        const posted = { ...entry, at: now().toISOString() }
        return { ...state, posted: [...state.posted, posted] }
      }),
  }
}
