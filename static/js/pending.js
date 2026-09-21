// @ts-check
// The pending review: the comments the reviewer has written and not submitted yet. They live in
// the local state, are drawn on the diff with a "pending" badge, and are counted in a bar that
// stays on screen for as long as any of them is waiting.
/** @typedef {import('./contract-types.js').PendingComment} PendingComment */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').Side} Side */
import { esc, timeAgo } from './dom.js'
import { hostLabel } from './host.js'
import { renderMarkdown } from './markdown.js'

export const PENDING_BAR_ID = 'pending-bar'

/**
 * The drafts of one target, oldest first. A state written by an older tool version has no list
 * at all, which reads as none waiting.
 * @param {PrState | null | undefined} state
 * @returns {ReadonlyArray<PendingComment>}
 */
export function pendingComments(state) {
  return state?.pending ?? []
}

/**
 * @param {PrState | null | undefined} state
 * @returns {number}
 */
export function pendingCount(state) {
  return pendingComments(state).length
}

/**
 * The drafts anchored to one file, by the diff key the rows carry.
 * @param {PrState | null | undefined} state
 * @param {string} path
 * @returns {ReadonlyArray<PendingComment>}
 */
export function pendingForPath(state, path) {
  return pendingComments(state).filter(p => p.path === path)
}

/**
 * The draft an attention point was added to the review as, when it was. A point is queued at most
 * once: its fingerprint is what ties the two together.
 * @param {PrState | null | undefined} state
 * @param {string} fingerprint
 * @returns {PendingComment | undefined}
 */
export function pendingForPoint(state, fingerprint) {
  return pendingComments(state).find(p => p.pointFingerprint === fingerprint)
}

/** @param {number} count */
export function pendingLabel(count) {
  return count === 1 ? '1 pending comment' : `${count} pending comments`
}

/**
 * Where a draft sits, said the way the selection toolbar says it.
 * @param {PendingComment} p
 */
export function pendingRange(p) {
  const range = p.startLine !== undefined && p.startLine !== p.line ? `${p.startLine}–${p.line}` : `${p.line}`
  return `${p.path}:${range}${p.side === 'old' ? ' (old)' : ''}`
}

/**
 * One draft as it is drawn under the line it comments on: the body, when it was written, and the
 * commands that edit or drop it. The badge is what tells the reviewer it is not on the forge yet.
 * @param {PendingComment} p
 * @param {Date} now
 */
export function pendingCommentHtml(p, now) {
  // The same two-column shape a posted comment has, so drafts and comments line up on the diff:
  // the marker takes the avatar's place, and the commands span both columns under them.
  return (
    `<div class="cmt pending-cmt" data-pending-id="${esc(p.id)}">` +
    '<span class="av pending-av" aria-hidden="true">&hellip;</span>' +
    `<span class="who"><span class="pill pending">pending</span> ` +
    `<span class="muted">${esc(timeAgo(p.createdAt, now))} · not posted to ${esc(hostLabel())} yet</span></span>` +
    `<div class="prose">${renderMarkdown(p.body, { github: true })}</div>` +
    '<span class="tbtns">' +
    `<button class="cmd" type="button" data-act="pending-edit" data-pending-id="${esc(p.id)}">edit</button>` +
    `<button class="cmd" type="button" data-act="pending-delete" data-pending-id="${esc(p.id)}">delete</button>` +
    '</span></div>'
  )
}

/**
 * The row the draft is drawn in, so it can sit under its line in the diff table.
 * @param {ReadonlyArray<PendingComment>} drafts the drafts anchored to one line
 * @param {Date} now
 */
export function pendingRowHtml(drafts, now) {
  return (
    '<tr class="pending-row"><td class="code x" colspan="4">' +
    drafts.map(p => pendingCommentHtml(p, now)).join('') +
    '</td></tr>'
  )
}

/**
 * The bar that says a review is being written. It is drawn only while something is waiting, and
 * carries the two ways out: submit the review, or throw the drafts away.
 * @param {number} count
 */
export function pendingBarHtml(count) {
  if (count === 0) {
    return ''
  }
  return (
    `<div class="pending-bar" id="${PENDING_BAR_ID}" role="status">` +
    `<span class="pending-mark" aria-hidden="true"></span>` +
    `<span class="pending-text"><b>${esc(pendingLabel(count))}</b> waiting in your review. ` +
    `Nothing is on ${esc(hostLabel())} until you submit it.</span>` +
    '<span class="pending-actions">' +
    '<button class="cmd fill" type="button" data-act="pending-finish" data-needs-post>finish your review</button>' +
    '<button class="cmd" type="button" data-act="pending-discard">discard</button>' +
    '</span></div>'
  )
}

/**
 * Draws the bar from the current state, adding it when the first draft appears and taking it away
 * with the last one. The host element is where the bar lives; it is emptied when nothing waits.
 * @param {ParentNode} root
 * @param {PrState} state
 * @returns {number} how many drafts are waiting
 */
export function refreshPendingBar(root, state) {
  const count = pendingCount(state)
  const host = root.querySelector('.pending-bar-host')
  if (host !== null) {
    host.innerHTML = pendingBarHtml(count)
    host.classList.toggle('has-pending', count > 0)
  }
  return count
}
