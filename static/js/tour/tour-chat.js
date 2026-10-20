// @ts-check
// The tour's AI Chat: a pane beside the tour, on every step, with a thread per place of the tour
// (the tour as a whole, a landmark, a decision, a quiz question, the plan). It shows the thread of
// the step on screen and follows the reader from step to step. Threads lists every thread, and
// go to stop brings a thread's step back. An answer keeps coming in while the reader reads
// another thread, and that thread is marked until they open it.
/** @typedef {import('../contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourPlace} TourPlace */
/** @typedef {import('../contract-types.js').TourChatThreadsResponse} TourChatThreadsResponse */
/** @typedef {import('./steps.js').Step} Step */
import { ApiError } from '../api.js'
import { liveAnswer } from '../chat-answer.js'
import { sameChatContext, tourPlaceLabel } from '../chat-context.js'
import { esc, qs } from '../dom.js'
import { renderMarkdown } from '../markdown.js'
import { stepIndexOf } from './steps.js'
import { cancelTourChat, fetchTourThreadHistory, fetchTourThreads, streamTourChat } from './tour-api.js'

export const TOUR_CHAT_ID = 'tour-ask'

/** Where the pane remembers, per browser, that the reader keeps it open. */
export const TOUR_CHAT_OPEN_KEY = 'pr-review.tour-chat-open'

/**
 * True when the tour has an AI Chat: chat is on and acpx is there, and the tour is not a preview.
 * @param {TourBundle} bundle
 */
export function tourChats(bundle) {
  return bundle.chat.enabled && !bundle.preview
}

/**
 * The place of the tour a step is.
 * @param {Step} step
 * @returns {TourPlace}
 */
export function placeOfStep(step) {
  switch (step.kind) {
    case 'cover':
      return { kind: 'tour' }
    case 'landmark':
      return { kind: 'tour-landmark', id: step.landmark.id }
    case 'decision':
      return { kind: 'tour-decision', key: step.decision.key }
    case 'quiz':
      return { kind: 'tour-question', id: step.q.id }
    case 'plan':
      return { kind: 'tour-plan' }
  }
}

/**
 * The step a place is, or -1 for the tour as a whole, which no one step is, and for a place this
 * tour no longer has.
 * @param {Step[]} steps
 * @param {TourPlace} place
 */
export function stepOfPlace(steps, place) {
  switch (place.kind) {
    case 'tour':
      return -1
    case 'tour-landmark':
      return stepIndexOf(steps, 'landmark', place.id)
    case 'tour-decision':
      return stepIndexOf(steps, 'decision', place.key)
    case 'tour-question':
      return stepIndexOf(steps, 'quiz', place.id)
    case 'tour-plan':
      return steps.findIndex(step => step.kind === 'plan')
  }
}

/**
 * The thread a question about a place goes to: this agent's newest thread of it. An older thread
 * of the whole tour, which new thread makes, is opened from Threads.
 * @template {{ agent: string, place: TourPlace }} Thread
 * @param {readonly Thread[]} threads
 * @param {string} agent
 * @param {TourPlace} place
 */
export function threadOfTourPlace(threads, agent, place) {
  return threads.findLast(t => t.agent === agent && sameChatContext(t.place, place))
}

const GROUPS = /** @type {const} */ ([
  ['tour-landmark', 'Landmarks'],
  ['tour-decision', 'Decisions'],
  ['tour-question', 'Questions'],
  ['tour-plan', 'The plan'],
  ['tour', 'Whole tour'],
])

/**
 * @typedef {{
 *   fetchTourThreads: typeof fetchTourThreads,
 *   fetchTourThreadHistory: typeof fetchTourThreadHistory,
 *   streamTourChat: typeof streamTourChat,
 *   cancelTourChat: typeof cancelTourChat,
 * }} TourChatApi
 */

/**
 * @typedef {{
 *   pane: HTMLElement,
 *   key: string,
 *   bundle: TourBundle & { tour: import('../contract-types.js').TourPageTour },
 *   steps: Step[],
 *   reachable: (i: number) => boolean,
 *   onGoto: (i: number) => void,
 *   onChange: () => void,
 *   api?: Partial<TourChatApi>,
 *   storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
 * }} TourChatOptions
 */

/**
 * The pane, wired once per drawn tour.
 * @param {TourChatOptions} options
 */
export function createTourChat(options) {
  const { pane, key, bundle, steps } = options
  const api = { fetchTourThreads, fetchTourThreadHistory, streamTourChat, cancelTourChat, ...options.api }
  const storage = options.storage === undefined ? safeStorage() : options.storage
  /** @type {TourChatThreadsResponse['threads']} */
  let threads = []
  let agent = bundle.chat.agent ?? ''
  let open = false
  /** @type {'thread' | 'threads'} */
  let view = 'thread'
  /** The place of the step on screen, which an open pane follows. */
  /** @type {TourPlace} */
  let stepPlace = { kind: 'tour' }
  /** The place of the thread on screen. */
  /** @type {TourPlace} */
  let place = stepPlace
  /** The thread on screen, or null for a thread of `place` that has no question yet. */
  /** @type {string | null} */
  let thread = null
  /** @type {ChatTurn[]} */
  let turns = []
  let loaded = false
  /** Counts thread loads, so one that comes back after the reader moved on lands nowhere. */
  let loads = 0
  /**
   * Answers drawn as they came in, kept as they are: their elapsed time and tool calls stay under
   * them when the thread is drawn again.
   * @type {Map<ChatTurn, HTMLElement>}
   */
  const drawn = new Map()
  /**
   * The question whose answer is coming in. Its thread is named once the agent takes it; until
   * then it is the place's thread that has no question yet.
   * @typedef {{ thread: string | null, place: TourPlace, message: string, user: HTMLElement, answer: HTMLElement, request: AbortController, stop: () => void }} Live
   * @type {Live | null}
   */
  let live = null
  /** The threads with an answer the reader has not seen: one that ended off screen. */
  /** @type {Set<string>} */
  const unseen = new Set()
  /** Set once the pane is taken down: an answer that ends after it draws nothing. */
  let stopped = false
  /** What the reader typed and has not sent, by thread, so moving between steps keeps it. */
  /** @type {Map<string, string>} */
  const drafts = new Map()

  pane.innerHTML = shellHtml(bundle)
  const title = /** @type {HTMLElement} */ (qs('#tour-ask-title', pane))
  const goto = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-goto"]', pane))
  const log = /** @type {HTMLElement} */ (qs('#tour-ask-log', pane))
  const panel = /** @type {HTMLElement} */ (qs('#tour-ask-threads-panel', pane))
  const index = /** @type {HTMLElement} */ (qs('#tour-ask-threads', pane))
  const form = /** @type {HTMLFormElement} */ (qs('.chat-composer', pane))
  const box = /** @type {HTMLTextAreaElement} */ (qs('#tour-ask-box', pane))
  const send = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-send"]', pane))
  const stop = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-stop"]', pane))

  const tour = bundle.tour
  /** @param {TourPlace} p */
  const placeName = p => tourPlaceLabel(p, tour)
  /** Where the box's text is kept for the thread on screen. */
  const draftKey = () => thread ?? `new:${JSON.stringify(place)}`
  const onScreen = () => open && view === 'thread'
  /** Whether the answer coming in belongs to the thread on screen. */
  const liveHere = () =>
    live !== null &&
    (live.thread === null ? thread === null && sameChatContext(live.place, place) : live.thread === thread)
  const scrollToEnd = () => {
    log.scrollTop = log.scrollHeight
  }

  /** @param {ChatTurn} turn */
  const turnHtml = turn => {
    const i = turns.indexOf(turn)
    if (turn.role === 'user') {
      return `<div class="turn u"><span class="role">You</span><div class="prose"><p>${esc(turn.text)}</p></div></div>`
    }
    if (drawn.has(turn)) {
      return `<div data-keep="${i}"></div>`
    }
    const body = turn.text.trim() === '' ? '<span class="muted">no answer</span>' : renderMarkdown(turn.text)
    const note =
      turn.incomplete === undefined
        ? ''
        : `<p class="muted small">the answer stopped early (${esc(turn.incomplete)})</p>`
    return `<div class="turn a"><span class="role">AI Chat</span><div class="prose">${body}</div>${note}</div>`
  }

  const drawLog = () => {
    // The question coming in is drawn live below; a history read mid-answer may hold it already.
    const shown =
      liveHere() && turns.at(-1)?.role === 'user' && turns.at(-1)?.text === live?.message
        ? turns.slice(0, -1)
        : turns
    log.innerHTML =
      shown.map(turnHtml).join('') ||
      (loaded || liveHere()
        ? `<p class="empty">Ask about ${esc(place.kind === 'tour' ? 'the tour, or the change it explains' : 'this stop')}. AI Chat reads the code of this change and changes nothing.</p>`
        : '<p class="empty">Opening this thread…</p>')
    for (const slot of log.querySelectorAll('[data-keep]')) {
      const turn = /** @type {ChatTurn} */ (turns[Number(slot.getAttribute('data-keep'))])
      slot.replaceWith(/** @type {HTMLElement} */ (drawn.get(turn)))
    }
    if (live !== null && liveHere()) {
      log.querySelector('.empty')?.remove()
      log.append(live.user, live.answer)
    }
    scrollToEnd()
  }

  const drawHead = () => {
    title.textContent = placeName(place)
    title.title = title.textContent
    const i = stepOfPlace(steps, place)
    // A thread of the step on screen has nowhere to go; a step the reader cannot reach yet neither.
    goto.hidden = i < 0 || sameChatContext(place, stepPlace) || !options.reachable(i)
  }

  const drawComposer = () => {
    const answeringHere = liveHere()
    send.hidden = answeringHere
    stop.hidden = !answeringHere
    box.disabled = live !== null
    box.placeholder =
      live === null
        ? place.kind === 'tour'
          ? 'Ask AI Chat about this tour…'
          : 'Ask AI Chat about this stop…'
        : answeringHere
          ? 'AI Chat is answering…'
          : `AI Chat is answering in “${placeName(live.place)}”. Ask here once it is done.`
  }

  const drawIndex = () => {
    const tabDot = qs('[data-view="threads"] .threads-new', pane)
    tabDot?.toggleAttribute('hidden', unseen.size === 0)
    if (threads.length === 0) {
      index.innerHTML =
        '<p class="empty">No threads yet. Ask AI Chat from any stop of the tour, or start a thread about the whole tour.</p>'
    } else {
      index.innerHTML = GROUPS.map(([kind, label]) => {
        const group = threads.filter(t => t.place.kind === kind)
        if (group.length === 0) return ''
        const items = group
          .map(t => {
            const status =
              t.name === live?.thread
                ? 'answering…'
                : unseen.has(t.name)
                  ? 'new answer'
                  : t.turns === 1
                    ? '1 question'
                    : `${t.turns} questions`
            return (
              `<li><button type="button" class="thread-item${t.name === thread ? ' current' : ''}" data-act="ask-open" data-thread="${esc(t.name)}">` +
              `<span class="thread-item-t">${esc(placeName(t.place))}</span>` +
              `<span class="small ${status === 'new answer' ? 'thread-new' : 'muted'}">${esc(status)}</span></button></li>`
            )
          })
          .join('')
        return `<h3 class="thread-group">${esc(label)}</h3><ul class="thread-list">${items}</ul>`
      }).join('')
    }
  }

  const drawView = () => {
    for (const tab of pane.querySelectorAll('[data-view]')) {
      tab.setAttribute('aria-selected', String(tab.getAttribute('data-view') === view))
    }
    const listing = view === 'threads'
    panel.hidden = !listing
    log.hidden = listing
    form.hidden = listing
    qs('.tour-ask-head', pane)?.toggleAttribute('hidden', listing)
  }

  /** Marks the thread on screen as seen. */
  const see = () => {
    if (onScreen() && thread !== null && unseen.delete(thread)) {
      drawIndex()
      options.onChange()
    }
  }

  const refreshThreads = async () => {
    try {
      const data = await api.fetchTourThreads(key)
      threads = data.threads
      agent = data.agent
    } catch {
      // The list keeps what it had; the next answer or opening reads it again.
    }
    drawIndex()
    options.onChange()
  }

  const listed = refreshThreads()

  /**
   * Puts a thread on screen: `name`, or the thread of `next` that has no question yet.
   * @param {TourPlace} next
   * @param {string | null} name
   */
  const showThread = (next, name) => {
    drafts.set(draftKey(), box.value)
    place = next
    thread = name
    view = 'thread'
    turns = []
    drawn.clear()
    loaded = name === null
    box.value = drafts.get(draftKey()) ?? ''
    drawView()
    drawHead()
    drawLog()
    drawComposer()
    drawIndex()
    see()
    const at = ++loads
    if (name !== null) {
      void (async () => {
        /** @type {ChatTurn[]} */
        let read = []
        try {
          read = (await api.fetchTourThreadHistory(key, name)).turns
        } catch {
          // A thread that cannot be read now opens empty; its answers are still on the server.
        }
        if (at === loads) {
          turns = read
          loaded = true
          drawLog()
        }
      })()
    }
  }

  /** @param {TourPlace} next */
  const showPlace = next => showThread(next, threadOfTourPlace(threads, agent, next)?.name ?? null)

  const remember = () => {
    try {
      storage?.setItem(TOUR_CHAT_OPEN_KEY, open ? '1' : '0')
    } catch {
      // A browser that keeps nothing opens the pane closed next time.
    }
  }

  const show = () => {
    open = true
    pane.hidden = false
    remember()
    showPlace(stepPlace)
    // A pane opened before the first list came back has the step's thread to show once it does,
    // unless the reader has moved on or asked in it since.
    const at = loads
    void (async () => {
      await listed
      if (open && at === loads && thread === null && live === null && turns.length === 0) {
        showPlace(stepPlace)
      }
    })()
    options.onChange()
    // On a touch screen focus would open the keyboard over the thread the reader came to read.
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
    if (!touch) {
      box.focus()
    }
  }

  const hide = () => {
    const focused = pane.contains(document.activeElement)
    open = false
    pane.hidden = true
    remember()
    options.onChange()
    // The focus goes back to the command that opens the pane, not to a box no one can see.
    const opener = /** @type {HTMLElement | null} */ (
      document.querySelector(`[aria-controls="${TOUR_CHAT_ID}"]`)
    )
    if (focused) {
      opener?.focus()
    }
  }

  const ask = async () => {
    const message = box.value.trim()
    if (message === '' || live !== null) {
      return
    }
    box.value = ''
    drafts.delete(draftKey())
    const user = document.createElement('div')
    user.className = 'turn u'
    user.innerHTML = `<span class="role">You</span><div class="prose"><p>${esc(message)}</p></div>`
    const answer = document.createElement('div')
    answer.className = 'turn a'
    answer.innerHTML = '<span class="role">AI Chat</span><div class="prose"></div>'
    const asked = { place, thread }
    /** @type {ChatTurn} */
    const reply = { role: 'assistant', text: '', at: new Date().toISOString() }
    const request = new AbortController()
    /** @type {Live} */
    const current = { ...asked, message, user, answer, request, stop: () => {} }
    const stream = liveAnswer({
      turn: answer,
      body: /** @type {HTMLElement} */ (answer.querySelector('.prose')),
      render: text => renderMarkdown(text),
      onDraw: () => {
        if (answer.isConnected) scrollToEnd()
      },
      onThread: name => {
        current.thread = name
        // The question's place had no thread yet: the one it made is the one on screen.
        if (thread === null && sameChatContext(place, asked.place)) {
          thread = name
        }
        void refreshThreads()
      },
      onError: (failure, code) => {
        reply.incomplete = code
        answer.insertAdjacentHTML(
          'beforeend',
          `<p class="chat-warning small" role="alert">${esc(failure)}</p>`
        )
      },
      onCancelled: () => {
        reply.incomplete = 'cancelled'
        answer.insertAdjacentHTML('beforeend', '<p class="muted small">stopped</p>')
      },
    })
    current.stop = stream.stop
    live = current
    drawLog()
    drawComposer()
    drawIndex()
    try {
      await api.streamTourChat(
        key,
        { message, context: asked.place, ...(asked.thread === null ? {} : { thread: asked.thread }) },
        { signal: request.signal, onEvent: stream.onEvent }
      )
    } catch (err) {
      if (request.signal.aborted) {
        reply.incomplete ??= 'stopped'
      } else {
        const busy = err instanceof ApiError && err.code === 'CHAT_BUSY'
        const reason = busy
          ? 'Another answer is still running for this pull request: in the grilling, another tab, or the canvas’s AI Chat. Ask again once it ends.'
          : err instanceof Error
            ? err.message
            : String(err)
        reply.incomplete = busy ? 'CHAT_BUSY' : 'failed'
        answer.insertAdjacentHTML(
          'beforeend',
          `<p class="chat-warning small" role="alert">${esc(reason)}</p>`
        )
      }
    } finally {
      const here = liveHere()
      const named = live?.thread ?? null
      live = null
      stream.finish()
      reply.text = stream.text()
      // A pane taken down has nothing on screen to finish.
      if (!stopped) {
        if (here) {
          // The answer stays where it is: the thread on screen takes both turns.
          turns.push({ role: 'user', text: message, at: reply.at, context: asked.place }, reply)
          drawn.set(reply, answer)
        }
        if (named !== null && !(here && onScreen())) {
          unseen.add(named)
        }
        drawComposer()
        await refreshThreads()
        if (here && onScreen()) {
          box.focus()
        }
      }
    }
  }

  /** @param {Event} e */
  const onClick = e => {
    const target = /** @type {Element} */ (e.target).closest('[data-act], [data-view]')
    if (!(target instanceof HTMLElement)) {
      return
    }
    const tab = target.dataset['view']
    if (tab === 'thread' || tab === 'threads') {
      if (tab === 'threads') {
        view = 'threads'
        drawView()
        drawIndex()
        void refreshThreads()
      } else {
        showThread(place, thread)
      }
      return
    }
    const act = target.dataset['act']
    if (act === 'ask-close') {
      hide()
    } else if (act === 'ask-goto') {
      options.onGoto(stepOfPlace(steps, place))
    } else if (act === 'ask-new') {
      showThread({ kind: 'tour' }, null)
      box.focus()
    } else if (act === 'ask-open') {
      const t = threads.find(x => x.name === target.dataset['thread'])
      if (t !== undefined) {
        showThread(t.place, t.name)
      }
    } else if (act === 'ask-stop' && live !== null) {
      live.request.abort()
      void api.cancelTourChat(key).catch(() => undefined)
    }
  }

  /** @param {Event} e */
  const onSubmit = e => {
    e.preventDefault()
    void ask()
  }

  /** @param {KeyboardEvent} e */
  const onKeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && e.target === box) {
      e.preventDefault()
      void ask()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      hide()
    }
  }

  pane.addEventListener('click', onClick)
  form.addEventListener('submit', onSubmit)
  pane.addEventListener('keydown', onKeydown)

  let wantsOpen = false
  try {
    wantsOpen = storage?.getItem(TOUR_CHAT_OPEN_KEY) === '1'
  } catch {
    wantsOpen = false
  }

  return {
    /**
     * The step on screen changed: an open pane shows its thread.
     * @param {TourPlace} next
     */
    follow(next) {
      const moved = !sameChatContext(next, stepPlace)
      stepPlace = next
      if (wantsOpen) {
        wantsOpen = false
        show()
      } else if (open && moved) {
        showPlace(next)
      } else if (open) {
        drawHead()
      }
    },
    /** Opens the pane on the step on screen, or closes it. */
    toggle() {
      if (open) hide()
      else show()
    },
    /** Opens the pane on the step on screen and puts the cursor in its box. */
    focus() {
      if (!open) show()
      else if (!sameChatContext(place, stepPlace) || view !== 'thread') showPlace(stepPlace)
      box.focus()
    },
    isOpen: () => open,
    /**
     * What the nav's ask command says: whether the step on screen has a thread, and how many
     * threads have an answer the reader has not seen.
     */
    marks() {
      return {
        open,
        thread: threadOfTourPlace(threads, agent, stepPlace) !== undefined,
        unseen: unseen.size,
      }
    },
    stop() {
      stopped = true
      live?.request.abort()
      live?.stop()
      live = null
      pane.removeEventListener('click', onClick)
      form.removeEventListener('submit', onSubmit)
      pane.removeEventListener('keydown', onKeydown)
    },
  }
}

/** @param {TourBundle} bundle */
function shellHtml(bundle) {
  const agent = bundle.chat.agent ?? 'agent'
  const model = bundle.chat.model ? ` · ${esc(bundle.chat.model)}` : ''
  return `<div class="tour-chat-box">
    <div class="chat-h"><h2 id="tour-ask-h">AI Chat</h2>
      <div class="tour-ask-tabs" role="tablist" aria-label="AI Chat">
        <button class="cmd" type="button" role="tab" data-view="thread" aria-selected="true">thread</button>
        <button class="cmd" type="button" role="tab" data-view="threads" aria-selected="false">threads<span class="threads-new" hidden></span></button>
      </div>
      <button class="cmd" type="button" data-act="ask-close">close</button></div>
    <p class="ctx-line">${esc(agent)}${model} · read-only · a thread per stop</p>
    <div class="tour-ask-head"><p class="thread-title" id="tour-ask-title"></p><button class="cmd" type="button" data-act="ask-goto" hidden>go to stop</button></div>
    <div class="transcript" id="tour-ask-log" role="log" aria-label="Transcript" aria-live="polite" tabindex="0"></div>
    <section class="tour-ask-threads" id="tour-ask-threads-panel" hidden><div class="threads-h"><button class="cmd" type="button" data-act="ask-new">new thread</button></div>
      <nav class="thread-index" id="tour-ask-threads" aria-label="Threads"></nav></section>
    <form class="chat-composer"><label class="sr" for="tour-ask-box">Message</label><textarea id="tour-ask-box" rows="2"></textarea>
      <div class="tbtns"><button class="cmd fill" type="submit" data-act="ask-send">send</button><button class="cmd" type="button" data-act="ask-stop" hidden>stop</button><span class="muted small">enter to send</span></div></form>
  </div>`
}

/** @returns {Storage | null} */
function safeStorage() {
  try {
    return localStorage
  } catch {
    return null
  }
}
