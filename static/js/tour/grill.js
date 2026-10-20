// @ts-check
// The drawer "something else" opens. With AI Chat on, the agent grills the reader in the tour's own
// thread: it asks what it needs, then restates the change as a card the reader approves, edits, or
// rejects; only an approved restatement settles the decision and enters the plan. The reader may
// finish at any time, and the agent restates from what it has. The reader may speak instead of
// type. With chat off, the reader writes the restatement themselves in the same card.
/** @typedef {import('../contract-types.js').Decision} Decision */
/** @typedef {import('../contract-types.js').Restatement} Restatement */
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('../contract-types.js').TourGrillContext} TourGrillContext */
/** @typedef {import('./grill-cards.js').PlanBlock} PlanBlock */
import { ApiError } from '../api.js'
import { liveAnswer } from '../chat-answer.js'
import { esc, qs } from '../dom.js'
import { openFence } from '../fences.js'
import { renderMarkdown } from '../markdown.js'
import { readRestatementBlock, RESTATEMENT_FIELD_MAX, splitGrillAnswer } from './grill-cards.js'
import { inline, plain } from './screens.js'
import { cancelGrill, fetchGrillHistory, streamGrill } from './tour-api.js'

export const GRILL_DIALOG_ID = 'tour-grill'

/** What the reader says first, so the agent starts asking rather than the reader explaining. */
/** @param {Decision} d */
export function openingMessage(d) {
  return `On "${d.title}" I want neither "${d.keep.label}" nor "${d.change.label}". Ask me what you need to restate what I want instead.`
}

export const DONE_MESSAGE =
  'That\'s enough. Restate what I want now, from what we have, as one fenced ```restatement block of JSON with "what", "where", and "unchanged", so I can approve it.'

/** Sent when an answer to finish came back without the block, so the reader has a card to approve. */
export const CARD_MESSAGE =
  'Put that restatement in one fenced ```restatement block of JSON with "what", "where", and "unchanged", so I can approve it.'

export const PLAN_MESSAGE =
  'Restate the whole plan as one fenced ```plan block of JSON with "changes" and "kept": every change I approved and every decision I kept.'

/** Sent when the plan came back without its block, so the reader has a card to read it from. */
export const PLAN_CARD_MESSAGE =
  'Put that plan in one fenced ```plan block of JSON with "changes" (key, what, where, unchanged) and "kept" (decision keys).'

/**
 * @typedef {{
 *   fetchGrillHistory: typeof fetchGrillHistory,
 *   streamGrill: typeof streamGrill,
 *   cancelGrill: typeof cancelGrill,
 * }} GrillApi
 */

/**
 * @typedef {{
 *   dialog: HTMLDialogElement,
 *   key: string,
 *   bundle: TourBundle,
 *   onApprove: (decision: Decision, restatement: Restatement) => void,
 *   onReader: () => void,
 *   api?: Partial<GrillApi>,
 *   speech?: (new () => SpeechRecognitionLike) | null,
 * }} GrillOptions
 */

/**
 * The part of the Web Speech API the drawer uses.
 * @typedef {{
 *   lang: string,
 *   interimResults: boolean,
 *   onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null,
 *   onend: (() => void) | null,
 *   onerror: (() => void) | null,
 *   start: () => void,
 *   stop: () => void,
 * }} SpeechRecognitionLike
 */

/** The browser's speech recognizer, when it has one. */
export function speechRecognizer() {
  const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis))
  const found = w['SpeechRecognition'] ?? w['webkitSpeechRecognition']
  return typeof found === 'function' ? /** @type {new () => SpeechRecognitionLike} */ (found) : null
}

/**
 * True when the grilling runs through AI Chat: the project keeps it on, chat is on and acpx is
 * there, and the tour is not a preview.
 * @param {TourBundle} bundle
 */
export function grillsWithChat(bundle) {
  return bundle.options.grill !== 'off' && bundle.chat.enabled && !bundle.preview
}

/**
 * The restatement form, prefilled from a draft, or with where the decision points.
 * @param {Decision} d
 * @param {Restatement | undefined} draft
 * @param {{ cancel: string }} [opts]
 */
export function restatementFormHtml(d, draft, opts = { cancel: 'close-grill' }) {
  const r = draft ?? { what: '', where: [`${d.anchor.path}:${d.anchor.line}`], unchanged: '' }
  return `<form class="tour-restate" data-act="restate">
        <h4>What you want instead</h4>
        <label><b>What changes</b><textarea name="what" required maxlength="${RESTATEMENT_FIELD_MAX}">${esc(r.what)}</textarea></label>
        <label><b>Where</b> <span class="tour-hint">paths or places, one per line</span><textarea name="where" required maxlength="${RESTATEMENT_FIELD_MAX}">${esc(r.where.join('\n'))}</textarea></label>
        <label><b>Stays the same</b><textarea name="unchanged" required maxlength="${RESTATEMENT_FIELD_MAX}" placeholder="What this change must not touch">${esc(r.unchanged)}</textarea></label>
        <div class="tour-actions"><button class="cmd fill" type="submit">approve · into the plan</button><button class="cmd" type="button" data-act="${esc(opts.cancel)}">cancel</button></div>
      </form>`
}

/**
 * The drawer without an agent: the decision, what the code does, and the form.
 * @param {Decision} d
 * @param {Restatement | undefined} draft
 */
export function formGrillHtml(d, draft) {
  return `<div class="tour-chat-box">
    <div class="chat-h"><h2>Something else · ${esc(d.title)}</h2><button class="cmd" type="button" data-act="close-grill">close</button></div>
    <p class="ctx-line">say what you want instead, in your words</p>
    <div class="transcript" id="grill-log">
      <div class="turn a"><span class="role">The decision</span><div class="prose">${inline(d.context)}</div></div>
      <div class="turn a"><span class="role">What the code does</span><div class="prose">${esc(d.keep.label)}. ${inline(d.keep.consequence)}</div></div>
      ${restatementFormHtml(d, draft)}
    </div>
  </div>`
}

/**
 * The restatement the form holds, read as the agent's card is, or null while a field is empty. A
 * place is one line, so a place that names something with a comma in it stays one place.
 * @param {HTMLFormElement} form
 * @returns {Restatement | null}
 */
export function readRestatement(form) {
  const data = new FormData(form)
  const read = readRestatementBlock({
    what: data.get('what'),
    unchanged: data.get('unchanged'),
    where: String(data.get('where') ?? '').split('\n'),
  })
  return 'restatement' in read ? read.restatement : null
}

/**
 * A restatement as the agent's card: approve, edit, or say what is wrong.
 * @param {Restatement} r
 * @param {string | number} key where the drawer keeps the restatement
 */
export function restatementCardHtml(r, key) {
  return `<div class="tour-restate" data-restatement="${esc(String(key))}"><h4>Here is what I understood</h4>
    <b>What changes</b>${inline(r.what)}<b>Where</b><div class="where">${r.where.map(w => `<span>${esc(w)}</span>`).join('')}</div><b>Stays the same</b>${inline(r.unchanged)}
    <div class="tour-actions"><button class="cmd fill" type="button" data-act="approve" data-restatement="${esc(String(key))}">approve</button><button class="cmd" type="button" data-act="edit" data-restatement="${esc(String(key))}">edit</button><button class="cmd" type="button" data-act="reject">no, that is not it</button></div></div>`
}

/**
 * The restatement the reader approved after editing it: the one in the plan, which they may edit
 * again.
 * @param {Restatement} r
 */
export function approvedCardHtml(r) {
  return `<div class="tour-restate tour-approved" data-restatement="approved"><h4>What you approved</h4>
    <b>What changes</b>${inline(r.what)}<b>Where</b><div class="where">${r.where.map(w => `<span>${esc(w)}</span>`).join('')}</div><b>Stays the same</b>${inline(r.unchanged)}
    <div class="tour-actions"><button class="cmd" type="button" data-act="edit" data-restatement="approved">edit</button></div></div>`
}

/**
 * The whole plan as the agent restated it.
 * @param {PlanBlock} plan
 * @param {TourBundle} bundle
 */
export function planCardHtml(plan, bundle) {
  const title = /** @param {string} key */ key =>
    bundle.tour?.decisions.find(d => d.key === key)?.title ?? key
  return `<div class="tour-restate tour-plan-card"><h4>The plan, as I understand it</h4>
    <b>Changes</b>${plan.changes.length === 0 ? '<p>none</p>' : `<ol>${plan.changes.map(c => `<li><b>${esc(title(c.key))}</b> ${inline(c.what)} <span class="where">${c.where.map(w => `<span>${esc(w)}</span>`).join('')}</span> <em>stays: ${inline(c.unchanged)}</em></li>`).join('')}</ol>`}
    <b>Kept</b>${plan.kept.length === 0 ? '<p>none</p>' : `<ul>${plan.kept.map(k => `<li>${esc(title(k))}</li>`).join('')}</ul>`}
    <p class="tour-hint">Confirm the plan on its page when this reads right.</p></div>`
}

/**
 * One answer as HTML: prose, restatement cards, plan cards, and what failed to be a block.
 * @param {string} text
 * @param {TourBundle} bundle
 * @param {Map<string, Restatement>} sink the restatements found; a card's key points here
 * @param {string} turnKey this answer's part of the keys, replaced on each redraw of it
 */
export function answerHtml(text, bundle, sink, turnKey) {
  const keys = new Set((bundle.tour?.decisions ?? []).map(d => d.key))
  for (const key of [...sink.keys()]) {
    if (key.startsWith(`${turnKey}-`)) {
      sink.delete(key)
    }
  }
  let n = 0
  return splitGrillAnswer(text, keys)
    .map(segment => {
      if (segment.type === 'markdown') {
        return renderMarkdown(segment.text)
      }
      if (segment.type === 'restatement') {
        const key = `${turnKey}-${n++}`
        sink.set(key, segment.restatement)
        return restatementCardHtml(segment.restatement, key)
      }
      if (segment.type === 'plan') {
        return planCardHtml(segment.plan, bundle)
      }
      return `<pre class="tour-invalid"><code>${esc(segment.text)}</code></pre><p class="tour-hint">${esc(segment.reason)}</p>`
    })
    .join('')
}

/**
 * The drawer, wired once for the page. `open` draws it for a decision, or for the plan.
 * @param {GrillOptions} options
 */
export function createGrill(options) {
  const { dialog, key, bundle } = options
  const api = { fetchGrillHistory, streamGrill, cancelGrill, ...options.api }
  const Speech = options.speech === undefined ? speechRecognizer() : options.speech
  /** @type {Decision | null} */
  let decision = null
  /** @type {TourGrillContext} */
  let context = { kind: 'tour-plan' }
  /** The restatements on screen, by the key their card's buttons carry. */
  /** @type {Map<string, Restatement>} */
  const restatements = new Map()
  /**
   * Answers drawn as they streamed, kept as they are: their elapsed time and tool calls stay
   * under them when the drawer is drawn again.
   * @type {Map<ChatTurn, HTMLElement>}
   */
  const drawn = new Map()
  let stopLive = () => {}
  let streaming = false
  /** @type {AbortController | null} */
  let inFlight = null
  let notice = false
  /** @type {SpeechRecognitionLike | null} */
  let listening = null
  /** @type {ChatTurn[]} */
  let history = []
  let historyLoaded = false
  /** True from a click on finish until the agent's answer to it ends. */
  let finishing = false
  /** A message refused because another answer runs for this pull request, kept to send again. */
  let refused = ''
  /** True when the answer to finish came back without a card to approve. */
  let missed = false
  /** The restatement the reader approved before, when it is not the agent's last card: an edit. */
  /** @type {Restatement | null} */
  let approved = null

  const log = () => /** @type {HTMLElement | null} */ (qs('#grill-log', dialog))
  const composer = () => /** @type {HTMLTextAreaElement | null} */ (qs('#composer', dialog))

  /** @param {Decision | null} d */
  const headerHtml = d => {
    const agent = bundle.chat.agent ?? 'agent'
    const model = bundle.chat.model ? ` · ${esc(bundle.chat.model)}` : ''
    const title = d === null ? 'The plan' : `Grilling · ${plain(d.title)}`
    return `<div class="chat-h"><h2>${title}</h2><button class="cmd" type="button" data-act="close-grill">close</button></div><p class="ctx-line">${esc(agent)}${model} · read-only · one thread per tour</p>`
  }

  /**
   * The turns of this conversation: a decision's exchange, or the plan's. The tour keeps one thread,
   * so an answer belongs to the reader's turn before it.
   */
  const visible = () => {
    let mine = false
    return history.filter(turn => {
      if (turn.role === 'user') {
        mine =
          decision === null
            ? turn.context?.kind === 'tour-plan'
            : turn.context?.kind === 'tour-decision' && turn.context.key === decision.key
      }
      return mine
    })
  }

  /**
   * Where the reader is in a decision's grilling: talking it through, waiting for the agent to
   * restate after finish, or reading a restatement to approve.
   * @returns {'talk' | 'finish' | 'approve'}
   */
  const stage = () => {
    if (streaming) {
      return finishing ? 'finish' : 'talk'
    }
    const last = visible().at(-1)
    return last?.role === 'assistant' && hasCard(last.text) ? 'approve' : 'talk'
  }

  /**
   * True when an answer holds the card asked for: a restatement on a decision, the plan on the plan.
   * @param {string} text
   */
  const hasCard = text => {
    const keys = new Set((bundle.tour?.decisions ?? []).map(d => d.key))
    const kind = decision === null ? 'plan' : 'restatement'
    return splitGrillAnswer(text, keys).some(s => s.type === kind)
  }

  /** The three steps of a grilling, the one the reader is on marked. */
  const stepsHtml = () => {
    const at = ['talk', 'finish', 'approve'].indexOf(stage())
    const step = (/** @type {number} */ i, /** @type {string} */ label) =>
      `<li data-state="${i < at ? 'done' : i === at ? 'now' : 'next'}"${i === at ? ' aria-current="step"' : ''}><b>${i < at ? '✓' : i + 1}</b>${label}</li>`
    return `<ol class="tour-grill-steps" aria-label="Steps">${step(0, 'talk it through')}${step(1, 'finish')}${step(2, 'approve')}</ol>`
  }

  /** What to do now, under the transcript: finish while talking, then approve the restatement. */
  const guideHtml = () => {
    if (refused !== '') {
      return '<div class="tour-grill-guide" role="alert"><p>Another answer is still running for this pull request, in another tab or in the canvas\'s AI Chat.</p><button class="cmd fill" type="button" data-act="busy-retry">stop it and retry</button></div>'
    }
    const now = stage()
    if (now === 'finish') {
      return '<div class="tour-grill-guide" role="status"><p>The agent is restating what you want from the conversation…</p></div>'
    }
    if (!streaming && unanswered() !== null) {
      return '<div class="tour-grill-guide" role="status"><p>The answer stopped before it began, so the agent has not read your last message.</p><button class="cmd fill" type="button" data-act="resend">send it again</button></div>'
    }
    if (missed && decision === null) {
      return '<div class="tour-grill-guide" role="status"><p>The agent answered without a plan card.</p><button class="cmd fill" type="button" data-act="ask-card">ask for the card</button></div>'
    }
    if (now === 'talk' && missed) {
      return '<div class="tour-grill-guide" role="status"><p>The agent answered without a card to approve.</p><button class="cmd fill" type="button" data-act="ask-card">ask for the card</button><button class="cmd" type="button" data-act="write-own">write it myself</button></div>'
    }
    if (now === 'approve') {
      return '<div class="tour-grill-guide" role="status"><p><b>Approve</b> the restatement above to record the decision. Not quite? Edit it, or say what is wrong below.</p></div>'
    }
    return `<div class="tour-grill-guide"><p>Answer the agent's questions in your words. <b>Said enough?</b> Finish, and the agent restates what you want for you to approve.</p><button class="cmd fill" type="button" data-act="done"${streaming ? ' disabled' : ''}>finish</button></div>`
  }

  /** @param {string | undefined} incomplete */
  const stoppedHtml = incomplete =>
    incomplete === undefined ? '' : `<p class="muted small">the answer stopped early (${esc(incomplete)})</p>`

  const NOT_ANSWERED = '<span class="muted">stopped before it answered</span>'

  /**
   * True for an answer stopped before a word, by the reader or by a cancel; an error keeps its note.
   * @param {ChatTurn} turn
   */
  const stoppedEarly = turn =>
    turn.text.trim() === '' && (turn.incomplete === 'stopped' || turn.incomplete === 'cancelled')

  /**
   * The reader's last message, when the answer to it stopped before a word: the one to send again.
   * @returns {string | null}
   */
  const unanswered = () => {
    const turns = visible()
    const last = turns.at(-1)
    const asked = turns.at(-2)
    return last?.role === 'assistant' &&
      last.text.trim() === '' &&
      last.incomplete !== undefined &&
      asked?.role === 'user'
      ? asked.text
      : null
  }

  /** @param {ChatTurn} turn */
  const turnHtml = turn => {
    const i = history.indexOf(turn)
    if (turn.role === 'user') {
      return `<div class="turn u" data-turn="${i}"><span class="role">You</span><div class="prose"><p>${esc(turn.text)}</p></div></div>`
    }
    if (drawn.has(turn)) {
      return `<div data-keep="${i}"></div>`
    }
    const body = stoppedEarly(turn) ? NOT_ANSWERED : answerHtml(turn.text, bundle, restatements, `t${i}`)
    const note = stoppedEarly(turn) ? '' : stoppedHtml(turn.incomplete)
    return `<div class="turn a" data-turn="${i}"><span class="role">AI Chat</span><div class="prose">${body}</div>${note}</div>`
  }

  /**
   * An answer as it streams. A card is drawn once its block is whole, not as code that grows
   * while the agent writes it.
   * @param {string} text
   * @param {boolean} done
   * @param {string} turnKey
   */
  const liveHtml = (text, done, turnKey) => {
    const open = done ? null : openFence(text, ['restatement', 'plan'])
    if (open === null) {
      return answerHtml(text, bundle, restatements, turnKey)
    }
    return `${answerHtml(open.before, bundle, restatements, turnKey)}<p class="tour-writing" role="status">writing the ${open.info === 'plan' ? 'plan' : 'restatement'}…</p>`
  }

  /**
   * Only the newest card is one to act on: an earlier one, before a correction or an edit, loses
   * its commands, so the reader cannot approve what they already said was wrong.
   */
  const markEarlierCards = () => {
    const cards = [...(log()?.querySelectorAll('.tour-restate[data-restatement]') ?? [])]
    for (const card of cards.slice(0, -1)) {
      card.classList.add('earlier')
      card.querySelector('h4')?.replaceChildren('An earlier restatement')
      card.querySelector('.tour-actions')?.remove()
    }
  }

  const scrollToEnd = () => {
    const el = log()
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
  }

  /** The drawer's commands, after send: stop, the mic, and the grilling's own. */
  const commandsHtml = () => {
    const audio = bundle.options.audio === 'on' && !bundle.reader.audioOff
    const mic = !audio
      ? ''
      : Speech === null
        ? '<button class="cmd tour-mic" type="button" disabled title="This browser has no speech recognition" aria-label="Speak">🎙</button>'
        : `<button class="cmd tour-mic" type="button" data-act="mic" data-state="${listening ? 'listening' : ''}" aria-label="Speak" title="Speak instead of typing">🎙</button>`
    const stop = streaming ? '<button class="cmd" type="button" data-act="stop">stop</button>' : ''
    return `${stop}${mic}`
  }

  const composerHtml = () => {
    const noticeHtml = notice
      ? '<div class="tour-notice">Speech is turned into text by your browser, which may send the audio to its vendor for that. Project setting: audio on.<div class="tbtns"><button class="cmd" type="button" data-act="notice-ok">got it</button><button class="cmd" type="button" data-act="notice-off">turn audio off for me</button></div></div>'
      : ''
    return `<form class="chat-composer" data-act="send">${noticeHtml}<label class="sr" for="composer">Message</label><textarea id="composer" rows="2" placeholder="${listening ? 'Listening…' : decision !== null && stage() === 'approve' ? 'Not it? Say what is wrong' : 'Answer, or ask'}"${streaming ? ' disabled' : ''}></textarea><div class="tbtns"><button class="cmd fill" type="submit"${streaming ? ' disabled' : ''}>send</button>${commandsHtml()}<span class="muted small">enter to send</span></div></form>`
  }

  const render = () => {
    // What the reader typed survives a redraw.
    const typed = composer()?.value ?? ''
    const steps = decision === null ? '' : stepsHtml()
    const guide =
      decision === null && refused === '' && !missed && (streaming || unanswered() === null)
        ? ''
        : guideHtml()
    const box = `<div class="tour-chat-box">${headerHtml(decision)}${steps}<div class="transcript" id="grill-log" role="log" aria-label="Transcript">${visible().map(turnHtml).join('')}${
      historyLoaded ? '' : '<p class="empty">Opening this thread…</p>'
    }</div>${guide}${composerHtml()}</div>`
    dialog.innerHTML = box
    if (approved !== null && decision !== null && historyLoaded) {
      restatements.set('approved', approved)
      log()?.insertAdjacentHTML('beforeend', approvedCardHtml(approved))
    }
    for (const slot of dialog.querySelectorAll('[data-keep]')) {
      const kept = drawn.get(/** @type {ChatTurn} */ (history[Number(slot.getAttribute('data-keep'))]))
      if (kept !== undefined) {
        slot.replaceWith(kept)
      }
    }
    markEarlierCards()
    scrollToEnd()
    const next = composer()
    if (next !== null) {
      next.value = typed
      // On a touch screen focus would open the keyboard over the conversation the reader came to read.
      const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      if (!streaming && !listening && !touch) {
        next.focus()
      }
    }
  }

  /** @param {string} text */
  const send = async text => {
    const message = text.trim()
    if (message === '' || streaming) {
      return
    }
    streaming = true
    missed = false
    const asked = finishing
    history.push({ role: 'user', text: message, at: new Date().toISOString(), context })
    /** @type {ChatTurn} */
    const answer = { role: 'assistant', text: '', at: new Date().toISOString() }
    history.push(answer)
    const turnKey = `t${history.length - 1}`
    const turn = document.createElement('div')
    turn.className = 'turn a'
    turn.dataset['turn'] = String(history.length - 1)
    turn.innerHTML = '<span class="role">AI Chat</span><div class="prose"></div>'
    drawn.set(answer, turn)
    render()
    const live = liveAnswer({
      turn,
      body: /** @type {HTMLElement} */ (turn.querySelector('.prose')),
      render: (written, done) => liveHtml(written, done, turnKey),
      onDraw: scrollToEnd,
      onError: (failure, code) => {
        answer.incomplete = code
        history.push({ role: 'assistant', text: '', at: '', incomplete: failure })
      },
      onCancelled: () => {
        answer.incomplete = 'cancelled'
      },
    })
    stopLive = live.stop
    inFlight = new AbortController()
    try {
      await api.streamGrill(key, { message, context }, { signal: inFlight.signal, onEvent: live.onEvent })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHAT_BUSY') {
        // Nothing was said: the two turns go, and the message waits for "stop it and retry".
        history.splice(history.indexOf(answer) - 1, 2)
        drawn.delete(answer)
        refused = message
      } else if (err instanceof Error && err.name === 'AbortError') {
        answer.incomplete ??= 'stopped'
      } else {
        answer.incomplete = err instanceof Error ? err.message : String(err)
      }
    } finally {
      streaming = false
      finishing = false
      inFlight = null
      stopLive = () => {}
      answer.text = live.text()
      live.finish()
      if (stoppedEarly(answer)) {
        const body = turn.querySelector('.prose')
        if (body !== null) {
          body.innerHTML = NOT_ANSWERED
        }
      } else {
        turn.insertAdjacentHTML('beforeend', stoppedHtml(answer.incomplete))
      }
      // A new card from the agent is the one to act on now, over an edit approved before.
      if (hasCard(answer.text)) {
        approved = null
      }
      // Finish asks for a card; an answer without one gets a way to ask again or write it.
      missed = asked && answer.incomplete === undefined && drawn.has(answer) && !hasCard(answer.text)
      render()
    }
  }

  /** Sends what the reader typed and empties the box, so the redraw does not put it back. */
  const sendTyped = () => {
    const box = composer()
    if (box === null || streaming) {
      return
    }
    const text = box.value
    box.value = ''
    void send(text)
  }

  const stop = () => {
    inFlight?.abort()
    void api.cancelGrill(key).catch(() => undefined)
  }

  const listen = () => {
    if (Speech === null || listening !== null) {
      return
    }
    const recognizer = new Speech()
    recognizer.lang = typeof navigator === 'undefined' ? 'en' : navigator.language
    recognizer.interimResults = false
    recognizer.onresult = event => {
      const heard = [...Array.from(event.results)].map(r => r[0]?.transcript ?? '').join(' ')
      const box = composer()
      if (box !== null) {
        box.value = `${box.value}${box.value === '' ? '' : ' '}${heard}`.trim()
      }
    }
    recognizer.onend = () => {
      listening = null
      render()
    }
    recognizer.onerror = recognizer.onend
    listening = recognizer
    render()
    recognizer.start()
  }

  /** @param {Event} e */
  const onClick = e => {
    const target = e.target instanceof Element ? e.target.closest('[data-act]') : null
    if (!(target instanceof HTMLElement)) {
      return
    }
    const act = target.dataset['act']
    if (act === 'close-grill') {
      close()
    } else if (act === 'approve' && decision !== null) {
      const r = restatements.get(target.dataset['restatement'] ?? '')
      if (r !== undefined) {
        options.onApprove(decision, r)
        close()
      }
    } else if (act === 'edit' && decision !== null) {
      const r = restatements.get(target.dataset['restatement'] ?? '')
      const card = target.closest('.tour-restate')
      if (r !== undefined && card !== null) {
        card.outerHTML = restatementFormHtml(decision, r, { cancel: 'redraw' })
        dialog.querySelector('textarea')?.focus()
      }
    } else if (act === 'redraw') {
      // The form goes back to the card it came from; a form of the reader's own just goes.
      const turnEl = target.closest('.turn[data-turn]')
      const i = Number(turnEl?.getAttribute('data-turn'))
      const turn = history[i]
      const body = turnEl?.querySelector('.prose')
      if (turn !== undefined && body instanceof HTMLElement) {
        body.innerHTML = answerHtml(turn.text, bundle, restatements, `t${i}`)
      } else {
        render()
      }
    } else if (act === 'resend') {
      const message = unanswered()
      if (message !== null) {
        finishing = message === DONE_MESSAGE
        void send(message)
      }
    } else if (act === 'ask-card') {
      finishing = true
      void send(decision === null ? PLAN_CARD_MESSAGE : CARD_MESSAGE)
    } else if (act === 'write-own' && decision !== null) {
      missed = false
      render()
      log()?.insertAdjacentHTML('beforeend', restatementFormHtml(decision, undefined, { cancel: 'redraw' }))
      log()?.querySelector('textarea')?.focus()
      scrollToEnd()
    } else if (act === 'reject') {
      const box = composer()
      if (box !== null) {
        box.value = 'No, that is not it: '
        box.focus()
      }
    } else if (act === 'busy-retry') {
      const message = refused
      refused = ''
      finishing = message === DONE_MESSAGE
      // The server waits for a stopped turn to let go, so the message goes right after the stop.
      void api
        .cancelGrill(key)
        .catch(() => undefined)
        .then(() => send(message))
    } else if (act === 'done') {
      finishing = true
      void send(DONE_MESSAGE)
    } else if (act === 'stop') {
      stop()
    } else if (act === 'mic') {
      if (!bundle.reader.audioNoticeSeen) {
        notice = true
        render()
        return
      }
      listen()
    } else if (act === 'notice-ok') {
      bundle.reader.audioNoticeSeen = true
      notice = false
      options.onReader()
      listen()
    } else if (act === 'notice-off') {
      bundle.reader.audioNoticeSeen = true
      bundle.reader.audioOff = true
      notice = false
      options.onReader()
      render()
    }
  }

  /** @param {Event} e */
  const onSubmit = e => {
    const form = e.target
    if (!(form instanceof HTMLFormElement)) {
      return
    }
    if (form.dataset['act'] === 'send') {
      e.preventDefault()
      sendTyped()
    } else if (form.dataset['act'] === 'restate') {
      e.preventDefault()
      const r = readRestatement(form)
      if (decision !== null && r !== null) {
        options.onApprove(decision, r)
        close()
      }
    }
  }

  /** @param {KeyboardEvent} e */
  const onKeydown = e => {
    const target = e.target
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      target instanceof HTMLTextAreaElement &&
      target.id === 'composer'
    ) {
      e.preventDefault()
      sendTyped()
    }
  }

  const close = () => {
    if (streaming) {
      stop()
    }
    listening?.stop()
    if (dialog.open) {
      dialog.close()
    }
  }

  dialog.addEventListener('click', onClick)
  dialog.addEventListener('submit', onSubmit)
  dialog.addEventListener('keydown', onKeydown)

  /**
   * The thread, read again each time the drawer opens: another tab, or the canvas's AI Chat, may
   * have added to it since.
   */
  const loadHistory = async () => {
    try {
      history = (await api.fetchGrillHistory(key)).turns
    } catch {
      // A thread that cannot be read now keeps what this page already had.
      if (!historyLoaded) {
        history = []
      }
    }
    // The answers drawn live belonged to the turns read before; the thread read now replaces them.
    drawn.clear()
    historyLoaded = true
  }

  /**
   * True when the agent already answered about the open decision, so the opening is not sent again.
   * An exchange whose answers all stopped before a word gets the opening again.
   */
  /**
   * True when the agent's last card in this exchange says what `r` says.
   * @param {Restatement} r
   */
  const lastCardIs = r => {
    const keys = new Set((bundle.tour?.decisions ?? []).map(d => d.key))
    const cards = visible().flatMap(t =>
      t.role === 'assistant'
        ? splitGrillAnswer(t.text, keys).flatMap(seg => (seg.type === 'restatement' ? [seg.restatement] : []))
        : []
    )
    return JSON.stringify(cards.at(-1) ?? null) === JSON.stringify(r)
  }

  const answeredBefore = () => visible().some(t => t.role === 'assistant' && t.text.trim() !== '')

  return {
    /**
     * @param {Decision} d
     * @param {Restatement | undefined} draft the restatement approved before, when reopening
     */
    async open(d, draft) {
      decision = d
      context = { kind: 'tour-decision', key: d.key }
      missed = false
      if (!grillsWithChat(bundle)) {
        dialog.innerHTML = formGrillHtml(d, draft)
        dialog.showModal()
        dialog.querySelector('textarea')?.focus()
        return
      }
      approved = null
      render()
      dialog.showModal()
      await loadHistory()
      approved = draft !== undefined && !lastCardIs(draft) ? draft : null
      render()
      if (!answeredBefore()) {
        await send(openingMessage(d))
      }
    },
    /** The plan as the agent restates it, at the end of the tour. */
    async openPlan() {
      decision = null
      context = { kind: 'tour-plan' }
      missed = false
      render()
      dialog.showModal()
      await loadHistory()
      render()
      finishing = true
      await send(PLAN_MESSAGE)
    },
    close,
    stop() {
      close()
      stopLive()
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('submit', onSubmit)
      dialog.removeEventListener('keydown', onKeydown)
    },
  }
}
