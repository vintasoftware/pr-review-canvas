import path from 'node:path'
import { emptyState, type PrState, PrStateSchema } from '../contract/state.js'
import { readJsonOrDefault, writeJsonAtomic } from './atomic-json.js'
import type { PrStore } from './pr-store.js'

/** What the canvas posted to GitHub, so the sign-off body can list it. */
export interface PostedEntry {
  commentId: number
  pointFingerprint?: string
}

/** Per-PR local state: reviewed cards, dismissed points, hidden threads, posted comments. */
export interface StateStore {
  /** Defaults when the file is missing or does not match the schema (an older tool version wrote it). */
  read(number: number): Promise<PrState>
  /**
   * Read, change, write. Calls for the same PR run one after another, so two requests that
   * arrive together both land instead of one overwriting the other.
   */
  update(number: number, mutate: (state: PrState) => PrState): Promise<PrState>
  /**
   * Marks one layer or file. `headSha` is the commit of the canvas the page was showing: when it
   * differs from the one the marks describe, the old marks are dropped, because they were about
   * other code.
   */
  setReviewed(number: number, id: string, reviewed: boolean, headSha?: string): Promise<PrState>
  setDismissed(number: number, fingerprint: string, dismissed: boolean, reason?: string): Promise<PrState>
  setThreadHidden(number: number, rootCommentId: number, hidden: boolean): Promise<PrState>
  addPosted(number: number, entry: PostedEntry): Promise<PrState>
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
  const file = (number: number): string => path.join(prs.prDir(number), 'state.json')
  const read = (number: number): Promise<PrState> =>
    readJsonOrDefault(file(number), PrStateSchema, () => emptyState(now().toISOString()))

  /** One chain per PR number; each update waits for the one before it. */
  const chains = new Map<number, Promise<unknown>>()

  const update = (number: number, mutate: (state: PrState) => PrState): Promise<PrState> => {
    const run = async (): Promise<PrState> => {
      const current = await read(number)
      // Every write counts up, so the page can tell which of two answers was written later.
      const next = { ...mutate(current), rev: (current.rev ?? 0) + 1, updatedAt: now().toISOString() }
      await writeJsonAtomic(file(number), next)
      return next
    }
    const chained = (chains.get(number) ?? Promise.resolve()).then(run, run)
    // The chain only orders the calls, so a failed update never blocks the next one.
    chains.set(
      number,
      chained.catch(() => undefined)
    )
    return chained
  }

  return {
    read,
    update,
    setReviewed: (number, id, reviewed, headSha) =>
      update(number, state => {
        const sameHead =
          headSha === undefined || state.reviewedHeadSha === undefined || state.reviewedHeadSha === headSha
        const next = sameHead ? { ...state.reviewed } : {}
        if (reviewed) {
          next[id] = true
        } else {
          for (const key of Object.keys(next)) {
            // Reopening a layer reopens its files, and reopening a file reopens its layer:
            // both readings of "reviewed" have to agree.
            if (key === id || key.startsWith(`${id}/`) || key === layerOf(id)) {
              delete next[key]
            }
          }
        }
        return headSha === undefined
          ? { ...state, reviewed: next }
          : { ...state, reviewed: next, reviewedHeadSha: headSha }
      }),
    setDismissed: (number, fingerprint, dismissed, reason) =>
      update(number, state => {
        const next = { ...state.dismissed }
        if (dismissed) {
          next[fingerprint] =
            reason === undefined ? { at: now().toISOString() } : { at: now().toISOString(), reason }
        } else {
          delete next[fingerprint]
        }
        return { ...state, dismissed: next }
      }),
    setThreadHidden: (number, rootCommentId, hidden) =>
      update(number, state => {
        const next = { ...state.hiddenThreads }
        if (hidden) {
          next[String(rootCommentId)] = { at: now().toISOString() }
        } else {
          delete next[String(rootCommentId)]
        }
        return { ...state, hiddenThreads: next }
      }),
    addPosted: (number, entry) =>
      update(number, state => {
        if (state.posted.some(p => p.commentId === entry.commentId)) {
          return state
        }
        const posted = { ...entry, at: now().toISOString() }
        return { ...state, posted: [...state.posted, posted] }
      }),
  }
}
