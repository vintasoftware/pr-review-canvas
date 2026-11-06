// @ts-check
// The AI Chat pane: threads, the one context a message is about, the streamed answer, and the
// comment cards an answer can propose. The scrolling rules live in chat-scroll.js and the block
// parsing in proposed-comment.js; this file is the wiring between them and the DOM.
/** @typedef {import('./chat-context.js').ChatContext} ChatContext */
/** @typedef {import('./contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('./proposed-comment.js').ProposedComment} ProposedComment */
/** @typedef {import('./proposed-comment.js').ProposedResolution} ProposedResolution */
/** @typedef {import('./review-session.js').ReviewSession} ReviewSession */
import {
  cancelChat,
  fetchThreadHistory,
  fetchThreads,
  markThreadUnseen,
  selectThread,
  streamChat,
} from './api.js'
import {
  chatContextAttrs,
  chatContextFromElement,
  chatContextLabel,
  chatContextName,
  sameChatContext,
  threadOfPlace,
  WHOLE_PR,
} from './chat-context.js'
import { wireChatPanel } from './chat-panel.js'
import { quickQuestionsFor } from './quick-questions.js'
import { wireThreadList } from './thread-list.js'
import { navigateLink } from './deep-link.js'
import {
  canScrollBy,
  chatScrollReducer,
  INITIAL_SCROLL_STATE,
  isAtBottom,
  redirectsWheelToTranscript,
  scrollBehavior,
  unseenLabel,
} from './chat-scroll.js'
import { runCommand, toast } from './commands.js'
import { isQueuedComment, postedCommentUrl, sendCommandsHtml } from './comment-link.js'
import { esc, flash, qs, scrollIntoViewSafe, timeAgo } from './dom.js'
import { cssEscape } from './anchors.js'
import { getRenderContext } from './layers.js'
import { lineLink } from './links.js'
import { renderMarkdown } from './markdown.js'
import { pendingComments } from './pending.js'
import { pointStatus, resolvable } from './points.js'
import { proposalFingerprint, splitChatAnswer, targetsFromFiles } from './proposed-comment.js'
import { REVIEW_PANEL_ID } from './review-panel.js'
import { canSettle } from './self-review.js'
import { CHAT_NEW_BADGE, openReviewTab, selectSideTab, sideTabsHtml, wireSideTabs } from './side-pane.js'

export const CHAT_WIDTH_KEY = 'pr-review.chat-width'
export const CHAT_MINIMIZED_KEY = 'pr-review.chat-minimized'
// The narrowest pane still fits the thread head's name, and its tab strip with every count on it:
// AI Chat at 9 and a two-digit review.
export const CHAT_WIDTH_MIN = 360
export const CHAT_WIDTH_MAX = 560
export const CHAT_WIDTH_DEFAULT = 380

/**
 * @param {{ enabled: boolean, width?: number, minimized?: boolean }} opts
 * @returns {string} '' when AI Chat is disabled
 */
export function renderChatShell(opts) {
  if (!opts.enabled) {
    return ''
  }
  const width = clampWidth(opts.width ?? CHAT_WIDTH_DEFAULT)
  // The launcher starts hidden and `wireChatPanel` reveals it where it belongs, so a docked
  // chat never paints a launcher over itself on the first frame.
  return (
    `<aside class="chat" aria-label="AI Chat and your review" data-tab="chat"${opts.minimized ? ' hidden' : ''}>` +
    `<button class="handle" type="button" id="chat-handle" role="separator" aria-orientation="vertical" aria-label="Resize AI Chat" aria-valuenow="${width}" aria-valuemin="${CHAT_WIDTH_MIN}" aria-valuemax="${CHAT_WIDTH_MAX}"></button>` +
    sideTabsHtml({ chat: true }) +
    // The tab names the pane on screen; the heading stays for screen readers and the dialog's name.
    // One thread at a time, under a head naming what it is about. The head opens the list of every
    // thread, which can also start one about the whole PR.
    '<div class="chat-h"><h2 class="sr" id="chat-h">AI Chat</h2>' +
    '<button class="thread-switch" type="button" id="thread-switch" aria-haspopup="dialog" aria-expanded="false" aria-controls="thread-pop" title="Switch thread">' +
    '<span class="thread-kind" id="thread-kind" hidden></span>' +
    '<span class="thread-title" id="thread-title">New thread</span>' +
    '<span class="threads-new" hidden></span><span class="thread-caret" aria-hidden="true"></span></button>' +
    '<button class="cmd" type="button" id="chat-new-thread" title="New thread about the whole PR">new thread</button>' +
    '<div class="thread-pop" id="thread-pop" role="dialog" aria-label="Threads" hidden>' +
    '<input class="thread-filter" id="thread-filter" type="search" placeholder="Filter threads…" aria-label="Filter threads" autocomplete="off">' +
    '<nav class="thread-index" id="thread-index" aria-label="Threads"></nav>' +
    '<button class="thread-pop-new" type="button" id="new-thread">+ New thread about the whole PR</button>' +
    '</div></div>' +
    '<div class="transcript" id="chat-log" role="log" aria-label="Transcript" aria-live="polite" tabindex="0">' +
    '<p class="empty">Ask AI Chat about a layer, a file, or a selection. Answers come with a verdict first, then evidence.</p>' +
    '</div>' +
    // The context is what the next message is about, so it sits on the composer, not over the
    // thread. The bubble sits on the composer too, so it clears it at any height.
    '<form class="chat-composer" id="chat-form">' +
    '<button class="cmd unseen" type="button" id="chat-unseen" hidden aria-live="polite"></button>' +
    '<p class="ctx-line" id="chat-ctx-line">Context: <span class="ctx-chip" id="chat-ctx">whole PR</span>' +
    ' <button class="cmd" type="button" id="thread-goto" title="Go to the code" hidden>go to code</button>' +
    ' <button class="cmd" type="button" id="chat-clear" title="Clear: ask about the whole PR" hidden>clear</button></p>' +
    '<label class="sr" for="msg">Message</label>' +
    '<textarea id="msg" rows="3" placeholder="Ask AI Chat about this PR…"></textarea>' +
    '<div class="tbtns"><button class="cmd fill" type="submit" id="chat-send">send</button>' +
    '<button class="cmd" type="button" id="chat-stop" hidden>stop</button>' +
    '<span class="muted small">enter to send</span></div></form>' +
    `<section class="review-panel" id="${REVIEW_PANEL_ID}" role="tabpanel" aria-labelledby="side-tab-review" hidden></section>` +
    '</aside>' +
    '<dialog class="chat-dialog" id="chat-dialog" aria-labelledby="chat-h"></dialog>' +
    `<button class="chat-launcher" id="chat-launcher" type="button" hidden aria-controls="chat-dialog" aria-expanded="false">AI Chat${CHAT_NEW_BADGE}</button>`
  )
}

/**
 * The attribute writer escapes five characters; this reads them back for `setAttribute`.
 * @param {string} value
 */
function unescapeAttr(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** @param {number} width */
export function clampWidth(width) {
  if (!Number.isFinite(width)) {
    return CHAT_WIDTH_DEFAULT
  }
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(width)))
}

/**
 * @param {Storage | null} storage
 * @returns {number}
 */
export function readChatWidth(storage) {
  const raw = storage === null ? null : storage.getItem(CHAT_WIDTH_KEY)
  return clampWidth(raw === null ? CHAT_WIDTH_DEFAULT : Number(raw))
}

/**
 * @param {Storage | null} storage
 * @param {number} width
 */
export function writeChatWidth(storage, width) {
  storage?.setItem(CHAT_WIDTH_KEY, String(clampWidth(width)))
}

/**
 * Only a wide screen stores this: a floating chat always starts minimized.
 * @param {Storage | null} storage
 * @returns {boolean}
 */
export function readChatMinimized(storage) {
  return (storage === null ? null : storage.getItem(CHAT_MINIMIZED_KEY)) === '1'
}

/**
 * @param {Storage | null} storage
 * @param {boolean} minimized
 */
export function writeChatMinimized(storage, minimized) {
  storage?.setItem(CHAT_MINIMIZED_KEY, minimized ? '1' : '0')
}

/** @typedef {'post' | 'queue' | 'edit'} ProposedAct */

/** What each proposed-comment button asks the page to do. */
/** @type {Readonly<Record<string, ProposedAct>>} */
const PROPOSED_ACTS = { 'proposed-post': 'post', 'proposed-queue': 'queue', 'proposed-edit': 'edit' }

/**
 * @typedef {{
 *   root: HTMLElement,
 *   prNumber: import('./contract-types.js').ReviewKey,
 *   session: ReviewSession,
 *   storage?: Storage | null,
 *   api?: Partial<ChatApi>,
 *   reducedMotion?: boolean,
 *   threadPerPlace?: boolean,
 *   onProposed?: (what: ProposedAct, comment: ProposedComment, el: HTMLElement) => void,
 *   onResolution?: (what: 'save' | 'edit', resolution: ProposedResolution, el: HTMLElement) => void,
 * }} ChatOptions
 */

/**
 * A question and the thread it goes to: the one open when it was asked, by name, or for a draft
 * by its place.
 * @typedef {{ message: string, context: ChatContext, thread: string | null, place: ChatContext | undefined }} Question
 */

/**
 * @typedef {{
 *   fetchThreads: typeof fetchThreads,
 *   fetchThreadHistory: typeof fetchThreadHistory,
 *   selectThread: typeof selectThread,
 *   markThreadUnseen: typeof markThreadUnseen,
 *   cancelChat: typeof cancelChat,
 *   streamChat: typeof streamChat,
 * }} ChatApi
 */

/** @param {Partial<ChatApi> | undefined} overrides */
function withDefaults(overrides) {
  return {
    fetchThreads,
    fetchThreadHistory,
    selectThread,
    markThreadUnseen,
    cancelChat,
    streamChat,
    ...overrides,
  }
}

/**
 * What a turn carries besides its text. `context` is the label of what a message was about; a
 * message about the whole PR has none, so only a narrower target is named.
 * @typedef {{ incomplete?: string, fallback?: ChatTurn['fallback'], context?: string }} TurnOpts
 */

/**
 * @param {ChatTurn['role']} role
 * @param {string} bodyHtml
 * @param {TurnOpts} [opts]
 */
function turnHtml(role, bodyHtml, opts = {}) {
  return `<div class="turn ${role === 'assistant' ? 'a' : 'u'}">${turnInnerHtml(role, bodyHtml, opts)}</div>`
}

/**
 * @param {ChatTurn['role']} role
 * @param {string} bodyHtml
 * @param {TurnOpts} [opts]
 */
function turnInnerHtml(role, bodyHtml, opts = {}) {
  const note =
    opts.incomplete === undefined
      ? ''
      : `<p class="muted small">the answer stopped early (${esc(opts.incomplete)})</p>`
  return (
    `<span class="role">${role === 'assistant' ? 'AI Chat' : 'You'}</span>` +
    (opts.context === undefined
      ? ''
      : `<p class="turn-ctx">about <span class="ctx-chip">${esc(opts.context)}</span></p>`) +
    (opts.fallback === undefined ? '' : checkoutWarningHtml(opts.fallback)) +
    `<div class="prose">${bodyHtml}</div>${note}`
  )
}

/**
 * What the activity line says while a review checkout is created or moved.
 * @param {{ sha: string, creating: boolean }} event
 */
export function checkoutActivityText(event) {
  const sha = event.sha.slice(0, 7)
  return event.creating ? `Creating the review checkout at ${sha}` : `Checking out ${sha}`
}

/**
 * The warning a turn shows when its review checkout failed and it read the reader's checkout.
 * @param {{ message: string, branch: string | null }} event
 */
export function checkoutWarningHtml(event) {
  const where =
    event.branch === null
      ? 'your checkout'
      : `your checkout on <span class="mono">${esc(event.branch)}</span>`
  return (
    `<p class="chat-warning small" role="status">The review checkout could not be updated, so AI Chat read ${where}. ` +
    `Answers may describe another version of the code. <span class="muted">${esc(event.message)}</span></p>`
  )
}

/**
 * `point` is the attention point the comment is tied to: once it was sent, the one what went out
 * names; before, the one the agent named, unless the reader unlinked it.
 * @typedef {{ postedUrl?: string | undefined, queued?: boolean, submitted?: boolean, point?: import('./proposed-comment.js').ProposalPoint }} SendState
 */

/**
 * What the pane knows when it draws a card: where each comment went, the comments the reader
 * unlinked from their point (by proposal fingerprint), and the state the points stand in.
 * @typedef {{
 *   posted?: ReadonlyArray<import('./contract-types.js').ReviewComment & { proposalFingerprint?: string | undefined, pointFingerprint?: string | undefined }>,
 *   pending?: ReadonlyArray<import('./contract-types.js').PendingComment>,
 *   submitted?: ReadonlyArray<import('./contract-types.js').PendingComment>,
 *   unlinked?: ReadonlySet<string>,
 *   state?: import('./contract-types.js').PrState,
 * }} PaneState
 */

/**
 * The commands under a card. `add to review` leads, as it does on a diff-line comment, and both
 * ways of sending go through the same paths as every other post and draft, so capability gating
 * and the pending state apply here too. `data-key` names what the send commands show, so a
 * change of state redraws only the cards it changed.
 * @param {ProposedComment} comment
 * @param {string} id the key the pane stores this card's comment under
 * @param {SendState} send
 */
function proposedCommandsHtml(comment, id, send) {
  const shown =
    send.postedUrl !== undefined
      ? 'posted'
      : send.submitted === true
        ? 'submitted'
        : send.queued === true
          ? 'queued'
          : 'open'
  return (
    `<span class="tbtns" data-key="${shown}">` +
    sendCommandsHtml({ kind: 'proposed', id, ...send, leadWithQueue: true }) +
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
  const open = send.postedUrl === undefined && send.submitted !== true && send.queued !== true
  const unlink = open
    ? ` <button class="cmd" type="button" data-act="proposed-unlink" data-proposed="${esc(id)}">unlink</button>`
    : ''
  // The key is what the line shows: the point, and whether it can still come off.
  const key = `${send.point.fingerprint}:${open ? 'open' : 'sent'}`
  return `<p class="proposed-point muted small" data-key="${esc(key)}">about the point “${esc(send.point.title)}”${unlink}</p>`
}

/**
 * The card a proposed comment renders as.
 * @param {ProposedComment} comment
 * @param {string} id the key the pane stores this card's comment under
 * @param {SendState} [send]
 */
export function proposedCommentHtml(comment, id, send = {}) {
  const range = comment.startLine === undefined ? `${comment.line}` : `${comment.startLine}–${comment.line}`
  const side = comment.side === 'old' ? ' (old side)' : ''
  return (
    `<div class="proposed" data-proposed="${esc(id)}">` +
    `<div class="proposed-h"><span class="lbl">proposed comment</span>` +
    `<span class="mono">${esc(comment.path)}:${esc(range)}${side}</span></div>` +
    proposedPointHtml(id, send) +
    `<div class="prose">${renderMarkdown(comment.body)}</div>` +
    proposedCommandsHtml(comment, id, send) +
    '</div>'
  )
}

/** @param {ProposedComment | ProposedResolution} entry */
function isResolution(entry) {
  return 'reason' in entry
}

/**
 * Replaces `el` with what `html` draws when its `data-key` names something else, or takes it out
 * when `html` is empty. The key names what the element shows; the live element also carries what
 * the page added since (an error after a command, a request in flight, the posting gate), which
 * the HTML does not, so it is compared by key and a command whose key held keeps all of that.
 * @param {Element} el
 * @param {string} html
 */
function redrawOnKey(el, html) {
  const template = document.createElement('template')
  template.innerHTML = html
  const next = template.content.firstElementChild
  if (next === null) {
    el.remove()
  } else if (next.getAttribute('data-key') !== el.getAttribute('data-key')) {
    el.replaceWith(next)
  }
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
function resolutionCommandsHtml(resolution, id, state) {
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
function proposedResolutionHtml(resolution, id, state) {
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
 * point it is tied to. What went out decides the tie once the comment was sent; before, the
 * agent's choice holds unless the reader unlinked it. One function answers this for the card, for
 * a redraw, and for the send itself, so the three never disagree.
 * @param {ProposedComment} comment
 * @param {PaneState} pane
 * @returns {SendState}
 */
function sendStateOf(comment, pane) {
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
  return {
    postedUrl: postedCommentUrl(comment, posted),
    queued: isQueuedComment(comment, pending),
    submitted: isQueuedComment(comment, submitted),
    ...(point === undefined ? {} : { point }),
  }
}

/**
 * One assistant answer as HTML: prose, comment and resolution cards, and a code block, with the
 * reason, for a block that claimed to be one of those but is not.
 * Card keys carry the turn they belong to, so an older answer's card still acts on its own
 * proposal after a newer answer has drawn cards of its own.
 * @param {string} text
 * @param {import('./proposed-comment.js').CommentTargets} targets
 * @param {Map<string, ProposedComment | ProposedResolution>} sink cards found, by key
 * @param {ReadonlySet<string>} paths
 * @param {PaneState & { turnKey?: string }} [opts] `turnKey` is the prefix of this turn's card keys
 */
export function answerHtml(text, targets, sink, paths, opts = {}) {
  const turnKey = opts.turnKey ?? 'turn'
  let index = 0
  return splitChatAnswer(text, targets)
    .map(segment => {
      if (segment.type === 'markdown') {
        return renderMarkdown(segment.text, { paths })
      }
      if (segment.type === 'invalid') {
        return `<pre class="proposed-invalid"><code>${esc(segment.text)}</code></pre><p class="muted small">${esc(segment.reason)}</p>`
      }
      const id = `${turnKey}-${index}`
      index += 1
      if (segment.type === 'resolution') {
        sink.set(id, segment.resolution)
        return proposedResolutionHtml(segment.resolution, id, opts.state)
      }
      const comment = { ...segment.comment, proposalFingerprint: proposalFingerprint(segment.comment) }
      sink.set(id, comment)
      return proposedCommentHtml(comment, id, sendStateOf(comment, opts))
    })
    .join('')
}

/**
 * One part of the pane, by selector and by the kind of element it has to be.
 * @template {HTMLElement} T
 * @param {ParentNode} root
 * @param {string} selector
 * @param {new () => T} kind
 * @returns {T}
 */
function mustFind(root, selector, kind) {
  const el = root.querySelector(selector)
  if (el instanceof kind) {
    return el
  }
  throw new Error(`the AI Chat pane has no ${selector}`)
}

/**
 * Wires the pane. The returned handle is what the page uses to set the context from an `[ ask ]`
 * command and to take the wiring down before a re-render.
 * @param {ChatOptions} options
 */
export function wireChat(options) {
  const { root, prNumber, session } = options
  const api = withDefaults(options.api)
  const storage =
    options.storage === undefined
      ? typeof localStorage === 'undefined'
        ? null
        : localStorage
      : options.storage
  const paths = new Set(session.artifact.files.map(f => f.path))
  // The page decides once per render whether this reader resolves points; the pane is wired per render.
  const targets = targetsFromFiles(session.artifact.files, session.artifact.points, canSettle())
  const reducedMotion =
    options.reducedMotion ??
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)

  const pane = root.querySelector('.chat')
  if (!(pane instanceof HTMLElement)) {
    return null
  }
  // The pane is here, so every part of it is: `renderChatShell` writes them together. A missing
  // one is a mistake in this file, which `mustFind` reports instead of half-wiring the pane.
  const log = mustFind(root, '#chat-log', HTMLElement)
  const box = mustFind(root, '#msg', HTMLTextAreaElement)
  const form = mustFind(root, '#chat-form', HTMLFormElement)
  const threadKindEl = mustFind(root, '#thread-kind', HTMLElement)
  const threadTitleEl = mustFind(root, '#thread-title', HTMLElement)
  const gotoButton = mustFind(root, '#thread-goto', HTMLElement)
  const index = mustFind(root, '#thread-index', HTMLElement)
  const switchButton = mustFind(root, '#thread-switch', HTMLElement)
  const pop = mustFind(root, '#thread-pop', HTMLElement)
  // The list redraws its entries as it opens; `drawIndex` is defined below and runs only then.
  const threadList = wireThreadList({
    head: switchButton,
    pop,
    filter: mustFind(root, '#thread-filter', HTMLInputElement),
    index,
    draw: () => drawIndex(),
  })
  const chip = mustFind(root, '#chat-ctx', HTMLElement)
  const clearButton = mustFind(root, '#chat-clear', HTMLElement)
  const bubble = mustFind(root, '#chat-unseen', HTMLElement)
  const sendButton = mustFind(root, '#chat-send', HTMLButtonElement)
  const stopButton = mustFind(root, '#chat-stop', HTMLElement)
  const reviewPanel = qs(`#${REVIEW_PANEL_ID}`, pane)

  /** @type {ChatContext} */
  let context = WHOLE_PR
  /** @type {import('./chat-scroll.js').ChatScrollState} */
  let scroll = INITIAL_SCROLL_STATE
  /** Where each thread was left, so switching back does not jump the reader to the bottom. */
  const scrollTops = new Map()
  /** Every proposal card on screen, comment or resolution, by the key its buttons carry. */
  /** @type {Map<string, ProposedComment | ProposedResolution>} */
  const proposed = new Map()
  /**
   * The proposals the reader unlinked from their point, by proposal fingerprint. They stay
   * unlinked across every redraw of their answer, a reload of the thread aside.
   * @type {Set<string>}
   */
  const unlinked = new Set()
  const postedComments = () => {
    const receipts = new Map(session.state.posted.map(p => [p.commentId, p]))
    return (
      getRenderContext()
        ?.comments.filter(c => receipts.has(c.id))
        .map(c => ({
          ...c,
          proposalFingerprint: receipts.get(c.id)?.proposalFingerprint,
          pointFingerprint: receipts.get(c.id)?.pointFingerprint,
        })) ?? []
    )
  }
  /** @returns {PaneState} what a card is drawn against now */
  const paneState = () => ({
    posted: postedComments(),
    pending: pendingComments(session.state),
    submitted: session.state.submitted,
    unlinked,
    state: session.state,
  })
  /** @type {string | null} */
  let activeThread = null
  /**
   * The place the thread on the AI Chat tab is about: a saved thread's place, or the one a draft
   * was opened for. Undefined for a thread about the whole PR.
   * @type {ChatContext | undefined}
   */
  let openPlace
  /** The reader's `chatThreadPerPlace`: an ask opens the thread of its place, or the open one. */
  let threadPerPlace = options.threadPerPlace ?? true
  /** @type {import('./contract-types.js').ChatThreadsResponse['threads']} */
  let threads = []
  /** The agent a new thread would use: a thread of another agent is not continued. */
  let agentName = ''
  /**
   * The question whose answer is coming in. The answer keeps arriving while the reader reads
   * another thread, drawn into its own turns, which go back on screen with their thread.
   * @type {Question & { user: HTMLElement, answer: HTMLElement, shown: boolean, redraw: () => void } | null}
   */
  let live = null
  /**
   * A question asked in another thread while an answer comes in. The server answers one question
   * of a review at a time, so it is sent once that answer ends; one waits at a time.
   * @type {Question & { user: HTMLElement, shown: boolean } | null}
   */
  let queued = null
  /**
   * Questions that never reached the agent while their thread was off screen, with the reason in
   * their answer. The server saved nothing of them, so they go back on screen with their thread.
   * @type {Array<Question & { user: HTMLElement, answer: HTMLElement }>}
   */
  const refused = []
  /** Set once the pane is taken down: a turn that ends after it starts nothing. */
  let stopped = false
  /**
   * The answers the reader has not seen, counted by thread: one that ended while the reader was
   * reading another thread, or while the AI Chat tab was off screen. An answer comes in only while
   * the page is open, so this lives as long as the page does.
   * @type {Map<string, number>}
   */
  const unseen = new Map()
  /** Whether the pane is on screen, as the panel last drew it. */
  let paneShown = false
  /** Whether the reader sees the AI Chat tab, and with it the open thread. */
  const chatOnScreen = () => paneShown && pane.getAttribute('data-tab') === 'chat'
  /**
   * The badge on every ask command whose place has a thread, as CSS: cards drawn later, and the
   * selection toolbar, pick it up without being visited.
   */
  const marks = document.createElement('style')
  marks.id = 'chat-thread-marks'
  root.append(marks)
  let stopActivity = () => {}
  /** The turn in flight, so taking the pane down stops its request too. */
  /** @type {AbortController | null} */
  let inFlight = null
  /** @type {number | ReturnType<typeof setTimeout>} */
  let frame = 0
  let turnSeq = 0
  /**
   * Counts the things that replace the whole transcript. A history load that comes back after
   * one of them reads a number that has moved on, and leaves the log to whoever owns it now.
   */
  let logSeq = 0
  /** True while a thread is being drawn: the scrolling that comes with a redraw is not the reader's. */
  let restoring = false

  /** Takes the log over and returns the number that says so. */
  const claimLog = () => {
    logSeq += 1
    restoring = false
    // What the log showed goes, the answer coming in and the waiting question with it.
    if (live !== null) live.shown = false
    if (queued !== null) queued.shown = false
    return logSeq
  }

  const applyWidth = /** @param {number} width */ width => {
    root.style.setProperty('--chat-w', `${clampWidth(width)}px`)
    const handle = qs('#chat-handle', root)
    handle?.setAttribute('aria-valuenow', String(clampWidth(width)))
  }
  applyWidth(readChatWidth(storage))

  const layerTitle = /** @param {string} id */ id => session.artifact.layers.find(l => l.id === id)?.title
  const pointTitle = /** @param {string} fp */ fp =>
    session.artifact.points.find(p => p.fingerprint === fp)?.title
  const currentThread = () => threads.find(t => t.name === activeThread)
  /**
   * Whether a place is on the canvas on screen. A thread outlives the canvas it was made on, and a
   * question about a place the canvas no longer has is refused.
   * @param {ChatContext} place
   */
  const onCanvas = place => {
    switch (place.kind) {
      case 'point':
        return pointTitle(place.fingerprint) !== undefined
      case 'layer':
        return layerTitle(place.layerId) !== undefined
      case 'file':
      case 'lines':
        return paths.has(place.path)
      case 'pr':
        return true
    }
  }
  /**
   * What a question asked in a thread about `place` is about: that place while the canvas has it,
   * else the whole PR.
   * @param {ChatContext | undefined} place
   * @returns {ChatContext}
   */
  const askedIn = place => (place !== undefined && onCanvas(place) ? place : WHOLE_PR)
  /**
   * What a sent message names above its text, so a reader scrolling back sees what each question
   * was about. A message about the whole PR, about the thread's own place, or one saved before
   * turns kept a context, names none.
   * @param {ChatContext | undefined} about
   */
  const turnContext = about =>
    about === undefined ||
    about.kind === 'pr' ||
    (openPlace !== undefined && sameChatContext(openPlace, about))
      ? {}
      : { context: chatContextLabel(about, layerTitle, pointTitle) }
  /**
   * A place as the head and the Threads tab name it: without its kind, which the head's tag and
   * the tab's group already say.
   * @param {ChatContext} anchor
   */
  const placeName = anchor =>
    anchor.kind === 'pr' ? 'whole PR' : chatContextName(anchor, layerTitle, pointTitle)
  /**
   * A thread as the head and the index name it: by its place while the canvas has it, by the title
   * it was saved with otherwise.
   * @param {(typeof threads)[number]} thread
   */
  const shownTitle = thread =>
    thread.anchor !== undefined && onCanvas(thread.anchor) ? placeName(thread.anchor) : thread.title

  const drawHead = () => {
    const thread = currentThread()
    const title =
      thread !== undefined
        ? shownTitle(thread)
        : openPlace !== undefined
          ? placeName(openPlace)
          : 'New thread'
    const gone = openPlace !== undefined && !onCanvas(openPlace)
    threadTitleEl.textContent = gone ? `${title} · not on this canvas` : title
    threadTitleEl.title = threadTitleEl.textContent
    // The tag says what kind of place the title names; a thread about the whole PR has none.
    const kind = openPlace === undefined || openPlace.kind === 'pr' || gone ? '' : openPlace.kind
    threadKindEl.hidden = kind === ''
    threadKindEl.textContent = kind
    gotoButton.hidden = askedIn(openPlace).kind === 'pr'
    drawComposer()
  }

  /**
   * The thread whose answer is coming in, as running text names it, so a question that waits for
   * it says which one it waits for.
   */
  const answeringName = () => (live === null ? '' : threadLabel(live))

  /**
   * A thread, or a draft's place, as running text names it: with the kind of its place, since no
   * tag or group says it there.
   * @param {(typeof threads)[number] | undefined} thread
   * @param {ChatContext | undefined} draftPlace
   */
  const runningName = (thread, draftPlace) => {
    const place = thread !== undefined ? thread.anchor : draftPlace
    if (place !== undefined && onCanvas(place)) {
      return chatContextLabel(place, layerTitle, pointTitle)
    }
    return thread !== undefined ? thread.title : 'New thread'
  }

  /**
   * A question's thread, as running text names it.
   * @param {Question} question
   */
  const threadLabel = question =>
    runningName(
      threads.find(t => t.name === question.thread),
      question.place
    )

  /**
   * The composer of the thread on screen: stop while its own answer comes in; while another
   * thread's answer does, a box whose question waits for that answer, until one is waiting.
   */
  const drawComposer = () => {
    const answeringHere = live !== null && live.shown
    sendButton.hidden = answeringHere
    stopButton.hidden = !answeringHere
    box.disabled = answeringHere || queued !== null
    // A box that cannot take a question has no send either.
    sendButton.disabled = queued !== null
    box.placeholder =
      queued !== null
        ? `A question already waits for the answer in “${answeringName()}”.`
        : live !== null && !answeringHere
          ? `AI Chat is answering in “${answeringName()}”. Ask here and it goes next…`
          : askedIn(openPlace).kind === 'pr'
            ? 'Ask AI Chat about this PR…'
            : 'Ask about this, in this thread…'
  }

  /** Shows the open thread, in the AI Chat tab. */
  const showThread = () => {
    selectSideTab(pane, 'chat')
    drawHead()
    seeOpenThread()
  }

  /**
   * The Threads tab's group for each kind of place, in the order the tab draws them. Typed over
   * every kind, so a new kind of place does not build until it has a group.
   * @type {Record<ChatContext['kind'], string>}
   */
  const INDEX_LABELS = {
    point: 'Attention points',
    lines: 'Lines',
    file: 'Files',
    layer: 'Layers',
    pr: 'Whole PR',
  }
  const INDEX_GROUPS = /** @type {Array<[ChatContext['kind'], string]>} */ (Object.entries(INDEX_LABELS))

  const drawIndex = () => {
    // The thread's name counts the threads with an answer not seen yet, at the end by the list's
    // caret: the answer can be in any thread, not only the one named.
    const fresh = unseen.size
    for (const note of Array.from(root.querySelectorAll('.threads-new'))) {
      note.toggleAttribute('hidden', fresh === 0)
      note.textContent = `${fresh} new`
      note.setAttribute(
        'title',
        fresh === 1
          ? 'A thread has an answer you have not seen'
          : `${fresh} threads have an answer you have not seen`
      )
    }
    // The AI Chat tab and its launcher count every answer not seen yet, up to 9.
    const count = [...unseen.values()].reduce((sum, n) => sum + n, 0)
    const counted = count === 1 ? '1 answer you have not seen' : `${count} answers you have not seen`
    for (const badge of Array.from(root.querySelectorAll('.chat-new'))) {
      badge.toggleAttribute('hidden', count === 0)
      badge.textContent = String(Math.min(count, 9))
      badge.setAttribute('aria-label', counted)
      badge.setAttribute('title', counted)
    }
    // A thread's first question is in no list until the server has made the thread, which takes
    // the review checkout and the agent's session first. Until then it is listed by its place.
    const drafts = /** @type {Array<{ place: ChatContext | undefined, status: string }>} */ ([
      ...(live !== null && live.thread === null ? [{ place: live.place, status: 'starting…' }] : []),
      ...(queued !== null && queued.thread === null
        ? [{ place: queued.place, status: 'question waiting' }]
        : []),
    ])
    if (threads.length === 0 && drafts.length === 0) {
      index.innerHTML =
        '<p class="empty">No threads yet. Use ask on an attention point, a selection of lines, a file or a layer, or start a thread about the whole PR.</p>'
      return
    }
    // A redraw while the list is open keeps the reader's filter and the thread they are on.
    const focused = document.activeElement?.closest?.('[data-thread-open]')?.getAttribute('data-thread-open')
    index.innerHTML = INDEX_GROUPS.map(([kind, label]) => {
      const group = threads.filter(t => (t.anchor?.kind ?? 'pr') === kind)
      const unsaved = drafts
        .filter(d => (d.place?.kind ?? 'pr') === kind)
        .map(
          d =>
            `<li><button type="button" class="thread-item${activeThread === null && sameChatContext(d.place ?? WHOLE_PR, openPlace ?? WHOLE_PR) ? ' current" aria-current="true' : ''}" data-draft-open${chatContextAttrs(d.place ?? WHOLE_PR)}>` +
            `<span class="thread-item-t">${esc(d.place === undefined ? 'New thread' : placeName(d.place))}</span>` +
            `<span class="small muted">${esc(d.status)}</span></button></li>`
        )
        .join('')
      if (group.length === 0 && unsaved === '') return ''
      const items = group
        .map(t => {
          const status =
            t.name === live?.thread
              ? 'answering…'
              : t.name === queued?.thread
                ? 'question waiting'
                : unseen.has(t.name)
                  ? 'new answer'
                  : t.turns === 1
                    ? '1 question'
                    : `${t.turns} questions`
          return (
            `<li><button type="button" class="thread-item${t.name === activeThread ? ' current" aria-current="true' : ''}" data-thread-open="${esc(t.name)}" title="${esc(itemTooltip(t))}">` +
            `<span class="thread-item-t">${esc(shownTitle(t))}</span>` +
            `<span class="small ${status === 'new answer' ? 'thread-new' : 'muted'}">${esc(status)}</span></button></li>`
          )
        })
        .join('')
      return `<h3 class="thread-group">${esc(label)}</h3><ul class="thread-list">${items}${unsaved}</ul>`
    }).join('')
    threadList.refilter()
    if (focused !== undefined && focused !== null) {
      ;/** @type {HTMLElement | null} */ (qs(`[data-thread-open="${cssEscape(focused)}"]`, index))?.focus()
    }
  }

  /**
   * An entry's tooltip: its whole name, cut short in the list, and when it started, which tells
   * apart threads of the same name.
   * @param {(typeof threads)[number]} thread
   */
  const itemTooltip = thread => {
    const started = timeAgo(thread.createdAt)
    return started === '' ? shownTitle(thread) : `${shownTitle(thread)} · started ${started}`
  }

  /**
   * The unsent text of each thread, by its name, or by its place for a draft, so a switch does
   * not carry a half-written question into another thread.
   * @type {Map<string, string>}
   */
  const unsent = new Map()
  const unsentKey = () => activeThread ?? `place:${JSON.stringify(openPlace ?? WHOLE_PR)}`
  /** Keeps what the box holds for the thread on screen; call before the pane leaves it. */
  const keepUnsent = () => {
    if (box.value.trim() === '') {
      unsent.delete(unsentKey())
    } else {
      unsent.set(unsentKey(), box.value)
    }
  }
  /**
   * Puts back what the thread now on screen had in the box, and below it any text the switch
   * carried from the thread it left.
   * @param {string | undefined} carry
   */
  const restoreUnsent = carry => {
    const own = unsent.get(unsentKey()) ?? ''
    box.value = carry === undefined ? own : own.trim() === '' ? carry : `${own}\n\n${carry}`
  }

  /** Puts the focus in the message box, or on the thread's name while the box waits. */
  const focusBox = () => {
    if (box.disabled) {
      switchButton.focus()
    } else {
      box.focus()
    }
  }

  /**
   * @param {ChatContext} anchor
   * @returns {string | null}
   */
  const askSelector = anchor => {
    const ask = '[data-act="ask"]'
    switch (anchor.kind) {
      case 'point':
        return `${ask}[data-ask-point="${cssEscape(anchor.fingerprint)}"]`
      case 'layer':
        return `${ask}[data-ask-layer="${cssEscape(anchor.layerId)}"]`
      case 'file':
        return `${ask}[data-ask-path="${cssEscape(anchor.path)}"]:not([data-ask-start])`
      case 'lines':
        return (
          `${ask}[data-ask-path="${cssEscape(anchor.path)}"][data-ask-side="${anchor.side}"]` +
          `[data-ask-start="${anchor.start}"][data-ask-end="${anchor.end}"]`
        )
      case 'pr':
        return null
    }
  }
  const drawMarks = () => {
    // Off, an ask never opens the thread its dot would mark.
    if (!threadPerPlace) {
      marks.textContent = ''
      return
    }
    marks.textContent = threads
      .flatMap(t => {
        // Only the thread an ask would open is marked: this agent's, as `threadOfPlace` picks it.
        const selector =
          t.anchor === undefined || t.turns === 0 || threadOfPlace(threads, agentName, t.anchor) !== t
            ? null
            : askSelector(t.anchor)
        if (selector === null) {
          return []
        }
        return [
          unseen.has(t.name)
            ? `${selector} > .ask-label::after { content: "" / "new answer"; --ask-dot: var(--accent); }`
            : `${selector} > .ask-label::after { content: "" / "thread"; }`,
        ]
      })
      .join('\n')
  }

  const drawContext = () => {
    chip.textContent = chatContextLabel(context, layerTitle, pointTitle)
    chip.title = chip.textContent
    clearButton.hidden = context.kind === 'pr'
    const menu = quickQuestionsFor(context).length > 0
    chip.toggleAttribute('data-ask-menu', menu)
    if (!menu) {
      chip.removeAttribute('tabindex')
      chip.removeAttribute('aria-expanded')
    } else {
      chip.tabIndex = 0
    }
    // The quick-question menu reads the target off the chip, so the chip carries it too.
    for (const name of [
      'data-ask-layer',
      'data-ask-path',
      'data-ask-side',
      'data-ask-start',
      'data-ask-end',
      'data-ask-point',
    ]) {
      chip.removeAttribute(name)
    }
    for (const pair of chatContextAttrs(context).matchAll(/([a-z-]+)="([^"]*)"/g)) {
      chip.setAttribute(pair[1] ?? '', unescapeAttr(pair[2] ?? ''))
    }
  }

  const drawBubble = () => {
    const label = unseenLabel(scroll)
    bubble.hidden = label === null
    bubble.textContent = label ?? ''
  }

  /** @param {'follow' | 'jump'} reason */
  const scrollToBottom = reason => {
    log.scrollTo?.({ top: log.scrollHeight, behavior: scrollBehavior(reason, reducedMotion) })
    log.scrollTop = log.scrollHeight
  }

  /** @param {import('./chat-scroll.js').ChatScrollAction} action */
  const dispatch = action => {
    scroll = chatScrollReducer(scroll, action)
    drawBubble()
  }

  const emptyNote = () => {
    const note = log.querySelector('.empty')
    note?.remove()
  }

  /**
   * Adds one turn and returns the element its body is drawn into, so a streamed answer can be
   * redrawn without looking it up again.
   * @param {ChatTurn['role']} role
   * @param {string} html
   * @param {TurnOpts} [opts]
   * @returns {{ turn: HTMLElement, body: HTMLElement }}
   */
  const appendTurn = (role, html, opts = {}) => {
    emptyNote()
    const wasPinned = scroll.pinned
    const made = makeTurn(role, html, opts)
    log.appendChild(made.turn)
    dispatch({ type: 'append', id: made.turn.id, belowFold: !wasPinned })
    if (scroll.pinned) {
      scrollToBottom('follow')
    }
    return made
  }

  /**
   * One turn, not yet on screen: an answer whose thread the reader left is drawn off screen.
   * @param {ChatTurn['role']} role
   * @param {string} html
   * @param {TurnOpts} [opts]
   * @returns {{ turn: HTMLElement, body: HTMLElement }}
   */
  const makeTurn = (role, html, opts = {}) => {
    turnSeq += 1
    const turn = document.createElement('div')
    turn.className = `turn ${role === 'assistant' ? 'a' : 'u'}`
    turn.id = `chat-turn-${turnSeq}`
    turn.innerHTML = turnInnerHtml(role, html, opts)
    const body = turn.querySelector('.prose')
    return { turn, body: body instanceof HTMLElement ? body : turn }
  }

  /**
   * Redraws a streaming answer at most once per frame: a chunk every few milliseconds must not
   * mean a markdown parse every few milliseconds.
   * @param {HTMLElement} body the turn's `.prose` element
   * @param {() => string} html
   */
  const scheduleRender = (body, html) => {
    if (frame !== 0) {
      return
    }
    // requestAnimationFrame is what batches the redraws; setTimeout stands in for it in a test
    // environment that has none.
    const run = () => {
      frame = 0
      body.innerHTML = html()
      // An answer drawn off screen leaves the log on screen where it is.
      if (scroll.pinned && body.isConnected) {
        scrollToBottom('follow')
      }
    }
    frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16)
  }

  /** @param {number | ReturnType<typeof setTimeout>} handle */
  const cancelFrame = handle => {
    if (typeof handle === 'number' && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(handle)
      return
    }
    clearTimeout(handle)
  }

  /**
   * Takes the review's thread list. The open thread stays the pane's own: a draft is in no list,
   * and a turn names its thread before the list is fetched again. Once the list holds the open
   * thread, its place is the one the server keeps: a draft's question can land in a thread with
   * no place, after the setting changed or the place left the canvas.
   * @param {import('./contract-types.js').ChatThreadsResponse} data
   */
  const drawThreads = data => {
    threads = data.threads
    agentName = data.agent
    const open = currentThread()
    if (open !== undefined) {
      openPlace = open.anchor
      if (threadPerPlace) {
        context = askedIn(openPlace)
        drawContext()
      }
    }
    drawIndex()
    drawHead()
    drawMarks()
    drawBackLinks()
  }

  /**
   * A draft's way back names its thread as the list now does, so a thread the server titled after
   * the link was drawn reads by its title and not as a new thread.
   */
  const drawBackLinks = () => {
    for (const el of Array.from(log.querySelectorAll('.empty [data-thread-open]'))) {
      const thread = threads.find(t => t.name === el.getAttribute('data-thread-open'))
      if (thread !== undefined) el.textContent = `back to “${runningName(thread, undefined)}”`
    }
  }

  /**
   * Draws a thread's saved turns. The log is emptied first, so a question asked while the turns
   * are still on their way is asked into the thread it belongs to and not under another one's.
   * @param {string} name
   */
  const loadHistory = async name => {
    const seq = claimLog()
    restoring = true
    proposed.clear()
    log.innerHTML = '<p class="empty">Opening this thread…</p>'
    const { turns } = await api.fetchThreadHistory(prNumber, name)
    if (seq !== logSeq) {
      return
    }
    proposed.clear()
    log.innerHTML =
      turns.length === 0
        ? '<p class="empty">Ask AI Chat about a layer, a file, or a selection. Answers come with a verdict first, then evidence.</p>'
        : turns
            .map((turn, i) =>
              turnHtml(
                turn.role,
                turn.role === 'assistant'
                  ? answerHtml(turn.text, targets, proposed, paths, {
                      turnKey: `history-${i}`,
                      ...paneState(),
                    })
                  : renderMarkdown(turn.text, { paths }),
                {
                  ...(turn.incomplete === undefined ? {} : { incomplete: turn.incomplete }),
                  ...(turn.fallback === undefined ? {} : { fallback: turn.fallback }),
                  ...(turn.role === 'user' ? turnContext(turn.context) : {}),
                }
              )
            )
            .join('')
    putBackPending(turns)
    const saved = scrollTops.get(name)
    dispatch({ type: 'thread-switch', pinned: saved === undefined })
    if (saved === undefined) {
      scrollToBottom('follow')
    } else {
      log.scrollTop = saved
    }
    restoring = false
  }

  /**
   * Whether a question belongs to the thread on screen: the same saved thread, or the draft of
   * the same place.
   * @param {Question} question
   */
  const isHere = question =>
    question.thread !== null
      ? question.thread === activeThread
      : activeThread === null && sameChatContext(question.place ?? WHOLE_PR, openPlace ?? WHOLE_PR)

  /**
   * Puts back the turns the saved transcript does not hold yet, when they belong to the thread on
   * screen: the answer coming in, and the question waiting for it.
   * @param {ReadonlyArray<ChatTurn>} [saved] the thread's saved turns
   */
  const putBackPending = (saved = []) => {
    if (live !== null && isHere(live)) {
      emptyNote()
      // The server saves a question once its turn starts, so the transcript may hold it already.
      const last = saved[saved.length - 1]
      if (!(last?.role === 'user' && last.text === live.message)) {
        log.append(live.user)
      }
      log.append(live.answer)
      live.shown = true
      // Opening the thread cleared the proposals the answer had drawn; drawing it again brings
      // them back, against the state they are in now.
      live.redraw()
    }
    putBackRefused()
    if (queued !== null && isHere(queued)) {
      emptyNote()
      log.append(queued.user)
      queued.shown = true
    }
    drawComposer()
  }

  /**
   * Puts back, once, the questions refused while their thread was off screen that belong to the
   * thread on screen. A refused question from new thread has no saved thread, so the next new
   * thread takes it back: it failed already, so nothing new mixes with it.
   */
  const putBackRefused = () => {
    for (const turn of refused.filter(isHere)) {
      emptyNote()
      log.append(turn.user, turn.answer)
      refused.splice(refused.indexOf(turn), 1)
    }
  }

  /**
   * The answer as HTML. A redraw replaces this turn's cards and leaves every other turn's alone.
   * @param {string} text
   * @param {string} turnKey
   */
  const renderAnswer = (text, turnKey) => {
    for (const key of [...proposed.keys()]) {
      if (key.startsWith(`${turnKey}-`)) {
        proposed.delete(key)
      }
    }
    return answerHtml(text, targets, proposed, paths, { turnKey, ...paneState() })
  }

  /**
   * Sends what the box holds, or has it wait for the answer coming in. It does not wait for the
   * answer itself: the reader may be on another thread by the time it ends.
   */
  /**
   * @param {string} [asked] a question asked for the reader, such as a quick one; the box, and
   *   what the reader wrote in it, stay as they are
   */
  const send = asked => {
    const message = (asked ?? box.value).trim()
    if (message === '' || box.disabled) {
      return
    }
    if (asked === undefined) {
      box.value = ''
      unsent.delete(unsentKey())
    }
    /** @type {Question} */
    const question = { message, context, thread: activeThread, place: openPlace }
    const { turn } = appendTurn('user', renderMarkdown(message, { paths }), turnContext(context))
    if (live !== null) {
      turn.insertAdjacentHTML(
        'beforeend',
        `<p class="muted small chat-waiting">Waiting for the answer in “${esc(answeringName())}”. It is sent as soon as that answer ends.</p>`
      )
      queued = { ...question, user: turn, shown: true }
      drawComposer()
      drawIndex()
      return
    }
    void runTurn(question, turn, true)
  }

  /**
   * Sends a question and draws its answer as it comes in, on screen while its thread is, and off
   * screen otherwise. A question that waited for it goes next.
   * @param {Question} question
   * @param {HTMLElement} user the question's turn
   * @param {boolean} shown whether the question's thread is on screen
   */
  const runTurn = async (question, user, shown) => {
    if (shown) {
      // The turn owns the log from here on, so a history load still on its way lands nowhere.
      claimLog()
      dispatch({ type: 'send' })
      scrollToBottom('follow')
    }
    const answer = shown ? appendTurn('assistant', '') : makeTurn('assistant', '')
    const current = { ...question, user, answer: answer.turn, shown, redraw: () => {} }
    live = current
    // A first question's thread is listed by its place until the server names it.
    drawIndex()
    /** Whether the agent took the turn: until then there is no answer to have missed. */
    let agentTookTurn = false
    const activity = document.createElement('p')
    activity.className = 'muted small chat-activity'
    activity.setAttribute('aria-live', 'off')
    answer.turn.append(activity)
    const started = Date.now()
    /** What the turn is waiting on: the answer, or a review checkout first. */
    let phase = 'Preparing answer'
    const updateActivity = () => {
      const elapsed = Date.now() - started
      activity.textContent = `${phase}${'.'.repeat((Math.floor(elapsed / 400) % 3) + 1)} · ${Math.floor(elapsed / 1000)}s`
    }
    updateActivity()
    const timer = setInterval(updateActivity, 400)
    stopActivity = () => clearInterval(timer)
    const toolDetails = document.createElement('details')
    toolDetails.className = 'chat-tool-calls muted small'
    toolDetails.hidden = true
    answer.turn.append(toolDetails)
    const tools = new Map()
    const turnKey = answer.turn.id
    drawComposer()
    drawIndex()
    let text = ''
    current.redraw = () => {
      if (text !== '') {
        answer.body.innerHTML = renderAnswer(text, turnKey)
      }
    }
    const request = new AbortController()
    inFlight = request
    try {
      await api.streamChat(
        prNumber,
        {
          message: question.message,
          context: question.context,
          ...(question.thread === null ? {} : { thread: question.thread }),
        },
        {
          signal: request.signal,
          onEvent: event => {
            const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
            const field = /** @param {string} key */ key => data[key]
            const thread = field('thread')
            if (event.event === 'turn' && typeof thread === 'string') {
              current.thread = thread
              agentTookTurn = true
              // A draft's question names its thread here; the reader may be reading another one.
              // The thread on screen is the one a reload opens, which only the pane knows.
              if (current.shown) {
                activeThread = thread
                void api.selectThread(prNumber, thread).catch(() => undefined)
              }
              void refreshThreads()
              // The checkout, if there was one, is done once the turn starts.
              phase = 'Preparing answer'
              activity.classList.remove('checking-out')
              updateActivity()
              return
            }
            if (event.event === 'checkout') {
              const checkout = /** @type {import('./contract-types.js').ChatCheckoutEvent} */ ({
                event: 'checkout',
                ...data,
              })
              if (checkout.status === 'preparing') {
                phase = checkoutActivityText(checkout)
                activity.classList.add('checking-out')
                updateActivity()
              } else {
                answer.turn
                  .querySelector('.role')
                  ?.insertAdjacentHTML('afterend', checkoutWarningHtml(checkout))
              }
              return
            }
            if (event.event === 'tool') {
              const id = String(field('id') ?? '')
              const previous = tools.get(id)
              const title = String(field('title') ?? 'tool')
              tools.delete(id)
              tools.set(id, {
                title: title === 'tool' && previous ? previous.title : title,
                status: String(field('status') ?? 'pending'),
              })
              toolDetails.hidden = false
              const latest = tools.get(id)
              toolDetails.innerHTML = `<summary>${esc(latest.title)} · ${esc(latest.status)} (${tools.size} tool calls)</summary><ul>${[...tools.values()].map(t => `<li>${esc(t.title)} · ${esc(t.status)}</li>`).join('')}</ul>`
              return
            }
            const chunk = field('text')
            if (event.event === 'chunk' && typeof chunk === 'string') {
              text += chunk
              // An answer growing out of sight is one thing to catch up on, however many chunks
              // it arrives in; catching up clears the count, so drifting away again counts anew.
              if (current.shown && !scroll.pinned && scroll.unseen === 0) {
                dispatch({ type: 'append', id: turnKey, belowFold: true })
              }
              scheduleRender(answer.body, () => renderAnswer(text, turnKey))
              return
            }
            if (event.event === 'error') {
              // In the answer it belongs to, which may be off screen by now.
              answer.turn.insertAdjacentHTML(
                'beforeend',
                `<p class="chat-warning small" role="alert">${esc(String(field('message') ?? 'the agent failed'))}</p>`
              )
              return
            }
            if (event.event === 'cancelled') {
              answer.turn.insertAdjacentHTML('beforeend', '<p class="muted small">stopped</p>')
            }
          },
        }
      )
    } catch (error) {
      // A question the server refused, or that never reached it, says so in its own answer. One
      // the pane gave up on, as it was taken down, has nothing left to say it in.
      if (!request.signal.aborted) {
        const reason = error instanceof Error ? error.message : String(error)
        answer.turn.insertAdjacentHTML(
          'beforeend',
          `<p class="chat-warning small" role="alert">${esc(reason)}</p>`
        )
        // A question the agent never took, off screen: the reader hears of it where they are, and
        // finds it in its thread. One the agent took is in the transcript already, and its thread
        // is marked as having a new answer below.
        if (!current.shown && !agentTookTurn) {
          refused.push(current)
          toast(root, `Your question in “${threadLabel(current)}” was not sent: ${reason}`, { failed: true })
        }
      }
    } finally {
      inFlight = null
      live = null
      // A pane taken down has nothing on screen to finish, and nothing to send after this turn.
      if (!stopped) {
        // An answer that ended off screen waits to be seen, marked on its place, in Threads, and
        // counted on the AI Chat tab and launcher. Its own thread is off screen too while the
        // pane is minimized or shows another tab.
        if ((!current.shown || !chatOnScreen()) && current.thread !== null && agentTookTurn) {
          setUnseen(current.thread, (unseen.get(current.thread) ?? 0) + 1)
        }
        void refreshThreads().catch(() => undefined)
        stopActivity()
        toolDetails.open = false
        const toolSummary = toolDetails.querySelector('summary')
        if (toolSummary) toolSummary.textContent = `${tools.size} tool calls`
        activity.textContent = `Elapsed: ${Math.floor((Date.now() - started) / 1000)}s`
        if (frame !== 0) {
          cancelFrame(frame)
          frame = 0
        }
        answer.body.innerHTML =
          text === '' ? '<span class="muted">no answer</span>' : renderAnswer(text, turnKey)
        if (current.shown && scroll.pinned) {
          scrollToBottom('follow')
        }
        const next = queued
        queued = null
        drawComposer()
        drawIndex()
        if (next !== null) {
          next.user.querySelector('.chat-waiting')?.remove()
          void runTurn(next, next.user, next.shown)
        }
      }
    }
  }

  const refreshThreads = async () => {
    drawThreads(await api.fetchThreads(prNumber))
  }

  /** On the first render, the thread that was open last time comes back with its transcript. */
  const restoreThread = async () => {
    const seq = claimLog()
    const data = await api.fetchThreads(prNumber)
    // A question sent while the thread list was on its way owns the pane now.
    if (seq !== logSeq) {
      return
    }
    activeThread = data.activeThread
    openPlace = data.threads.find(t => t.name === activeThread)?.anchor
    context = askedIn(openPlace)
    drawContext()
    // Answers the reader had not seen before the reload are still marked.
    for (const t of data.threads) {
      if (t.unseen !== undefined && t.unseen > 0) unseen.set(t.name, t.unseen)
    }
    drawThreads(data)
    seeOpenThread()
    if (activeThread !== null) {
      await loadHistory(activeThread)
    }
  }

  /**
   * Counts a thread's answers the reader has not seen, here and on the server, so a reload still
   * marks them. Zero clears the mark.
   * @param {string} name
   * @param {number} count
   */
  const setUnseen = (name, count) => {
    if (count === 0) {
      unseen.delete(name)
    } else {
      unseen.set(name, count)
    }
    void api.markThreadUnseen(prNumber, name, count).catch(() => undefined)
  }

  /** The open thread's new answers are seen once the AI Chat tab is on screen. */
  const seeOpenThread = () => {
    if (activeThread !== null && unseen.has(activeThread) && chatOnScreen()) {
      setUnseen(activeThread, 0)
      drawMarks()
      drawIndex()
    }
  }

  /**
   * Opens a saved thread, with its place as the context of what is asked in it.
   * @param {string} name
   * @param {{ carry?: string }} [opts] `carry`: text the reader takes along from the thread left
   */
  const openThread = async (name, opts = {}) => {
    keepUnsent()
    activeThread = name
    if (unseen.has(name)) setUnseen(name, 0)
    drawMarks()
    openPlace = currentThread()?.anchor
    context = askedIn(openPlace)
    drawContext()
    restoreUnsent(opts.carry)
    showThread()
    drawIndex()
    void api.selectThread(prNumber, name).catch(() => undefined)
    await loadHistory(name)
  }

  /**
   * Opens a thread not made yet: a place's, or one about the whole PR. Nothing is saved until its
   * first message, which the server files under that place. A draft whose question is being
   * answered, or waits, comes back with that question, unless the reader asked for a fresh one.
   * An ask leaves the thread the reader was reading unasked for, so a draft an ask opened leads
   * back to it until its first question; new thread, clear, and the list are the reader's own move.
   * @param {ChatContext} anchor
   * @param {{ fresh?: boolean, back?: boolean, carry?: string }} [opts]
   */
  const openDraft = (anchor, opts = {}) => {
    const left = currentThread()
    // A draft whose first question is still on its way has no thread yet; the way back is its place.
    const leftDraft =
      left === undefined && [live, queued].some(q => q !== null && q.thread === null && isHere(q))
        ? (openPlace ?? WHOLE_PR)
        : undefined
    keepUnsent()
    claimLog()
    activeThread = null
    openPlace = anchor.kind === 'pr' ? undefined : anchor
    context = anchor
    drawContext()
    restoreUnsent(opts.carry)
    proposed.clear()
    const back =
      opts.back !== true
        ? ''
        : left !== undefined
          ? ` <button class="cmd" type="button" data-thread-open="${esc(left.name)}">back to “${esc(runningName(left, undefined))}”</button>`
          : leftDraft !== undefined && !sameChatContext(leftDraft, anchor)
            ? ` <button class="cmd" type="button" data-draft-open${chatContextAttrs(leftDraft)}>back to “${esc(runningName(undefined, leftDraft.kind === 'pr' ? undefined : leftDraft))}”</button>`
            : ''
    log.innerHTML =
      anchor.kind === 'pr'
        ? `<p class="empty">A new thread about the whole PR.${back}</p>`
        : `<p class="empty">A new thread about ${esc(chatContextLabel(anchor, layerTitle, pointTitle))}. Asking about it again comes back here.${back}</p>`
    dispatch({ type: 'thread-switch', pinned: true })
    if (opts.fresh === true) {
      putBackRefused()
    } else {
      putBackPending()
    }
    showThread()
    drawIndex()
  }

  /**
   * Shows the thread of a place: the one on screen, the one it has, or a new one. An answer coming
   * in elsewhere keeps arriving in its own thread.
   * @param {ChatContext} next
   * @param {{ fromAsk?: boolean, carry?: string }} [opts] `fromAsk`: an ask opened it, so a new
   *   draft leads back; `carry`: text the reader takes along
   */
  const goToThread = async (next, opts = {}) => {
    if (sameChatContext(openPlace ?? WHOLE_PR, next)) {
      showThread()
      return
    }
    const carry = opts.carry === undefined ? {} : { carry: opts.carry }
    const placed = threadOfPlace(threads, agentName, next)
    if (placed === undefined) {
      openDraft(next, { back: opts.fromAsk === true, ...carry })
    } else {
      await openThread(placed.name, carry)
    }
  }

  /** @param {Event} event */
  const onSubmit = event => {
    event.preventDefault()
    send()
  }

  /** @param {Event} event */
  const onClick = event => {
    const el = event.target instanceof Element ? event.target.closest('button') : null
    if (!(el instanceof HTMLElement)) {
      return
    }
    if (el.id === 'chat-clear') {
      // A thread keeps one place, so leaving a place's thread for the whole PR opens the whole
      // PR's thread. What the box holds goes along, under what that thread had of its own.
      if (threadPerPlace && openPlace !== undefined) {
        const carried = box.value
        box.value = ''
        void goToThread(WHOLE_PR, carried.trim() === '' ? {} : { carry: carried })
      } else {
        setContext(WHOLE_PR)
      }
      // The command hides once the context is the whole PR, so the focus goes on to the box.
      focusBox()
      return
    }
    if (el.id === 'chat-stop') {
      void runCommand(el, () => api.cancelChat(prNumber), { pendingLabel: 'stopping…' })
      return
    }
    if (el.id === 'thread-switch') {
      threadList.toggle()
      return
    }
    if (el.id === 'new-thread' || el.id === 'chat-new-thread') {
      threadList.close()
      openDraft(WHOLE_PR, { fresh: true })
      focusBox()
      return
    }
    if (el.id === 'thread-goto') {
      goToAnchor()
      return
    }
    if (el.hasAttribute('data-draft-open')) {
      // A thread whose first question is on its way: its draft, with that question. Once the
      // server has made it, the thread itself.
      threadList.close()
      const place = chatContextFromElement(el)
      const pending = [live, queued].some(
        q => q !== null && q.thread === null && sameChatContext(q.place ?? WHOLE_PR, place)
      )
      if (pending) {
        openDraft(place)
      } else {
        void goToThread(place)
      }
      focusBox()
      return
    }
    const picked = el.getAttribute('data-thread-open')
    if (picked !== null) {
      threadList.close()
      if (picked === activeThread) {
        showThread()
      } else {
        void openThread(picked)
      }
      // The list, or the draft's way back, is gone from under the focus: the box takes it.
      focusBox()
      return
    }
    if (el.id === 'chat-unseen') {
      const target = scroll.firstUnseenId === null ? null : log.querySelector(`#${scroll.firstUnseenId}`)
      dispatch({ type: 'jump' })
      if (target !== null && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start', behavior: scrollBehavior('jump', reducedMotion) })
      } else {
        scrollToBottom('jump')
      }
      return
    }
    const act = el.getAttribute('data-act')
    const entry = proposed.get(el.getAttribute('data-proposed') ?? '')
    if (entry === undefined) {
      return
    }
    if (isResolution(entry)) {
      if (act === 'resolution-save' || act === 'resolution-edit') {
        options.onResolution?.(act === 'resolution-save' ? 'save' : 'edit', entry, el)
      }
      return
    }
    if (act === 'proposed-unlink') {
      // The reader overrides the agent: the comment goes out on its own, tied to no point.
      if (entry.proposalFingerprint !== undefined) unlinked.add(entry.proposalFingerprint)
      el.closest('.proposed-point')?.remove()
      return
    }
    const what = act === null ? undefined : PROPOSED_ACTS[act]
    if (what !== undefined) {
      // The comment goes out tied to the point its card shows, and to no other.
      const { point } = sendStateOf(entry, paneState())
      const { point: _agents, ...rest } = entry
      options.onProposed?.(what, point === undefined ? rest : { ...rest, point }, el)
    }
  }

  const onScroll = () => {
    // Emptying the log puts it back to the top; that is the redraw moving, not the reader.
    if (restoring) {
      return
    }
    if (activeThread !== null) {
      scrollTops.set(activeThread, log.scrollTop)
    }
    dispatch({ type: 'scroll', atBottom: isAtBottom(log) })
  }

  /**
   * A wheel turn anywhere over the pinned pane moves the transcript, so the page does not scroll
   * out from under a reader who is reading the answer.
   * @param {WheelEvent} event
   */
  const onPaneWheel = event => {
    const target = event.target instanceof Element ? event.target : null
    // The open list of threads scrolls itself.
    if (target !== null && pop.contains(target)) {
      return
    }
    // The tab on screen owns the wheel: the transcript, or the list of the review being written.
    const tab = pane.getAttribute('data-tab')
    const scroller = (tab === 'review' ? reviewPanel : null) ?? log
    const insideOwnScroller =
      target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
        ? canScrollBy(target, event.deltaY)
        : false
    const at = {
      // The narrow layout drops the pin and the pane scrolls with the page like any other column.
      pinned: getComputedStyle(pane).position === 'sticky',
      insideTranscript: target !== null && scroller.contains(target),
      zooming: event.ctrlKey,
      insideOwnScroller,
    }
    if (!redirectsWheelToTranscript(at)) {
      return
    }
    // Consumed whether or not the list can move, so the page stays put under the pointer.
    event.preventDefault()
    scroller.scrollTop += event.deltaY
  }

  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  /** Sets the context. The same target twice is one state change, not a toggle. */
  const setContext = /** @param {ChatContext} next */ next => {
    if (sameChatContext(context, next)) {
      return false
    }
    context = next
    drawContext()
    return true
  }

  const stopResize = wireResize(pane, root, storage, applyWidth)
  const panel = wireChatPanel(root, pane, {
    minimized: readChatMinimized(storage),
    onMinimizedChange: minimized => writeChatMinimized(storage, minimized),
    onShownChange: shown => {
      paneShown = shown
      seeOpenThread()
    },
  })
  const stopTabs = wireSideTabs(pane, seeOpenThread)

  /**
   * Leads the canvas to the open thread's place, while the canvas has it. A pane floating over the
   * canvas steps aside first, as it does for a canvas link.
   */
  const goToAnchor = () => {
    const anchor = askedIn(openPlace)
    if (anchor.kind === 'pr') {
      return
    }
    panel.uncover()
    switch (anchor.kind) {
      case 'point': {
        const el = root.querySelector(`[data-point][data-fingerprint="${cssEscape(anchor.fingerprint)}"]`)
        if (el instanceof HTMLElement) {
          scrollIntoViewSafe(el)
          flash(el)
        }
        return
      }
      case 'layer': {
        const key = session.artifact.layers.find(l => l.id === anchor.layerId)?.key
        if (key !== undefined) navigateLink(`#layer:${key}`, root)
        return
      }
      case 'file':
        navigateLink(`#file:${anchor.path}`, root)
        return
      case 'lines':
        navigateLink(lineLink(anchor), root)
    }
  }
  // Whatever asks the chat for something shows its tab first.
  const openChat = () => {
    selectSideTab(pane, 'chat')
    panel.open()
    seeOpenThread()
  }

  form.addEventListener('submit', onSubmit)
  root.addEventListener('click', onClick)
  log.addEventListener('scroll', onScroll)
  pane.addEventListener('wheel', onPaneWheel, { passive: false })
  box.addEventListener('keydown', /** @type {EventListener} */ (onKeyDown))
  drawContext()
  void restoreThread().catch(() => undefined)

  return {
    get context() {
      return context
    },
    setContext,
    focusInput() {
      openChat()
    },
    /** Shows the review being written, in its tab of the pane. */
    openReview() {
      openReviewTab(pane, panel)
    },
    /** Minimizes the pane while it floats over the canvas, so the canvas under it can be used. */
    uncover() {
      panel.uncover()
    },
    /** @param {ChatContext} next */
    ask(next) {
      // Off, an ask only says what the open thread's next question is about. The thread goes on
      // screen before the pane opens, so the answers seen are its own and not the one it replaces.
      if (threadPerPlace) {
        void goToThread(next, { fromAsk: true })
      } else {
        setContext(next)
      }
      openChat()
    },
    /**
     * Follows the settings the reader saved, without a reload: whether an ask opens its place's
     * thread, and the chat agent, whose threads are the ones an ask continues.
     * @param {import('./contract-types.js').Settings} settings
     */
    followSettings(settings) {
      threadPerPlace = settings.chatThreadPerPlace
      if (threadPerPlace) {
        context = askedIn(openPlace)
        drawContext()
      }
      drawMarks()
      void refreshThreads().catch(() => undefined)
    },
    /**
     * Draws each card again where the state changed it: a comment just posted, joined the review,
     * or left it, with the point line that goes with that; a resolution's point resolved, by its
     * own command or anywhere else, dismissed, restored, or reopened. The page calls this after
     * every change of the local state, once the comments it draws from are up to date.
     */
    refreshProposed() {
      const now = paneState()
      for (const card of Array.from(log.querySelectorAll('.proposed[data-proposed]'))) {
        const id = card.getAttribute('data-proposed') ?? ''
        const entry = proposed.get(id)
        const tbtns = card.querySelector(':scope > .tbtns')
        if (entry === undefined || tbtns === null) {
          continue
        }
        if (isResolution(entry)) {
          redrawOnKey(tbtns, resolutionCommandsHtml(entry, id, now.state))
          continue
        }
        const sendState = sendStateOf(entry, now)
        redrawOnKey(tbtns, proposedCommandsHtml(entry, id, sendState))
        // The point line follows the same state: put in, changed, or taken out.
        const line = proposedPointHtml(id, sendState)
        const drawn = card.querySelector(':scope > .proposed-point')
        if (drawn !== null) {
          redrawOnKey(drawn, line)
        } else if (line !== '') {
          card.querySelector(':scope > .proposed-h')?.insertAdjacentHTML('afterend', line)
        }
      }
    },
    /**
     * Sends one of the quick questions about a target.
     * @param {ChatContext} next
     * @param {string} question
     */
    askQuestion(next, question) {
      void (async () => {
        // As for an ask, the thread goes on screen before the pane opens.
        const going = threadPerPlace ? goToThread(next, { fromAsk: true }) : null
        if (!threadPerPlace) setContext(next)
        openChat()
        await going
        if (box.disabled) {
          toast(
            root,
            live?.shown === true
              ? 'An answer is coming in here. Ask this once it ends.'
              : `A question already waits for the answer in “${answeringName()}”. Ask this once it is sent.`
          )
          return
        }
        send(question)
      })()
    },
    /** Whether a question asked here waits to be sent, which a re-render would drop. */
    holdsUnsent() {
      return queued !== null
    },
    stop() {
      stopped = true
      queued = null
      stopActivity()
      inFlight?.abort()
      inFlight = null
      if (frame !== 0) {
        cancelFrame(frame)
        frame = 0
      }
      form.removeEventListener('submit', onSubmit)
      root.removeEventListener('click', onClick)
      log.removeEventListener('scroll', onScroll)
      marks.remove()
      threadList.stop()
      box.removeEventListener('keydown', /** @type {EventListener} */ (onKeyDown))
      stopResize()
      panel.stop()
      stopTabs()
    },
  }
}

/**
 * Dragging the pane's edge changes its width, between the two bounds, and the browser remembers
 * it. Arrow keys move it too, so the handle works without a pointer.
 * @param {HTMLElement} pane
 * @param {HTMLElement} root
 * @param {Storage | null} storage
 * @param {(width: number) => void} applyWidth
 */
export function wireResize(pane, root, storage, applyWidth) {
  const handle = qs('#chat-handle', root)
  if (!(handle instanceof HTMLElement)) {
    return () => undefined
  }
  let dragging = false
  const widthNow = () => readChatWidth(storage)

  /** @param {PointerEvent} event */
  const onDown = event => {
    dragging = true
    event.preventDefault()
  }
  /** @param {PointerEvent} event */
  const onMove = event => {
    if (!dragging) {
      return
    }
    // The pane is on the right, so dragging left makes it wider.
    const width = clampWidth(window.innerWidth - event.clientX)
    applyWidth(width)
  }
  const onUp = () => {
    if (!dragging) {
      return
    }
    dragging = false
    writeChatWidth(storage, pane.getBoundingClientRect().width || widthNow())
  }
  /** @param {KeyboardEvent} event */
  const onKey = event => {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (step === 0) {
      return
    }
    event.preventDefault()
    const width = clampWidth(widthNow() + step)
    applyWidth(width)
    writeChatWidth(storage, width)
  }

  handle.addEventListener('pointerdown', /** @type {EventListener} */ (onDown))
  document.addEventListener('pointermove', /** @type {EventListener} */ (onMove))
  document.addEventListener('pointerup', onUp)
  document.addEventListener('pointercancel', onUp)
  handle.addEventListener('keydown', /** @type {EventListener} */ (onKey))
  return () => {
    handle.removeEventListener('pointerdown', /** @type {EventListener} */ (onDown))
    document.removeEventListener('pointermove', /** @type {EventListener} */ (onMove))
    document.removeEventListener('pointerup', onUp)
    document.removeEventListener('pointercancel', onUp)
    handle.removeEventListener('keydown', /** @type {EventListener} */ (onKey))
  }
}
