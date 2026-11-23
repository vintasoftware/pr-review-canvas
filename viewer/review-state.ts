// Review state in the reader's browser: the marks, dismissals, hidden threads, pending review and
// posted comments the server keeps in .pr-review/ for the local app. The rules mirror
// src/store/state-store.ts.
import type { AddPendingInput, PendingComment } from '../src/contract/pending.js'
import { emptyState, type PrState, PrStateSchema } from '../src/contract/state.js'

/** A comment posted from the page, tied to the attention point or chat proposal it came from. */
export interface PostedEntry {
  commentId: number
  pointFingerprint?: string
  proposalFingerprint?: string
}

/** The canvas a mark is made on: its commit and the merge base its diff runs from. */
export interface MarkedCanvas {
  headSha: string
  mergeBaseSha: string
}

export interface ViewerStateStore {
  read(): PrState
  /** The state with only the marks made on `canvas`: marks of another diff do not count here. */
  forCanvas(canvas: MarkedCanvas): PrState
  setReviewed(id: string, reviewed: boolean, canvas: MarkedCanvas): PrState
  setDismissed(fingerprint: string, dismissed: boolean, reason?: string): PrState
  setThreadHidden(rootCommentId: number, hidden: boolean): PrState
  addPosted(entries: readonly PostedEntry[]): PrState
  /** Keeps a draft of the pending review, written on the diff `diff`. */
  addPending(input: AddPendingInput, diff: MarkedCanvas): PrState
  editPending(id: string, body: string): PrState
  removePending(id: string): PrState
  clearPending(): PrState
  /** Moves the drafts a review carried out of the pending review, and records what they became. */
  completePending(submitted: readonly PendingComment[], posted: readonly PostedEntry[]): PrState
}

function localStore(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

const marksOn = (state: PrState, canvas: MarkedCanvas): boolean =>
  state.reviewedCanvasSha === canvas.headSha &&
  (state.reviewedMergeBaseSha === undefined || state.reviewedMergeBaseSha === canvas.mergeBaseSha)

/** `layer:<id>/file:<key>` belongs to `layer:<id>`. */
const layerOf = (id: string): string => id.split('/')[0] ?? id

export function createViewerState(
  key: string,
  opts: { storage?: Storage | null; now?: () => Date } = {}
): ViewerStateStore {
  const storage = opts.storage === undefined ? localStore() : opts.storage
  const now = opts.now ?? (() => new Date())
  const storageKey = `pr-review-viewer:state:${key}`
  let memory: PrState | null = null
  let pendingSeq = 0

  const read = (): PrState => {
    if (memory !== null) return memory
    try {
      const raw = storage?.getItem(storageKey)
      if (raw) {
        const parsed = PrStateSchema.safeParse(JSON.parse(raw))
        if (parsed.success) return (memory = parsed.data)
      }
    } catch {
      // Unreadable or blocked storage starts the review afresh.
    }
    return (memory = emptyState(now().toISOString()))
  }

  const update = (mutate: (state: PrState) => PrState): PrState => {
    const current = read()
    const changed = mutate(current)
    if (changed === current) return current
    memory = { ...changed, rev: (current.rev ?? 0) + 1, updatedAt: now().toISOString() }
    try {
      storage?.setItem(storageKey, JSON.stringify(memory))
    } catch {
      // Kept for this tab only.
    }
    return memory
  }

  return {
    read,
    forCanvas(canvas) {
      const state = read()
      return state.reviewedCanvasSha === undefined || marksOn(state, canvas)
        ? state
        : { ...state, reviewed: {} }
    },
    setReviewed: (id, reviewed, canvas) =>
      update(state => {
        const next =
          state.reviewedCanvasSha === undefined || marksOn(state, canvas) ? { ...state.reviewed } : {}
        if (reviewed) {
          next[id] = true
        } else {
          for (const marked of Object.keys(next)) {
            if (marked === id || marked.startsWith(`${id}/`) || marked === layerOf(id)) delete next[marked]
          }
        }
        return {
          ...state,
          reviewed: next,
          reviewedCanvasSha: canvas.headSha,
          reviewedMergeBaseSha: canvas.mergeBaseSha,
        }
      }),
    setDismissed: (fingerprint, dismissed, reason) =>
      update(state => {
        const next = { ...state.dismissed }
        if (dismissed) {
          const at = now().toISOString()
          next[fingerprint] = reason === undefined ? { at } : { at, reason }
        } else {
          delete next[fingerprint]
        }
        return { ...state, dismissed: next }
      }),
    setThreadHidden: (rootCommentId, hidden) =>
      update(state => {
        const next = { ...state.hiddenThreads }
        if (hidden) next[String(rootCommentId)] = { at: now().toISOString() }
        else delete next[String(rootCommentId)]
        return { ...state, hiddenThreads: next }
      }),
    addPosted: entries =>
      update(state => {
        const known = new Set(state.posted.map(p => p.commentId))
        const added = entries.filter(entry => !known.has(entry.commentId))
        if (added.length === 0) return state
        const at = now().toISOString()
        return { ...state, posted: [...state.posted, ...added.map(entry => ({ ...entry, at }))] }
      }),
    addPending: (input, diff) => {
      pendingSeq += 1
      const at = now().toISOString()
      const draft: PendingComment = {
        id: `p${now().getTime().toString(36)}-${pendingSeq.toString(36)}`,
        path: input.path,
        line: input.line,
        side: input.side,
        ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
        body: input.body,
        ...(input.pointFingerprint === undefined ? {} : { pointFingerprint: input.pointFingerprint }),
        ...(input.proposalFingerprint === undefined
          ? {}
          : { proposalFingerprint: input.proposalFingerprint }),
        headSha: diff.headSha,
        mergeBaseSha: diff.mergeBaseSha,
        createdAt: at,
        updatedAt: at,
      }
      return update(state => ({ ...state, pending: [...state.pending, draft] }))
    },
    editPending: (id, body) =>
      update(state => ({
        ...state,
        pending: state.pending.map(p => (p.id === id ? { ...p, body, updatedAt: now().toISOString() } : p)),
      })),
    removePending: id => update(state => ({ ...state, pending: state.pending.filter(p => p.id !== id) })),
    clearPending: () => update(state => ({ ...state, pending: [] })),
    completePending: (submitted, posted) =>
      update(state => {
        const at = now().toISOString()
        return {
          ...state,
          pending: state.pending.filter(p => !submitted.some(s => s.id === p.id && s.body === p.body)),
          submitted: [...state.submitted, ...submitted],
          posted: [
            ...state.posted,
            ...posted
              .filter(p => !state.posted.some(s => s.commentId === p.commentId))
              .map(p => ({ ...p, at })),
          ],
        }
      }),
  }
}
