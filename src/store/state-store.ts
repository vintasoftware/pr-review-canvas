import path from 'node:path'
import type { ReviewKey } from '../contract/review-key.js'
import { emptyState, type PrState, PrStateSchema } from '../contract/state.js'
import type { AddPendingInput, PendingComment } from '../contract/pending.js'
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
   * Marks one layer or file. `canvasSha` is the commit of the canvas the page was showing: when it
   * differs from the one the marks describe, the old marks are dropped, because they were about
   * other code.
   */
  setReviewed(key: ReviewKey, id: string, reviewed: boolean, canvasSha?: string): Promise<PrState>
  setDismissed(key: ReviewKey, fingerprint: string, dismissed: boolean, reason?: string): Promise<PrState>
  setThreadHidden(key: ReviewKey, rootCommentId: number, hidden: boolean): Promise<PrState>
  addPosted(key: ReviewKey, entry: PostedEntry): Promise<PrState>
  /** Adds one comment to the pending review and returns the state that holds it. */
  addPending(key: ReviewKey, input: AddPendingInput, headSha: string): Promise<PrState>
  /** Rewrites one draft's body. A draft that is no longer there leaves the state alone. */
  editPending(key: ReviewKey, id: string, body: string): Promise<PrState>
  removePending(key: ReviewKey, id: string): Promise<PrState>
  /** Discards every draft at the reviewer's request. */
  clearPending(key: ReviewKey): Promise<PrState>
  /** Acknowledge submitted versions, preserving drafts added or edited while posting. */
  completePending(
    key: ReviewKey,
    submitted: ReadonlyArray<PendingComment>,
    posted: PostedEntry[]
  ): Promise<PrState>
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

/** Ids only have to be unique inside one state file; the clock and the counter make them so. */
function pendingId(now: () => Date, seq: number): string {
  return `p${now().getTime().toString(36)}-${seq.toString(36)}`
}

export function createStateStore(prs: PrStore, now: () => Date): StateStore {
  let pendingSeq = 0
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
    setReviewed: (key, id, reviewed, canvasSha) =>
      update(key, state => {
        const sameCanvas =
          canvasSha === undefined ||
          state.reviewedCanvasSha === undefined ||
          state.reviewedCanvasSha === canvasSha
        const next = sameCanvas ? { ...state.reviewed } : {}
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
        return canvasSha === undefined
          ? { ...state, reviewed: next }
          : { ...state, reviewed: next, reviewedCanvasSha: canvasSha }
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
    addPending: (key, input, headSha) => {
      pendingSeq += 1
      const at = now().toISOString()
      const draft: PendingComment = {
        id: pendingId(now, pendingSeq),
        path: input.path,
        line: input.line,
        side: input.side,
        ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
        body: input.body,
        ...(input.pointFingerprint === undefined ? {} : { pointFingerprint: input.pointFingerprint }),
        headSha,
        createdAt: at,
        updatedAt: at,
      }
      return update(key, state => ({ ...state, pending: [...state.pending, draft] }))
    },
    editPending: (key, id, body) =>
      update(key, state => ({
        ...state,
        pending: state.pending.map(p => (p.id === id ? { ...p, body, updatedAt: now().toISOString() } : p)),
      })),
    removePending: (key, id) =>
      update(key, state => ({ ...state, pending: state.pending.filter(p => p.id !== id) })),
    clearPending: key => update(key, state => ({ ...state, pending: [] })),
    completePending: (key, submitted, posted) =>
      update(key, state => ({
        ...state,
        pending: state.pending.filter(p => !submitted.some(s => s.id === p.id && s.body === p.body)),
        posted: [
          ...state.posted,
          ...posted
            .filter(p => !state.posted.some(s => s.commentId === p.commentId))
            .map(p => ({ ...p, at: now().toISOString() })),
        ],
      })),
  }
}
