// @ts-check
// The AI Chat pane: threads, the one context a message is about, the streamed answer, and the
// comment cards an answer can propose. The scrolling rules live in chat-scroll.js and the block
// parsing in proposed-comment.js; this file is the wiring between them and the DOM.
/** @typedef {import('./chat-context.js').ChatContext} ChatContext */
/** @typedef {import('./contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('./proposed-comment.js').ProposedComment} ProposedComment */
/** @typedef {import('./proposed-comment.js').ProposedResolution} ProposedResolution */
/** @typedef {import('./review-session.js').ReviewSession} ReviewSession */
import { cancelChat, createThread, fetchThreadHistory, fetchThreads, streamChat } from './api.js'
import { chatContextAttrs, chatContextLabel, sameChatContext, WHOLE_PR } from './chat-context.js'
import { wireChatPanel } from './chat-panel.js'
import {
  canScrollBy,
  chatScrollReducer,
  INITIAL_SCROLL_STATE,
  isAtBottom,
  redirectsWheelToTranscript,
  scrollBehavior,
  unseenLabel,
} from './chat-scroll.js'
import { runCommand, runControl, showCommandError } from './commands.js'
import { isQueuedComment, postedCommentUrl, sendCommandsHtml } from './comment-link.js'
import { esc, qs } from './dom.js'
import { getRenderContext } from './layers.js'
import { renderMarkdown } from './markdown.js'
import { pendingComments } from './pending.js'
import { pointStatus, resolvable } from './points.js'
import { proposalFingerprint, splitChatAnswer, targetsFromFiles } from './proposed-comment.js'
import { REVIEW_PANEL_ID } from './review-panel.js'
import { canSettle } from './self-review.js'
import { openReviewTab, selectSideTab, sideTabsHtml, wireSideTabs } from './side-pane.js'

export const CHAT_WIDTH_KEY = 'pr-review.chat-width'
export const CHAT_MINIMIZED_KEY = 'pr-review.chat-minimized'
export const CHAT_WIDTH_MIN = 280
export const CHAT_WIDTH_MAX = 560
export const CHAT_WIDTH_DEFAULT = 340

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
    '<div class="chat-h"><h2 class="sr" id="chat-h">AI Chat</h2><label class="sr" for="thread">Thread</label>' +
    '<select id="thread"></select>' +
    '<button class="cmd" type="button" id="new-thread">new thread</button></div>' +
    '<div class="transcript" id="chat-log" role="log" aria-label="Transcript" aria-live="polite" tabindex="0">' +
    '<p class="empty">Ask AI Chat about a layer, a file, or a selection. Answers come with a verdict first, then evidence.</p>' +
    '</div>' +
    // The context is what the next message is about, so it sits on the composer, not over the
    // thread. The bubble sits on the composer too, so it clears it at any height.
    '<form class="chat-composer" id="chat-form">' +
    '<button class="cmd unseen" type="button" id="chat-unseen" hidden aria-live="polite"></button>' +
    '<p class="ctx-line" id="chat-ctx-line">Context: <span class="ctx-chip" id="chat-ctx">whole PR</span>' +
    ' <button class="cmd" type="button" id="chat-clear" hidden>clear</button></p>' +
    '<label class="sr" for="msg">Message</label>' +
    '<textarea id="msg" rows="3" placeholder="Ask AI Chat about this PR…"></textarea>' +
    '<div class="tbtns"><button class="cmd fill" type="submit" id="chat-send">send</button>' +
    '<button class="cmd" type="button" id="chat-stop" hidden>stop</button>' +
    '<span class="muted small">enter to send</span></div></form>' +
    `<section class="review-panel" id="${REVIEW_PANEL_ID}" role="tabpanel" aria-labelledby="side-tab-review" hidden></section>` +
    '</aside>' +
    '<dialog class="chat-dialog" id="chat-dialog" aria-labelledby="chat-h"></dialog>' +
    '<button class="chat-launcher" id="chat-launcher" type="button" hidden aria-controls="chat-dialog" aria-expanded="false">AI Chat</button>'
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

/** The questions the quick menu offers, and the one that just focuses the box. */
export const QUICK_QUESTIONS = [
  'Suggestion to solve this?',
  'Why this way, and what were the alternatives?',
  'What could break?',
  'Does this follow how the codebase already does it?',
  'Is this covered by tests?',
]

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
 *   onProposed?: (what: ProposedAct, comment: ProposedComment, el: HTMLElement) => void,
 *   onResolution?: (what: 'save' | 'edit', resolution: ProposedResolution, el: HTMLElement) => void,
 * }} ChatOptions
 */

/**
 * @typedef {{
 *   fetchThreads: typeof fetchThreads,
 *   createThread: typeof createThread,
 *   fetchThreadHistory: typeof fetchThreadHistory,
 *   cancelChat: typeof cancelChat,
 *   streamChat: typeof streamChat,
 * }} ChatApi
 */

/** @param {Partial<ChatApi> | undefined} overrides */
function withDefaults(overrides) {
  return { fetchThreads, createThread, fetchThreadHistory, cancelChat, streamChat, ...overrides }
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
    `<button class="cmd" type="button" data-act="proposed-edit" data-proposed="${esc(id)}" data-needs-post>edit</button>` +
    `<button class="cmd" type="button" data-copy="${esc(comment.body)}">copy</button>` +
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
        `<button class="cmd" type="button" data-act="resolution-edit" ${target}>edit</button>`
      : shown === 'resolved'
        ? '<span class="pill status resolved">resolved</span>'
        : shown === 'dismissed'
          ? '<span class="muted small">dismissed: restore the point to resolve it</span>'
          : ''
  return (
    `<span class="tbtns" data-key="${shown}">${acts}` +
    `<button class="cmd" type="button" data-copy="${esc(resolution.reason)}">copy</button></span>`
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
  const select = mustFind(root, '#thread', HTMLSelectElement)
  const chip = mustFind(root, '#chat-ctx', HTMLElement)
  const clearButton = mustFind(root, '#chat-clear', HTMLElement)
  const bubble = mustFind(root, '#chat-unseen', HTMLElement)
  const sendButton = mustFind(root, '#chat-send', HTMLElement)
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
  let streaming = false
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
  /**
   * What a sent message names above its text, so a reader scrolling back sees what each question
   * was about. A message about the whole PR, or one saved before turns kept a context, names none.
   * @param {ChatContext | undefined} about
   */
  const turnContext = about =>
    about === undefined || about.kind === 'pr'
      ? {}
      : { context: chatContextLabel(about, layerTitle, pointTitle) }

  const drawContext = () => {
    chip.textContent = chatContextLabel(context, layerTitle, pointTitle)
    clearButton.hidden = context.kind === 'pr'
    chip.toggleAttribute('data-ask-menu', context.kind !== 'pr')
    if (context.kind === 'pr') {
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
    turnSeq += 1
    const id = `chat-turn-${turnSeq}`
    const wasPinned = scroll.pinned
    const turn = document.createElement('div')
    turn.className = `turn ${role === 'assistant' ? 'a' : 'u'}`
    turn.id = id
    turn.innerHTML = turnInnerHtml(role, html, opts)
    log.appendChild(turn)
    dispatch({ type: 'append', id, belowFold: !wasPinned })
    if (scroll.pinned) {
      scrollToBottom('follow')
    }
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
      if (scroll.pinned) {
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

  const drawThreads = /** @param {import('./contract-types.js').ChatThreadsResponse} data */ data => {
    activeThread = data.activeThread
    select.innerHTML = data.threads
      .map(
        t =>
          `<option value="${esc(t.name)}"${t.name === data.activeThread ? ' selected' : ''}>${esc(t.title)}</option>`
      )
      .join('')
    if (data.threads.length === 0) {
      select.innerHTML = '<option value="">Thread 1</option>'
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
    const saved = scrollTops.get(name)
    dispatch({ type: 'thread-switch', pinned: saved === undefined })
    if (saved === undefined) {
      scrollToBottom('follow')
    } else {
      log.scrollTop = saved
    }
    restoring = false
  }

  /** While a turn runs, the thread controls are locked: its callbacks draw into this transcript. */
  /** @param {boolean} on */
  const setStreaming = on => {
    streaming = on
    sendButton.hidden = on
    stopButton.hidden = !on
    box.disabled = on
    select.disabled = on
    const newThread = qs('#new-thread', root)
    if (newThread instanceof HTMLButtonElement) {
      newThread.disabled = on
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

  const send = async () => {
    const message = box.value.trim()
    if (message === '' || streaming) {
      return
    }
    box.value = ''
    // The turn owns the log from here on, so a history load still on its way lands nowhere.
    claimLog()
    appendTurn('user', renderMarkdown(message, { paths }), turnContext(context))
    dispatch({ type: 'send' })
    scrollToBottom('follow')
    const answer = appendTurn('assistant', '')
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
    setStreaming(true)
    let text = ''
    inFlight = new AbortController()
    try {
      await api.streamChat(
        prNumber,
        { message, context, ...(activeThread === null ? {} : { thread: activeThread }) },
        {
          signal: inFlight.signal,
          onEvent: event => {
            const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
            const field = /** @param {string} key */ key => data[key]
            const thread = field('thread')
            if (event.event === 'turn' && typeof thread === 'string') {
              activeThread = thread
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
              if (!scroll.pinned && scroll.unseen === 0) {
                dispatch({ type: 'append', id: turnKey, belowFold: true })
              }
              scheduleRender(answer.body, () => renderAnswer(text, turnKey))
              return
            }
            if (event.event === 'error') {
              showCommandError(stopButton, String(field('message') ?? 'the agent failed'))
              return
            }
            if (event.event === 'cancelled') {
              answer.turn.insertAdjacentHTML('beforeend', '<p class="muted small">stopped</p>')
            }
          },
        }
      )
    } finally {
      inFlight = null
      stopActivity()
      toolDetails.open = false
      const toolSummary = toolDetails.querySelector('summary')
      if (toolSummary) toolSummary.textContent = `${tools.size} tool calls`
      activity.textContent = `Elapsed: ${Math.floor((Date.now() - started) / 1000)}s`
      if (frame !== 0) {
        cancelFrame(frame)
        frame = 0
      }
      setStreaming(false)
      answer.body.innerHTML =
        text === '' ? '<span class="muted">no answer</span>' : renderAnswer(text, turnKey)
      if (scroll.pinned) {
        scrollToBottom('follow')
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
    drawThreads(data)
    if (data.activeThread !== null) {
      await loadHistory(data.activeThread)
    }
  }

  /** @param {Event} event */
  const onSubmit = event => {
    event.preventDefault()
    void runCommand(sendButton, send, { pendingLabel: 'sending…' })
  }

  /** @param {Event} event */
  const onClick = event => {
    const el = event.target instanceof Element ? event.target.closest('button') : null
    if (!(el instanceof HTMLElement)) {
      return
    }
    if (el.id === 'chat-clear') {
      setContext(WHOLE_PR)
      return
    }
    if (el.id === 'chat-stop') {
      void runCommand(el, () => api.cancelChat(prNumber), { pendingLabel: 'stopping…' })
      return
    }
    if (el.id === 'new-thread') {
      void runCommand(
        el,
        async () => {
          const seq = claimLog()
          const data = await api.createThread(prNumber)
          if (seq !== logSeq) {
            return
          }
          drawThreads(data)
          proposed.clear()
          log.innerHTML = '<p class="empty">New thread. Ask about a layer, a file, or a selection.</p>'
          dispatch({ type: 'thread-switch', pinned: true })
        },
        { pendingLabel: 'starting…' }
      )
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
    // The tab on screen owns the wheel: the transcript, or the list of the review being written.
    const scroller = (pane.getAttribute('data-tab') === 'review' ? reviewPanel : null) ?? log
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

  /** @param {Event} event */
  const onThreadChange = event => {
    const name = event.target instanceof HTMLSelectElement ? event.target.value : ''
    if (name === '' || name === activeThread) {
      return
    }
    activeThread = name
    void runControl(select, () => loadHistory(name))
  }

  /** @param {KeyboardEvent} event */
  const onKeyDown = event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void runCommand(sendButton, send, { pendingLabel: 'sending…' })
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
  })
  const stopTabs = wireSideTabs(pane)
  // Whatever asks the chat for something shows its tab first.
  const openChat = () => {
    selectSideTab(pane, 'chat')
    panel.open()
  }

  form.addEventListener('submit', onSubmit)
  root.addEventListener('click', onClick)
  log.addEventListener('scroll', onScroll)
  pane.addEventListener('wheel', onPaneWheel, { passive: false })
  select.addEventListener('change', onThreadChange)
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
    /** @param {ChatContext} next */
    ask(next) {
      setContext(next)
      openChat()
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
      setContext(next)
      openChat()
      box.value = question
      void runCommand(sendButton, send, { pendingLabel: 'sending…' })
    },
    stop() {
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
      select.removeEventListener('change', onThreadChange)
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
