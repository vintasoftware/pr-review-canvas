// @ts-check
// The AI Chat pane: threads, the one context a message is about, the streamed answer, and the
// comment cards an answer can propose. The scrolling rules live in chat-scroll.js and the block
// parsing in proposed-comment.js; this file is the wiring between them and the DOM.
/** @typedef {import('./chat-context.js').ChatContext} ChatContext */
/** @typedef {import('./contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('./proposed-comment.js').ProposedComment} ProposedComment */
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
import { postedCommentUrl, viewCommentHtml } from './comment-link.js'
import { esc, qs } from './dom.js'
import { getRenderContext } from './layers.js'
import { renderMarkdown } from './markdown.js'
import { postToLabel } from './host.js'
import { splitChatAnswer, targetsFromFiles } from './proposed-comment.js'

export const CHAT_WIDTH_KEY = 'pr-review.chat-width'
export const CHAT_WIDTH_MIN = 280
export const CHAT_WIDTH_MAX = 560
export const CHAT_WIDTH_DEFAULT = 340

/**
 * @param {{ enabled: boolean, width?: number }} opts
 * @returns {string} '' when AI Chat is disabled
 */
export function renderChatShell(opts) {
  if (!opts.enabled) {
    return ''
  }
  const width = clampWidth(opts.width ?? CHAT_WIDTH_DEFAULT)
  return (
    '<aside class="chat" aria-labelledby="chat-h">' +
    `<button class="handle" type="button" id="chat-handle" role="separator" aria-orientation="vertical" aria-label="Resize AI Chat" aria-valuenow="${width}" aria-valuemin="${CHAT_WIDTH_MIN}" aria-valuemax="${CHAT_WIDTH_MAX}"></button>` +
    '<div class="chat-h"><h2 id="chat-h">AI Chat</h2><label class="sr" for="thread">Thread</label>' +
    '<select id="thread"></select>' +
    '<button class="cmd" type="button" id="new-thread">new thread</button>' +
    '<button class="cmd chat-minimize" type="button" id="chat-minimize" aria-label="Minimize AI Chat">minimize</button></div>' +
    '<p class="ctx-line" id="chat-ctx-line">Context: <span class="ctx-chip" id="chat-ctx">whole PR</span>' +
    ' <button class="cmd" type="button" id="chat-clear" hidden>clear</button></p>' +
    '<div class="transcript" id="chat-log" role="log" aria-label="Transcript" aria-live="polite" tabindex="0">' +
    '<p class="empty">Ask AI Chat about a layer, a file, or a selection. Answers come with a verdict first, then evidence.</p>' +
    '</div>' +
    '<button class="cmd unseen" type="button" id="chat-unseen" hidden aria-live="polite"></button>' +
    '<form class="chat-composer" id="chat-form"><label class="sr" for="msg">Message</label>' +
    '<textarea id="msg" rows="3" placeholder="Ask AI Chat about this PR…"></textarea>' +
    '<div class="tbtns"><button class="cmd fill" type="submit" id="chat-send">send</button>' +
    '<button class="cmd" type="button" id="chat-stop" hidden>stop</button>' +
    '<span class="muted small">enter to send</span></div></form>' +
    '</aside>' +
    '<dialog class="chat-dialog" id="chat-dialog" aria-labelledby="chat-h"></dialog>' +
    '<button class="chat-launcher" id="chat-launcher" type="button" aria-controls="chat-dialog" aria-expanded="false">AI Chat</button>'
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

/** The questions the quick menu offers, and the one that just focuses the box. */
export const QUICK_QUESTIONS = [
  'Suggestion to solve this?',
  'Why this way, and what were the alternatives?',
  'What could break?',
  'Does this follow how the codebase already does it?',
  'Is this covered by tests?',
]

/**
 * @typedef {{
 *   root: HTMLElement,
 *   prNumber: number,
 *   session: ReviewSession,
 *   storage?: Storage | null,
 *   api?: Partial<ChatApi>,
 *   reducedMotion?: boolean,
 *   onProposed?: (what: 'post' | 'edit', comment: ProposedComment, el: HTMLElement) => void,
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
 * @param {ChatTurn['role']} role
 * @param {string} bodyHtml
 * @param {{ incomplete?: string }} [opts]
 */
function turnHtml(role, bodyHtml, opts = {}) {
  return `<div class="turn ${role === 'assistant' ? 'a' : 'u'}">${turnInnerHtml(role, bodyHtml, opts)}</div>`
}

/**
 * @param {ChatTurn['role']} role
 * @param {string} bodyHtml
 * @param {{ incomplete?: string }} [opts]
 */
function turnInnerHtml(role, bodyHtml, opts = {}) {
  const note =
    opts.incomplete === undefined
      ? ''
      : `<p class="muted small">the answer stopped early (${esc(opts.incomplete)})</p>`
  return (
    `<span class="role">${role === 'assistant' ? 'AI Chat' : 'You'}</span>` +
    `<div class="prose">${bodyHtml}</div>${note}`
  )
}

/**
 * The card a proposed comment renders as. `post to github` goes through the same path as every
 * other post, so capability gating and the pending state apply here too.
 * @param {ProposedComment} comment
 * @param {string} id the key the pane stores this card's comment under
 * @param {string} [postedUrl]
 */
export function proposedCommentHtml(comment, id, postedUrl) {
  const range = comment.startLine === undefined ? `${comment.line}` : `${comment.startLine}–${comment.line}`
  const side = comment.side === 'old' ? ' (old side)' : ''
  return (
    `<div class="proposed" data-proposed="${esc(id)}">` +
    `<div class="proposed-h"><span class="lbl">proposed comment</span>` +
    `<span class="mono">${esc(comment.path)}:${esc(range)}${side}</span></div>` +
    `<div class="prose">${renderMarkdown(comment.body)}</div>` +
    '<span class="tbtns">' +
    (postedUrl === undefined
      ? `<button class="cmd fill" type="button" data-act="proposed-post" data-proposed="${esc(id)}" data-needs-post>${postToLabel()}</button>`
      : viewCommentHtml(postedUrl, true)) +
    `<button class="cmd" type="button" data-act="proposed-edit" data-proposed="${esc(id)}" data-needs-post>edit</button>` +
    `<button class="cmd" type="button" data-copy="${esc(comment.body)}">copy</button>` +
    '</span></div>'
  )
}

/**
 * One assistant answer as HTML: prose, comment cards, and a code block for a block that claimed
 * to be a comment but does not name a line of this diff.
 * Card keys carry the turn they belong to, so an older answer's card still posts its own comment
 * after a newer answer has drawn cards of its own.
 * @param {string} text
 * @param {import('./proposed-comment.js').CommentTargets} targets
 * @param {Map<string, ProposedComment>} sink cards found, by key
 * @param {ReadonlySet<string>} paths
 * @param {string} [turnKey] the prefix of this turn's card keys
 * @param {ReadonlyArray<import('./contract-types.js').ReviewComment>} [posted]
 */
export function answerHtml(text, targets, sink, paths, turnKey = 'turn', posted = []) {
  let index = 0
  return splitChatAnswer(text, targets)
    .map(segment => {
      if (segment.type === 'markdown') {
        return renderMarkdown(segment.text, { paths })
      }
      if (segment.type === 'comment') {
        const id = `${turnKey}-${index}`
        index += 1
        sink.set(id, segment.comment)
        return proposedCommentHtml(segment.comment, id, postedCommentUrl(segment.comment, posted))
      }
      return `<pre class="proposed-invalid"><code>${esc(segment.text)}</code></pre><p class="muted small">${esc(segment.reason)}</p>`
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
  const targets = targetsFromFiles(session.artifact.files)
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

  /** @type {ChatContext} */
  let context = WHOLE_PR
  /** @type {import('./chat-scroll.js').ChatScrollState} */
  let scroll = INITIAL_SCROLL_STATE
  /** Where each thread was left, so switching back does not jump the reader to the bottom. */
  const scrollTops = new Map()
  /** Every comment card on screen, by the key its buttons carry. */
  /** @type {Map<string, ProposedComment>} */
  const proposed = new Map()
  const postedComments = () => {
    const ids = new Set(session.state.posted.map(p => p.commentId))
    return getRenderContext()?.comments.filter(c => ids.has(c.id)) ?? []
  }
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
   * @param {{ incomplete?: string }} [opts]
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
                  ? answerHtml(turn.text, targets, proposed, paths, `history-${i}`, postedComments())
                  : renderMarkdown(turn.text, { paths }),
                turn.incomplete === undefined ? {} : { incomplete: turn.incomplete }
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
    return answerHtml(text, targets, proposed, paths, turnKey, postedComments())
  }

  const send = async () => {
    const message = box.value.trim()
    if (message === '' || streaming) {
      return
    }
    box.value = ''
    // The turn owns the log from here on, so a history load still on its way lands nowhere.
    claimLog()
    appendTurn('user', renderMarkdown(message, { paths }))
    dispatch({ type: 'send' })
    scrollToBottom('follow')
    const answer = appendTurn('assistant', '')
    const activity = document.createElement('p')
    activity.className = 'muted small chat-activity'
    activity.setAttribute('aria-live', 'off')
    answer.turn.append(activity)
    const started = Date.now()
    const updateActivity = () => {
      const elapsed = Date.now() - started
      activity.textContent = `Preparing answer${'.'.repeat((Math.floor(elapsed / 400) % 3) + 1)} · ${Math.floor(elapsed / 1000)}s`
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
    if (act === 'proposed-post' || act === 'proposed-edit') {
      const comment = proposed.get(el.getAttribute('data-proposed') ?? '')
      if (comment !== undefined) {
        options.onProposed?.(act === 'proposed-post' ? 'post' : 'edit', comment, el)
      }
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
    const insideOwnScroller =
      target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
        ? canScrollBy(target, event.deltaY)
        : false
    const at = {
      // The narrow layout drops the pin and the pane scrolls with the page like any other column.
      pinned: getComputedStyle(pane).position === 'sticky',
      insideTranscript: target?.closest('.transcript') !== null && target !== null,
      zooming: event.ctrlKey,
      insideOwnScroller,
    }
    if (!redirectsWheelToTranscript(at)) {
      return
    }
    // Consumed whether or not the transcript can move, so the page stays put under the pointer.
    event.preventDefault()
    log.scrollTop += event.deltaY
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
  const panel = wireChatPanel(root, pane)

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
      panel.open()
    },
    /** @param {ChatContext} next */
    ask(next) {
      setContext(next)
      panel.open()
    },
    /**
     * Sends one of the quick questions about a target.
     * @param {ChatContext} next
     * @param {string} question
     */
    askQuestion(next, question) {
      setContext(next)
      panel.open()
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
