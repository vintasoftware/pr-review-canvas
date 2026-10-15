// @ts-check
// Which diff a review mark or a pending draft was made on: a commit, diffed from a merge base. A
// pull request moved to another base reviews another diff of the same commit, so the commit alone
// does not say. The page and the server read these rules from here, so they never disagree on
// which drafts and marks count.
/** @typedef {import('./contract-types.js').PendingComment} PendingComment */
/** @typedef {import('./contract-types.js').PrState} PrState */

/** A commit and the merge base its diff runs from. @typedef {{ headSha: string, mergeBaseSha: string }} Diff */

/**
 * @param {Diff} a
 * @param {Diff} b
 */
export function sameDiff(a, b) {
  return a.headSha === b.headSha && a.mergeBaseSha === b.mergeBaseSha
}

/**
 * The diff a draft was written on. A draft of an older tool version names no merge base, and reads
 * as written on the current one.
 * @param {PendingComment} draft
 * @param {Diff} current
 * @returns {Diff}
 */
export function draftDiff(draft, current) {
  return { headSha: draft.headSha, mergeBaseSha: draft.mergeBaseSha ?? current.mergeBaseSha }
}

/**
 * Whether a draft was written on the diff `on`.
 * @param {PendingComment} draft
 * @param {Diff} on
 */
export function writtenOn(draft, on) {
  return sameDiff(draftDiff(draft, on), on)
}

/**
 * Whether the stored review marks were made on this canvas diff. Marks of an older tool version
 * name no merge base, and count for the canvas's diff, whichever it is.
 * @param {Pick<PrState, 'reviewedCanvasSha' | 'reviewedMergeBaseSha'>} state
 * @param {Diff} canvas
 */
export function marksOn(state, canvas) {
  return (
    state.reviewedCanvasSha !== undefined &&
    sameDiff(
      { headSha: state.reviewedCanvasSha, mergeBaseSha: state.reviewedMergeBaseSha ?? canvas.mergeBaseSha },
      canvas
    )
  )
}
