// @ts-check
// The tour's AI Chat: a pane beside the tour, on every step, with a thread per place of the tour
// (the tour as a whole, a landmark, a decision, a quiz question, the plan). It shows the thread of
// the step on screen and follows the reader from step to step. The thread's name opens the list of
// every thread, and go to stop brings a thread's step back. An answer keeps coming in while the
// reader reads another thread, and that thread is marked until they open it, across a reload too.
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
import { wireThreadList } from '../thread-list.js'
import { stepIndexOf } from './steps.js'
import {
  cancelTourChat,
  fetchTourThreadHistory,
  fetchTourThreads,
  markTourThreadUnseen,
  streamTourChat,
} from './tour-api.js'

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
 * of the whole tour, which new thread makes, is opened from the list of threads.
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
 *   markTourThreadUnseen: typeof markTourThreadUnseen,
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
  const api = {
    fetchTourThreads,
    fetchTourThreadHistory,
    streamTourChat,
    cancelTourChat,
    markTourThreadUnseen,
    ...options.api,
  }
  const storage = options.storage === undefined ? safeStorage() : options.storage
  /** @type {TourChatThreadsResponse['threads']} */
  let threads = []
  let agent = bundle.chat.agent ?? ''
  let open = false
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
  /** How many answers the reader has not seen, by thread: answers that ended off screen. */
  /** @type {Map<string, number>} */
  const unseen = new Map()
  /** Set once the pane is taken down: an answer that ends after it draws nothing. */
  let stopped = false
  /** What the reader typed and has not sent, by thread, so moving between steps keeps it. */
  /** @type {Map<string, string>} */
  const drafts = new Map()

  pane.innerHTML = shellHtml(bundle)
  const title = /** @type {HTMLElement} */ (qs('#tour-ask-title', pane))
  const goto = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-goto"]', pane))
  const log = /** @type {HTMLElement} */ (qs('#tour-ask-log', pane))
  const index = /** @type {HTMLElement} */ (qs('#tour-ask-threads', pane))
  // The list redraws its entries as it opens; `drawIndex` is defined below and runs only then.
  const threadList = wireThreadList({
    head: /** @type {HTMLElement} */ (qs('#tour-ask-switch', pane)),
    pop: /** @type {HTMLElement} */ (qs('#tour-ask-pop', pane)),
    filter: /** @type {HTMLInputElement} */ (qs('#tour-ask-filter', pane)),
    index,
    draw: () => drawIndex(),
  })
  const form = /** @type {HTMLFormElement} */ (qs('.chat-composer', pane))
  const box = /** @type {HTMLTextAreaElement} */ (qs('#tour-ask-box', pane))
  const send = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-send"]', pane))
  const stop = /** @type {HTMLButtonElement} */ (qs('[data-act="ask-stop"]', pane))

  const tour = bundle.tour
  /** @param {TourPlace} p */
  const placeName = p => tourPlaceLabel(p, tour)
  /** Where the box's text is kept for the thread on screen. */
  const draftKey = () => thread ?? `new:${JSON.stringify(place)}`
  const onScreen = () => open
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
    // The thread's name counts the threads with an answer not seen yet: the answer can be in any
    // thread, not only the one named.
    const fresh = unseen.size
    const note = /** @type {HTMLElement} */ (qs('#tour-ask-switch .threads-new', pane))
    note.hidden = fresh === 0
    note.textContent = `${fresh} new`
    note.title =
      fresh === 1
        ? 'A thread has an answer you have not seen'
        : `${fresh} threads have an answer you have not seen`
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
              `<li><button type="button" class="thread-item${t.name === thread ? ' current" aria-current="true' : ''}" data-act="ask-open" data-thread="${esc(t.name)}">` +
              `<span class="thread-item-t">${esc(placeName(t.place))}</span>` +
              `<span class="small ${status === 'new answer' ? 'thread-new' : 'muted'}">${esc(status)}</span></button></li>`
            )
          })
          .join('')
        return `<h3 class="thread-group">${esc(label)}</h3><ul class="thread-list">${items}</ul>`
      }).join('')
    }
    threadList.refilter()
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
    void api.markTourThreadUnseen(key, name, count).catch(() => undefined)
  }

  /** Marks the thread on screen as seen. */
  const see = () => {
    if (onScreen() && thread !== null && unseen.has(thread)) {
      setUnseen(thread, 0)
      drawIndex()
      options.onChange()
    }
  }

  /** Whether the list has come back once, which brings the marks the server kept. */
  let marked = false
  const refreshThreads = async () => {
    try {
      const data = await api.fetchTourThreads(key)
      threads = data.threads
      agent = data.agent
      if (!marked) {
        marked = true
        // Answers the reader had not seen before the reload are still marked.
        for (const t of threads) {
          if (t.unseen !== undefined && t.unseen > 0) unseen.set(t.name, t.unseen)
        }
        see()
      }
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
    turns = []
    drawn.clear()
    loaded = name === null
    box.value = drafts.get(draftKey()) ?? ''
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
          setUnseen(named, (unseen.get(named) ?? 0) + 1)
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
    const target = /** @type {Element} */ (e.target).closest('[data-act]')
    if (!(target instanceof HTMLElement)) {
      return
    }
    const act = target.dataset['act']
    if (act === 'ask-close') {
      hide()
    } else if (act === 'ask-goto') {
      options.onGoto(stepOfPlace(steps, place))
    } else if (act === 'ask-switch') {
      threadList.toggle()
      void refreshThreads()
    } else if (act === 'ask-new') {
      threadList.close()
      showThread({ kind: 'tour' }, null)
      box.focus()
    } else if (act === 'ask-open') {
      const t = threads.find(x => x.name === target.dataset['thread'])
      if (t !== undefined) {
        threadList.close()
        if (t.name !== thread) {
          showThread(t.place, t.name)
        }
        // The list is gone from under the focus: the box takes it.
        box.focus()
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
      else if (!sameChatContext(place, stepPlace)) showPlace(stepPlace)
      box.focus()
    },
    isOpen: () => open,
    /**
     * What the AI Chat launcher says: whether the step on screen has a thread, and how many
     * answers the reader has not seen.
     */
    marks() {
      return {
        open,
        thread: threadOfTourPlace(threads, agent, stepPlace) !== undefined,
        unseen: [...unseen.values()].reduce((sum, n) => sum + n, 0),
      }
    },
    stop() {
      stopped = true
      threadList.stop()
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
  // The thread's name opens the list of every thread under it, which can also start one about the
  // whole tour.
  return `<div class="tour-chat-box">
    <div class="chat-h"><h2 id="tour-ask-h">AI Chat</h2>
      <button class="cmd" type="button" data-act="ask-new" title="New thread about the whole tour">new thread</button>
      <button class="cmd" type="button" data-act="ask-close" title="Close AI Chat (esc)">close</button></div>
    <p class="ctx-line">${esc(agent)}${model} · read-only · a thread per stop</p>
    <div class="tour-ask-head">
      <button class="thread-switch" type="button" id="tour-ask-switch" data-act="ask-switch" aria-haspopup="dialog" aria-expanded="false" aria-controls="tour-ask-pop" title="Switch thread">
        <span class="thread-title" id="tour-ask-title"></span><span class="threads-new" hidden></span><span class="thread-caret" aria-hidden="true"></span></button>
      <button class="cmd" type="button" data-act="ask-goto" hidden>go to stop</button>
      <div class="thread-pop" id="tour-ask-pop" role="dialog" aria-label="Threads" hidden>
        <input class="thread-filter" id="tour-ask-filter" type="search" placeholder="Filter threads…" aria-label="Filter threads" autocomplete="off">
        <nav class="thread-index" id="tour-ask-threads" aria-label="Threads"></nav>
        <button class="thread-pop-new" type="button" data-act="ask-new">+ New thread about the whole tour</button>
      </div></div>
    <div class="transcript" id="tour-ask-log" role="log" aria-label="Transcript" aria-live="polite" tabindex="0"></div>
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
