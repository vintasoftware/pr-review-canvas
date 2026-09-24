// @ts-check
// What the page knows about one PR while it is open: the canvas, the local review state, and
// what this GitHub login may post. Every change is applied at once and taken back when the
// server refuses it, so a click is never silently lost.
/** @typedef {import('./contract-types.js').Capabilities} Capabilities */
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').PostCommentInput} PostCommentInput */
/** @typedef {import('./contract-types.js').PostCommentResponse} PostCommentResponse */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./contract-types.js').ReviewSummary} ReviewSummary */
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */
import {
  addPending,
  deletePending,
  discardPending,
  editPending,
  postComment,
  postReview,
  putDismissed,
  putReviewed,
  putSettled,
  putThreadHidden,
} from './api.js'

/**
 * @typedef {{
 *   putReviewed: typeof putReviewed,
 *   putDismissed: typeof putDismissed,
 *   putSettled: typeof putSettled,
 *   putThreadHidden: typeof putThreadHidden,
 *   postComment: typeof postComment,
 *   postReview: typeof postReview,
 *   addPending: typeof addPending,
 *   editPending: typeof editPending,
 *   deletePending: typeof deletePending,
 *   discardPending: typeof discardPending,
 * }} SessionApi
 */

/**
 * @typedef {{
 *   prNumber: import('./contract-types.js').ReviewKey,
 *   artifact: ReviewArtifact,
 *   files: ReadonlyArray<FileEntry>,
 *   state: PrState,
 *   capabilities: Capabilities,
 *   headSha: string,
 *   canvasSha?: string,
 *   api?: Partial<SessionApi>,
 *   onState?: (state: PrState) => void,
 * }} SessionOptions
 */

/** @param {Partial<SessionApi> | undefined} overrides */
function withDefaults(overrides) {
  return {
    putReviewed,
    putDismissed,
    putSettled,
    putThreadHidden,
    postComment,
    postReview,
    addPending,
    editPending,
    deletePending,
    discardPending,
    ...overrides,
  }
}

export { reviewedId } from './keys.js'

/** @param {SessionOptions} options */
export function createReviewSession(options) {
  const api = withDefaults(options.api)
  /** @type {PrState} */
  let state = options.state
  /** @type {ReviewComment[]} */
  let submittedComments = []
  /** @type {Capabilities} */
  let capabilities = options.capabilities
  /** The canvas's settled points, as the server last answered them. */
  let settled = options.artifact.settled ?? {}
  const keyToPath = new Map(options.files.map(f => [f.key, f.path]))

  /** @type {Array<(state: PrState) => void>} */
  const listeners = options.onState === undefined ? [] : [options.onState]

  /** @param {PrState} next */
  const publish = next => {
    state = next
    for (const fn of listeners) {
      fn(state)
    }
  }

  /** How many changes are waiting for an answer. */
  let inFlight = 0
  /** The newest answer that came back while others were still in flight, and its write count. */
  /** @type {PrState | null} */
  let newestState = null
  let newestRev = 0
  /** The write count of the last answer this page took. */
  let takenRev = 0

  /**
   * Shows the change at once, then reconciles with the server.
   *
   * `apply` and `undo` work on whatever the state is when they run, so a change that fails
   * takes back only itself and leaves a change that landed meanwhile alone. Answers carry the
   * write they came from (`rev`), so the newest one wins however the answers arrive, and it is
   * taken once nothing is in flight.
   * @param {(state: PrState) => PrState} apply
   * @param {(state: PrState) => PrState} undo
   * @param {() => Promise<{ state: PrState }>} request
   */
  const change = async (apply, undo, request) => {
    inFlight += 1
    publish(apply(state))
    try {
      const answer = await request()
      inFlight -= 1
      takeAnswer(answer.state)
      settle()
      return state
    } catch (err) {
      inFlight -= 1
      // A change that failed was never written, so an answer that is waiting already describes
      // the state without it; only what this page showed has to be taken back.
      publish(undo(state))
      settle()
      throw err
    }
  }

  /** @param {PrState} answered */
  const takeAnswer = answered => {
    const rev = answered.rev ?? 0
    if (rev >= newestRev) {
      newestRev = rev
      newestState = answered
    }
  }

  /** Takes the newest answer once every change has come back, unless an older one arrived. */
  const settle = () => {
    if (inFlight > 0 || newestState === null) {
      return
    }
    const next = newestState
    newestState = null
    newestRev = 0
    if ((next.rev ?? 0) >= takenRev) {
      takenRev = next.rev ?? 0
      publish(next)
    }
  }

  /**
   * A change the server owns outright: the answer it sends is the new state. Unlike `change`
   * there is nothing to show first and nothing to take back, because the page never guessed.
   * @template {{ state: PrState }} T
   * @param {() => Promise<T>} request
   * @returns {Promise<T>}
   */
  const run = async request => {
    inFlight += 1
    try {
      const answer = await request()
      inFlight -= 1
      takeAnswer(answer.state)
      settle()
      return answer
    } catch (err) {
      inFlight -= 1
      settle()
      throw err
    }
  }

  /**
   * @param {PrState} current
   * @param {'reviewed' | 'dismissed' | 'hiddenThreads'} field
   * @param {string} key
   * @param {{ at: string, reason?: string | undefined } | true | undefined} value undefined removes the key
   */
  const withEntry = (current, field, key, value) => {
    const next = { ...current[field] }
    if (value === undefined) {
      delete next[key]
    } else {
      Object.assign(next, { [key]: value })
    }
    return { ...current, [field]: next }
  }

  return {
    get state() {
      return state
    },
    get capabilities() {
      return capabilities
    },
    get artifact() {
      return options.artifact
    },
    get settled() {
      return settled
    },
    prNumber: options.prNumber,
    /**
     * Runs `fn` after every change of the local state, the optimistic one included.
     * @param {(state: PrState) => void} fn
     */
    subscribe(fn) {
      listeners.push(fn)
      return () => {
        const at = listeners.indexOf(fn)
        if (at >= 0) {
          listeners.splice(at, 1)
        }
      }
    },
    /** @param {Capabilities} next */
    setCapabilities(next) {
      capabilities = next
    },
    /** The commit this page was drawn for; every post names it. */
    headSha: options.headSha,
    /** @param {string} key */
    pathForKey(key) {
      return keyToPath.get(key)
    },
    /** @param {string} id */
    isReviewed(id) {
      return state.reviewed[id] === true
    },
    /**
     * @param {string} id
     * @param {boolean} reviewed
     */
    setReviewed(id, reviewed) {
      const before = state.reviewed[id]
      return change(
        current => withEntry(current, 'reviewed', id, reviewed ? true : undefined),
        current => withEntry(current, 'reviewed', id, before),
        () =>
          api.putReviewed(options.prNumber, id, reviewed, {
            headSha: options.headSha,
            ...(options.canvasSha === undefined ? {} : { canvasSha: options.canvasSha }),
          })
      )
    },
    /**
     * @param {string} fingerprint
     * @param {boolean} dismissed
     */
    setDismissed(fingerprint, dismissed) {
      const before = state.dismissed[fingerprint]
      const at = new Date().toISOString()
      return change(
        current => withEntry(current, 'dismissed', fingerprint, dismissed ? { at } : undefined),
        current => withEntry(current, 'dismissed', fingerprint, before),
        () => api.putDismissed(options.prNumber, fingerprint, dismissed)
      )
    },
    /**
     * Settles a point for every reviewer, or reopens it. The server writes the canvas and shares it
     * again; the settled points it answers with are taken before the state, so the page that
     * redraws on the new state already hides the point.
     * @param {string} fingerprint
     * @param {import('./contract-types.js').SettleInput} input the page's commit is added here
     * @returns {Promise<import('./contract-types.js').SettleResponse>}
     */
    settle(fingerprint, input) {
      return run(async () => {
        const answer = await api.putSettled(options.prNumber, fingerprint, {
          ...input,
          headSha: options.headSha,
        })
        settled = answer.settled
        return answer
      })
    },
    /**
     * @param {number} rootCommentId
     * @param {boolean} hidden
     */
    setThreadHidden(rootCommentId, hidden) {
      const key = String(rootCommentId)
      const before = state.hiddenThreads[key]
      const at = new Date().toISOString()
      return change(
        current => withEntry(current, 'hiddenThreads', key, hidden ? { at } : undefined),
        current => withEntry(current, 'hiddenThreads', key, before),
        () => api.putThreadHidden(options.prNumber, rootCommentId, hidden)
      )
    },
    /**
     * Posts one comment. The pending item is the caller's; here only the answer is kept.
     * @param {PostCommentInput} input
     * @returns {Promise<PostCommentResponse>}
     */
    async postComment(input) {
      return run(() => api.postComment(options.prNumber, { ...input, headSha: options.headSha }))
    },
    /** Comments returned by reviews submitted during this session. */
    get submittedComments() {
      return submittedComments
    },
    /** The comments waiting in the pending review, oldest first. */
    get pending() {
      return state.pending ?? []
    },
    /**
     * Writes one comment into the pending review. The answer carries the state that holds it, so
     * the page draws the draft from the same place a reload would read it from.
     * @param {Omit<import('./contract-types.js').AddPendingInput, 'headSha'>} input
     * @returns {Promise<PrState>}
     */
    async addPending(input) {
      return (await run(() => api.addPending(options.prNumber, { ...input, headSha: options.headSha }))).state
    },
    /**
     * @param {string} id
     * @param {string} body
     * @returns {Promise<PrState>}
     */
    async editPending(id, body) {
      return (await run(() => api.editPending(options.prNumber, id, body))).state
    },
    /**
     * @param {string} id
     * @returns {Promise<PrState>}
     */
    async deletePending(id) {
      return (await run(() => api.deletePending(options.prNumber, id))).state
    },
    /** @returns {Promise<PrState>} */
    async discardPending() {
      return (await run(() => api.discardPending(options.prNumber))).state
    },
    /**
     * Submits the review. The pending comments go out with it unless the caller says otherwise,
     * and the answer's state is the one with them cleared.
     * @param {import('./contract-types.js').ReviewEvent} event
     * @param {string} [body]
     * @param {{ includePending?: boolean }} [opts]
     * @returns {Promise<import('./contract-types.js').PostReviewResponse>}
     */
    async postReview(event, body, opts = {}) {
      const input = {
        event,
        ...(body === undefined ? {} : { body }),
        ...(opts.includePending === undefined ? {} : { includePending: opts.includePending }),
      }
      return run(async () => {
        const answer = await api.postReview(options.prNumber, { ...input, headSha: options.headSha })
        submittedComments = [...submittedComments, ...answer.comments]
        return answer
      })
    },
  }
}

/** @typedef {ReturnType<typeof createReviewSession>} ReviewSession */
