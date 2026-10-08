// @ts-check
// Self-review on the page: the author settles attention points with a reason, and every reader
// sees what the author settled and why. The author may settle any point, a reviewer point too: a
// false positive needs no reviewer's judgment. The renderers read the settled points from here rather
// than threading them through every card; `app.js` sets them once per render, and the review
// session hands over each new set the server answers with.
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').Settlement} Settlement */
import { runCommand, showCommandError } from './commands.js'
import { esc } from './dom.js'

/** Mirrors SETTLEMENT_REASON_MAX in the contract. */
export const REASON_MAX = 600

let selfReview = false
/** Whether a settlement also updates the canvas comment reviewers load. */
let sharesCanvas = true
/** @type {Readonly<Record<string, Settlement>>} */
let settled = {}

/**
 * @param {boolean} on whether the reader wrote the change and may settle points
 * @param {Readonly<Record<string, Settlement>> | undefined} points the canvas's settled points
 * @param {boolean} [canvasComment] whether settling shares the canvas comment again
 */
export function setSelfReview(on, points, canvasComment = true) {
  selfReview = on
  settled = points ?? {}
  sharesCanvas = canvasComment
}

/** @param {Readonly<Record<string, Settlement>>} points */
export function setSettled(points) {
  settled = points
}

/** @param {Pick<Point, 'fingerprint'>} p */
export function settlementOf(p) {
  return settled[p.fingerprint]
}

/** Whether the reader wrote the change, and so may resolve its points. */
export function canSettle() {
  return selfReview
}

/**
 * Who the point asks, as a pill. The author reads "yours" where a reviewer reads "author".
 * @param {Point} p
 */
export function audiencePillHtml(p) {
  if (p.audience === 'author') {
    return `<span class="pill audience author" title="The author can resolve this before review">${selfReview ? 'yours' : 'author'}</span>`
  }
  return '<span class="pill audience reviewer" title="This needs the reviewer’s judgment">reviewer</span>'
}

/**
 * The settle command: for the author, on any point that is not settled yet.
 * @param {Point} p
 */
export function settleButtonHtml(p) {
  return selfReview && settlementOf(p) === undefined
    ? `<button class="cmd" type="button" data-act="point-settle" data-fingerprint="${esc(p.fingerprint)}">resolve</button>`
    : ''
}

/**
 * The box the author writes the reason in. `canPost` offers to post the reason on the point's line
 * too, which only a pull request can take.
 * @param {Point} p
 * @param {{ canPost: boolean }} opts
 */
export function settleFormHtml(p, opts) {
  const post = opts.canPost
    ? '<label class="chk small"><input type="checkbox" name="settle-comment" checked> also post the reason as a comment on this line</label>'
    : ''
  return (
    '<div class="composer-box settle-box">' +
    `<label class="lbl" for="settle-${esc(p.id)}">Why this needs no reviewer decision</label>` +
    `<textarea id="settle-${esc(p.id)}" name="settle-reason" rows="3" maxlength="${REASON_MAX}" placeholder="e.g. nothing uses this API yet, so breaking it is fine"></textarea>` +
    `${post}<span class="tbtns"><button class="cmd" type="button" data-act="settle-save" data-fingerprint="${esc(p.fingerprint)}">resolve</button>` +
    '<button class="cmd" type="button" data-act="settle-cancel">cancel</button></span></div>'
  )
}

/**
 * The reopen command: for the author, on a point they settled. Every reader sees the reason where
 * the point stands; only the author can take it back.
 * @param {Point} p
 */
export function reopenButtonHtml(p) {
  return selfReview && settlementOf(p) !== undefined
    ? `<button class="cmd" type="button" data-act="point-unsettle" data-fingerprint="${esc(p.fingerprint)}">reopen</button>`
    : ''
}

/**
 * The author's note at the top of the overview: how many points are still open. A personal
 * dismissal does not answer a point, so the note counts every point the author has not settled.
 * Readers other than the author see nothing here.
 * @param {ReadonlyArray<Point>} points every point on the canvas
 */
export function selfReviewNoteHtml(points) {
  if (!selfReview) {
    return '<p class="self-review-note" hidden></p>'
  }
  const open = points.filter(p => settlementOf(p) === undefined)
  const yours = open.filter(p => p.audience === 'author').length
  const theirs = open.length - yours
  const lead =
    yours === 0
      ? 'Self-review done: nothing marked yours is open.'
      : `Self-review: ${yours} ${yours === 1 ? 'point is' : 'points are'} marked yours.`
  const where = sharesCanvas
    ? 'the canvas comment updates, so reviewers see only what is left'
    : 'it is written into this canvas'
  return (
    `<p class="self-review-note"><strong>${lead}</strong> ` +
    (yours === 0
      ? ''
      : `Resolve what you can answer now with a reason, including a reviewer point that does not apply; ${where}. `) +
    `${theirs} ${theirs === 1 ? 'point goes' : 'points go'} to the reviewer.</p>`
  )
}

/**
 * What the reader is told once a settlement is written: whether the shared canvas followed.
 * @param {import('./contract-types.js').SettleResponse['sharing']} sharing
 * @param {string} done what happened to the point
 */
export function sharingNote(sharing, done) {
  switch (sharing.status) {
    case 'shared':
      return `${done}; the canvas comment is updated for reviewers`
    case 'local':
      return `${done} in this canvas`
    case 'off':
      return `${done} in this canvas; the canvas comment is off`
    case 'failed':
      return `${done} here, but the canvas comment was not updated: ${sharing.warning}`
  }
}

/**
 * The commands of self-review, for the page's one click handler: open the reason box, write the
 * settlement, close the box, and reopen a settled point.
 * @param {import('./review-session.js').ReviewSession} session
 * @param {(message: string) => void} notify
 * @returns {Record<string, (el: HTMLElement) => void>}
 */
export function selfReviewActions(session, notify) {
  /** @param {Element} el the command, which names its point */
  const pointOf = el => {
    const fingerprint = el.getAttribute('data-fingerprint')
    return session.artifact.points.find(p => p.fingerprint === fingerprint)
  }
  return {
    'point-settle': el => {
      const point = pointOf(el)
      const commands = el.closest('.tbtns')
      if (point === undefined || commands === null) {
        return
      }
      if (commands.nextElementSibling?.classList.contains('settle-box') !== true) {
        const canPost = typeof session.prNumber === 'number' && session.capabilities.canComment !== false
        commands.insertAdjacentHTML('afterend', settleFormHtml(point, { canPost }))
      }
      commands.nextElementSibling?.querySelector('textarea')?.focus()
    },
    'settle-cancel': el => {
      el.closest('.settle-box')?.remove()
    },
    'settle-save': el => {
      const point = pointOf(el)
      const box = el.closest('.settle-box')
      const reason = box?.querySelector('textarea')?.value.trim()
      if (point === undefined || box === null || !reason) {
        showCommandError(el, 'write the reason first')
        return
      }
      const input = { settled: true, reason, comment: box.querySelector('input')?.checked === true }
      void runCommand(
        el,
        async () => {
          const answer = await session.settle(point.fingerprint, input)
          box.remove()
          notify(sharingNote(answer.sharing, 'point resolved'))
        },
        { pendingLabel: 'resolving…' }
      )
    },
    'point-unsettle': el => {
      const point = pointOf(el)
      if (point === undefined) {
        return
      }
      void runCommand(
        el,
        async () => {
          const answer = await session.settle(point.fingerprint, { settled: false })
          notify(sharingNote(answer.sharing, 'point reopened'))
        },
        { pendingLabel: 'reopening…' }
      )
    },
  }
}
