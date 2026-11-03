// @ts-check
// The comment and resolution cards of an AI Chat answer, drawn from the pane's state. chat.js
// finds the cards and wires their commands.
/** @typedef {import('./proposed-comment.js').ProposedComment} ProposedComment */
/** @typedef {import('./proposed-comment.js').ProposedResolution} ProposedResolution */
/** @typedef {import('./proposed-comment.js').ProposedRange} ProposedRange */
/** @typedef {import('./proposed-comment.js').AnchorError} AnchorError */
import { isQueuedComment, postedAnchor, postedCommentUrl, sendCommandsHtml } from './comment-link.js'
import { esc } from './dom.js'
import { renderMarkdown } from './markdown.js'
import { pointStatus, resolvable } from './points.js'

/**
 * `point` is the attention point the comment is tied to: once it was sent, the one what went out
 * names; before, the one the agent named, unless the reader unlinked it. `range` is the lines it
 * is on when the agent's range does not decide them: once it was sent, the lines it went out on;
 * before, the part of the agent's range the reader chose.
 * @typedef {{ postedUrl?: string | undefined, queued?: boolean, submitted?: boolean, point?: import('./proposed-comment.js').ProposalPoint, range?: ProposedRange }} SendState
 */

/**
 * What the pane knows when it draws a card: where each comment went, the comments the reader
 * unlinked from their point (by proposal fingerprint), the part of a range across two chunks the
 * reader chose (by proposal fingerprint), and the state the points stand in.
 * @typedef {{
 *   posted?: ReadonlyArray<import('./contract-types.js').ReviewComment & { proposalFingerprint?: string | undefined, pointFingerprint?: string | undefined }>,
 *   pending?: ReadonlyArray<import('./contract-types.js').PendingComment>,
 *   submitted?: ReadonlyArray<import('./contract-types.js').PendingComment>,
 *   unlinked?: ReadonlySet<string>,
 *   chosen?: ReadonlyMap<string, ProposedRange>,
 *   state?: import('./contract-types.js').PrState,
 * }} PaneState
 */

/**
 * Where the comment went, as the card shows it.
 * @param {SendState} send
 */
function sentAs(send) {
  return send.postedUrl !== undefined
    ? 'posted'
    : send.submitted === true
      ? 'submitted'
      : send.queued === true
        ? 'queued'
        : 'open'
}

/** @param {ProposedRange} range */
function rangeLabel(range) {
  return range.startLine === range.line ? `line ${range.line}` : `lines ${range.startLine}–${range.line}`
}

/**
 * The comment a card shows and sends: the agent's, or the same proposal on `range`. It keeps the
 * proposal's fingerprint, so the card finds the comment once it was sent.
 * @param {ProposedComment} proposal
 * @param {ProposedRange | undefined} range
 * @returns {ProposedComment}
 */
export function withRange(proposal, range) {
  if (range === undefined) {
    return proposal
  }
  const { startLine: _agents, ...rest } = proposal
  return range.startLine === range.line
    ? { ...rest, line: range.line }
    : { ...rest, startLine: range.startLine, line: range.line }
}

/**
 * The commands under a card. `add to review` leads, as it does on a diff-line comment, and both
 * ways of sending go through the same paths as every other post and draft, so capability gating
 * and the pending state apply here too. `blocked` disables both ways of sending and is their
 * title; edit and copy stay.
 * @param {ProposedComment} comment
 * @param {string} id the key the pane stores this card's comment under
 * @param {SendState} send
 * @param {string | null} blocked
 */
function proposedCommandsHtml(comment, id, send, blocked) {
  return (
    '<span class="tbtns">' +
    sendCommandsHtml({ kind: 'proposed', id, ...send, leadWithQueue: true, blocked }) +
    `<button class="cmd" type="button" data-act="proposed-edit" data-proposed="${esc(id)}" data-needs-post data-tooltip="Edit" title="Edit">edit</button>` +
    `<button class="cmd" type="button" data-copy="${esc(comment.body)}" title="Copy">copy</button>` +
    '</span>'
  )
}

/**
 * The line that says which attention point the agent tied the comment to. Sending the comment
 * carries the link to the point, which then shows the comment as its draft or its posted reply;
 * until then the reader can take the link off when the agent judged wrong.
 * @param {string} id
 * @param {SendState} send
 */
function proposedPointHtml(id, send) {
  if (send.point === undefined) {
    return ''
  }
  const unlink =
    sentAs(send) === 'open'
      ? ` <button class="cmd" type="button" data-act="proposed-unlink" data-proposed="${esc(id)}">unlink</button>`
      : ''
  return `<p class="proposed-point muted small">about the point “${esc(send.point.title)}”${unlink}</p>`
}

/**
 * The line of a card whose range crosses two chunks, while the comment is not sent: why it cannot
 * be sent, and the part of the range inside each chunk, for the reader to choose. Once the reader
 * chose one, it names the agent's range and offers the other parts.
 * @param {string} id
 * @param {ProposedComment} proposal
 * @param {SendState} send
 * @param {AnchorError | null} anchor
 */
function proposedAnchorHtml(id, proposal, send, anchor) {
  if (anchor === null || sentAs(send) !== 'open') {
    return ''
  }
  const chosen = send.range
  const others = anchor.parts.filter(
    p => chosen === undefined || p.startLine !== chosen.startLine || p.line !== chosen.line
  )
  const choices = others
    .map(
      p =>
        `<button class="cmd" type="button" data-act="proposed-range" data-proposed="${esc(id)}" data-start-line="${p.startLine}" data-line="${p.line}">${rangeLabel(p)}</button>`
    )
    .join(' ')
  const agents = { startLine: proposal.startLine ?? proposal.line, line: proposal.line }
  const lead =
    chosen === undefined
      ? `<span class="bad">${esc(anchor.message)}</span> Choose one chunk:`
      : `AI Chat proposed ${rangeLabel(agents)}, across more than one chunk. Or:`
  return `<p class="proposed-anchor small">${lead} ${choices}</p>`
}

/**
 * The card a proposed comment renders as. `anchor` is set when the agent's range crosses two
 * chunks, which the server refuses. The card then offers the part of the range inside each chunk
 * and sends only once the reader chose one: the page never moves the lines on its own, as the
 * body may be about one chunk only. `data-key` names everything the card draws from the state,
 * so a change of state redraws only the cards it changed.
 * @param {ProposedComment} proposal
 * @param {string} id the key the pane stores this card's comment under
 * @param {SendState} [send]
 * @param {AnchorError | null} [anchor]
 */
export function proposedCommentHtml(proposal, id, send = {}, anchor = null) {
  const comment = withRange(proposal, send.range)
  const range = comment.startLine === undefined ? `${comment.line}` : `${comment.startLine}–${comment.line}`
  const side = comment.side === 'old' ? ' (old side)' : ''
  const key = [sentAs(send), send.point?.fingerprint ?? '', range].join('|')
  return (
    `<div class="proposed" data-proposed="${esc(id)}" data-key="${esc(key)}">` +
    `<div class="proposed-h"><span class="lbl">proposed comment</span>` +
    `<span class="mono">${esc(comment.path)}:${esc(range)}${side}</span></div>` +
    proposedPointHtml(id, send) +
    proposedAnchorHtml(id, proposal, send, anchor) +
    `<div class="prose">${renderMarkdown(comment.body)}</div>` +
    proposedCommandsHtml(
      comment,
      id,
      send,
      anchor === null || send.range !== undefined ? null : anchor.message
    ) +
    '</div>'
  )
}

/** @param {ProposedComment | ProposedResolution} entry */
export function isResolution(entry) {
  return 'reason' in entry
}

/**
 * Replaces `el` with what `html` draws when its `data-key` names something else, or takes it out
 * when `html` is empty. The key names what the element shows; the live element also carries what
 * the page added since (an error after a command, a request in flight, the posting gate), which
 * the HTML does not, so it is compared by key and a command whose key held keeps all of that.
 * @param {Element} el
 * @param {string} html
 * @returns {Element | null} the element drawn in place of `el`, or null when `el` stays as it was
 */
export function redrawOnKey(el, html) {
  const template = document.createElement('template')
  template.innerHTML = html
  const next = template.content.firstElementChild
  if (next === null) {
    el.remove()
  } else if (next.getAttribute('data-key') !== el.getAttribute('data-key')) {
    el.replaceWith(next)
    return next
  }
  return null
}

/**
 * The commands of a proposed resolution, by where its point stands: save the reason as it stands,
 * or open the point's own reason box with it, where it can change and also go out as a comment.
 * The rule is the point's own (`resolvable`), so the card offers resolve exactly where the point
 * does; a point resolved, or dismissed and waiting to be restored, says so instead. `data-key`
 * names which, so a change of state redraws only the cards it changed.
 * @param {ProposedResolution} resolution
 * @param {string} id the key the pane stores this card's resolution under
 * @param {import('./contract-types.js').PrState | undefined} state
 */
export function resolutionCommandsHtml(resolution, id, state) {
  const status = pointStatus(resolution.point, state)
  const shown = resolvable(status) ? 'open' : status
  const target = `data-proposed="${esc(id)}"`
  const acts =
    shown === 'open'
      ? `<button class="cmd fill" type="button" data-act="resolution-save" ${target}>resolve</button>` +
        `<button class="cmd" type="button" data-act="resolution-edit" ${target} title="Edit">edit</button>`
      : shown === 'resolved'
        ? '<span class="pill status resolved">resolved</span>'
        : shown === 'dismissed'
          ? '<span class="muted small">dismissed: restore the point to resolve it</span>'
          : ''
  return (
    `<span class="tbtns" data-key="${shown}">${acts}` +
    `<button class="cmd" type="button" data-copy="${esc(resolution.reason)}" title="Copy">copy</button></span>`
  )
}

/**
 * The card a proposed resolution renders as: the point it answers and the reason.
 * @param {ProposedResolution} resolution
 * @param {string} id
 * @param {import('./contract-types.js').PrState | undefined} state
 */
export function proposedResolutionHtml(resolution, id, state) {
  return (
    `<div class="proposed resolution" data-proposed="${esc(id)}">` +
    '<div class="proposed-h"><span class="lbl">proposed resolution</span></div>' +
    `<p class="proposed-point muted small">about the point “${esc(resolution.point.title)}”</p>` +
    `<div class="prose">${renderMarkdown(resolution.reason)}</div>` +
    resolutionCommandsHtml(resolution, id, state) +
    '</div>'
  )
}

/**
 * Where a proposed comment stands against the posted comments and the pending review, and the
 * point it is tied to and the lines it is on. What went out decides both once the comment was
 * sent; before, the agent's choice holds unless the reader unlinked the point or chose a part of
 * the range. One function answers this for the card, for a redraw, and for the send itself, so
 * the three never disagree.
 * @param {ProposedComment} comment
 * @param {PaneState} pane
 * @returns {SendState}
 */
export function sendStateOf(comment, pane) {
  const posted = pane.posted ?? []
  const pending = pane.pending ?? []
  const submitted = pane.submitted ?? []
  const fp = comment.proposalFingerprint
  const sent =
    fp === undefined
      ? undefined
      : ([...pending, ...submitted].find(d => d.proposalFingerprint === fp) ??
        posted.find(c => c.proposalFingerprint === fp))
  const point =
    sent !== undefined
      ? sent.pointFingerprint !== undefined && sent.pointFingerprint === comment.point?.fingerprint
        ? comment.point
        : undefined
      : fp !== undefined && pane.unlinked?.has(fp) === true
        ? undefined
        : comment.point
  const range = sent !== undefined ? sentRange(sent) : fp === undefined ? undefined : pane.chosen?.get(fp)
  return {
    postedUrl: postedCommentUrl(comment, posted),
    queued: isQueuedComment(comment, pending),
    submitted: isQueuedComment(comment, submitted),
    ...(point === undefined ? {} : { point }),
    ...(range === undefined ? {} : { range }),
  }
}

/**
 * The lines a sent comment went out on: a draft's own, or the ones a posted comment was written on.
 * @param {import('./contract-types.js').PendingComment | import('./contract-types.js').ReviewComment} sent
 * @returns {ProposedRange | undefined}
 */
function sentRange(sent) {
  const { line, startLine } = postedAnchor(sent)
  return line === null ? undefined : { startLine: startLine ?? line, line }
}
