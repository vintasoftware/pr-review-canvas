// Review state in the reader's browser: the marks, dismissals and hidden threads the server keeps
// in .pr-review/ for the local app. The rules mirror src/store/state-store.ts.
import { emptyState, type PrState, PrStateSchema } from '../src/contract/state.js'

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
  }
}
