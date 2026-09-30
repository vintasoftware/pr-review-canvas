// @ts-check
// The drawer a change pick opens. With AI Chat on, the agent grills the reader in the tour's own
// thread: it asks what it needs, then restates the change as a card the reader approves, edits, or
// rejects; only an approved restatement settles the decision and enters the plan. The reader may
// also ask how the agent would carry it out (the reverse quiz), and speak instead of type. With
// chat off, the reader writes the restatement themselves in the same card.
/** @typedef {import('../contract-types.js').Decision} Decision */
/** @typedef {import('../contract-types.js').Restatement} Restatement */
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').ChatTurn} ChatTurn */
/** @typedef {import('../contract-types.js').TourGrillContext} TourGrillContext */
/** @typedef {import('./grill-cards.js').PlanBlock} PlanBlock */
import { esc, qs } from '../dom.js'
import { renderMarkdown } from '../markdown.js'
import { splitGrillAnswer } from './grill-cards.js'
import { inline } from './screens.js'
import { cancelGrill, fetchGrillHistory, streamGrill } from './tour-api.js'

export const GRILL_DIALOG_ID = 'tour-grill'

/** What the reader says first, so the agent starts asking rather than the reader explaining. */
/** @param {Decision} d */
export function openingMessage(d) {
  return `I want to change this decision: ${d.change.label}. Ask me what you need to restate it.`
}

export const REVERSE_QUIZ_MESSAGE =
  'How would you carry this change out? Name the files and the steps, in order, and what you would run to check it.'

export const PLAN_MESSAGE =
  'Restate the whole plan as one plan block: every change I approved and every decision I kept.'

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
 * The restatement form, prefilled from a draft or from the decision itself.
 * @param {Decision} d
 * @param {Restatement | undefined} draft
 * @param {{ cancel: string }} [opts]
 */
export function restatementFormHtml(d, draft, opts = { cancel: 'close-grill' }) {
  const r = draft ?? { what: d.change.label, where: [`${d.anchor.path}:${d.anchor.line}`], unchanged: '' }
  return `<form class="tour-restate" data-act="restate">
        <h4>What you want instead</h4>
        <label><b>What changes</b><textarea name="what" required maxlength="2000">${esc(r.what)}</textarea></label>
        <label><b>Where</b> <span class="tour-hint">paths or places, comma separated</span><textarea name="where" required maxlength="2000">${esc(r.where.join(', '))}</textarea></label>
        <label><b>Stays the same</b><textarea name="unchanged" required maxlength="2000" placeholder="What this change must not touch">${esc(r.unchanged)}</textarea></label>
        <div class="tour-actions"><button class="tour-btn primary" type="submit">Approve · into the plan</button><button class="tour-btn quiet" type="button" data-act="${esc(opts.cancel)}">Cancel</button></div>
      </form>`
}

/**
 * The drawer without an agent: the decision, what the code does, and the form.
 * @param {Decision} d
 * @param {Restatement | undefined} draft
 */
export function formGrillHtml(d, draft) {
  return `<div class="tour-chat-box">
    <div class="tour-chat-h"><div><b>Change · ${esc(d.title)}</b><span class="agent">say what you want instead, in your words</span></div><button class="tour-btn quiet" type="button" data-act="close-grill" aria-label="Close">✕</button></div>
    <div class="tour-chat-log">
      <div class="tour-msg agent"><span class="who">the decision</span>${inline(d.context)}</div>
      <div class="tour-msg agent"><span class="who">what the code does</span>${esc(d.keep.label)}. ${inline(d.keep.consequence)}</div>
      ${restatementFormHtml(d, draft)}
    </div>
  </div>`
}

/**
 * The restatement the form holds, or null while a field is empty.
 * @param {HTMLFormElement} form
 * @returns {Restatement | null}
 */
export function readRestatement(form) {
  const data = new FormData(form)
  const what = String(data.get('what') ?? '').trim()
  const unchanged = String(data.get('unchanged') ?? '').trim()
  const where = String(data.get('where') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
  if (what === '' || unchanged === '' || where.length === 0) {
    return null
  }
  return { what, where, unchanged }
}

/**
 * A restatement as the agent's card: approve, edit, or say what is wrong.
 * @param {Restatement} r
 * @param {number} index
 */
export function restatementCardHtml(r, index) {
  return `<div class="tour-restate" data-restatement="${index}"><h4>Here is what I understood</h4>
    <b>What changes</b>${inline(r.what)}<b>Where</b><div class="where">${r.where.map(w => `<span>${esc(w)}</span>`).join('')}</div><b>Stays the same</b>${inline(r.unchanged)}
    <div class="tour-actions"><button class="tour-btn primary" type="button" data-act="approve" data-restatement="${index}">Approve</button><button class="tour-btn" type="button" data-act="edit" data-restatement="${index}">Edit</button><button class="tour-btn quiet" type="button" data-act="reject">No, that is not it</button></div></div>`
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
 * @param {Restatement[]} sink the restatements found, in order; a card's index points here
 */
export function answerHtml(text, bundle, sink) {
  const keys = new Set((bundle.tour?.decisions ?? []).map(d => d.key))
  return splitGrillAnswer(text, keys)
    .map(segment => {
      if (segment.type === 'markdown') {
        return renderMarkdown(segment.text)
      }
      if (segment.type === 'restatement') {
        sink.push(segment.restatement)
        return restatementCardHtml(segment.restatement, sink.length - 1)
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
  /** @type {Restatement[]} */
  let restatements = []
  let streaming = false
  /** @type {AbortController | null} */
  let inFlight = null
  let notice = false
  /** @type {SpeechRecognitionLike | null} */
  let listening = null
  /** @type {ChatTurn[]} */
  let history = []
  let historyLoaded = false

  const log = () => /** @type {HTMLElement | null} */ (qs('.tour-chat-log', dialog))
  const composer = () => /** @type {HTMLTextAreaElement | null} */ (qs('#composer', dialog))

  /** @param {Decision | null} d */
  const headerHtml = d => {
    const agent = bundle.chat.agent ?? 'agent'
    const model = bundle.chat.model ? ` · ${esc(bundle.chat.model)}` : ''
    const title = d === null ? 'The plan' : `Grilling · ${esc(d.title)}`
    return `<div class="tour-chat-h"><div><b>${title}</b><span class="agent">${esc(agent)}${model} · read-only · one thread per tour</span></div><button class="tour-btn quiet" type="button" data-act="close-grill" aria-label="Close">✕</button></div>`
  }

  /** @param {ChatTurn} turn */
  const turnHtml = turn => {
    if (turn.role === 'user') {
      return `<div class="tour-msg reader"><span class="who">you</span>${esc(turn.text)}</div>`
    }
    const note =
      turn.incomplete === undefined
        ? ''
        : `<div class="tour-msg note">the answer stopped early (${esc(turn.incomplete)})</div>`
    return `<div class="tour-msg agent"><span class="who">agent</span>${answerHtml(turn.text, bundle, restatements)}</div>${note}`
  }

  const toolsHtml = () => {
    const reverse = bundle.options.reverseQuiz === 'on' && decision !== null
    return `<div class="tour-tools">${reverse ? '<button class="tour-btn" type="button" data-act="reverse">Ask how it would do it</button><span class="tour-hint">reverse quiz · optional</span>' : ''}${streaming ? '<button class="tour-btn quiet" type="button" data-act="stop">stop</button>' : ''}</div>`
  }

  const composerHtml = () => {
    const audio = bundle.options.audio === 'on' && !bundle.reader.audioOff
    const mic = !audio
      ? ''
      : Speech === null
        ? '<button class="tour-btn icon tour-mic" type="button" disabled title="This browser has no speech recognition" aria-label="Speak">🎙</button>'
        : `<button class="tour-btn icon tour-mic" type="button" data-act="mic" data-state="${listening ? 'listening' : ''}" aria-label="Speak" title="Speak instead of typing">🎙</button>`
    const noticeHtml = notice
      ? '<div class="tour-notice">Speech is turned into text by your browser, which may send the audio to its vendor for that. Project setting: audio on.<div class="tour-actions"><button class="tour-btn" type="button" data-act="notice-ok">Got it</button><button class="tour-btn quiet" type="button" data-act="notice-off">Turn audio off for me</button></div></div>'
      : ''
    return `<form class="tour-composer" data-act="send">${noticeHtml}<textarea id="composer" rows="1" placeholder="${listening ? 'Listening…' : 'Answer, or ask'}"${streaming ? ' disabled' : ''}></textarea>${mic}<button class="tour-btn primary" type="submit"${streaming ? ' disabled' : ''}>send</button></form>`
  }

  const render = () => {
    restatements = []
    // What the reader typed survives a redraw.
    const typed = composer()?.value ?? ''
    const box = `<div class="tour-chat-box">${headerHtml(decision)}<div class="tour-chat-log" id="grill-log">${history.map(turnHtml).join('')}${
      historyLoaded ? '' : '<div class="tour-msg note">loading the thread…</div>'
    }</div>${toolsHtml()}${composerHtml()}</div>`
    dialog.innerHTML = box
    const el = log()
    if (el !== null) {
      el.scrollTop = el.scrollHeight
    }
    const next = composer()
    if (next !== null) {
      next.value = typed
      if (!streaming && !listening) {
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
    history.push({ role: 'user', text: message, at: new Date().toISOString(), context })
    /** @type {ChatTurn} */
    const answer = { role: 'assistant', text: '', at: new Date().toISOString() }
    history.push(answer)
    render()
    inFlight = new AbortController()
    const draw = () => {
      const el = log()
      const last = el?.lastElementChild
      if (el === null || !(last instanceof HTMLElement)) {
        return
      }
      restatements = []
      // Cards of earlier answers keep their index: they are counted again from the top.
      el.innerHTML = history.map(turnHtml).join('')
      el.scrollTop = el.scrollHeight
    }
    try {
      await api.streamGrill(
        key,
        { message, context },
        {
          signal: inFlight.signal,
          onEvent: event => {
            const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
            if (event.event === 'chunk' && typeof data['text'] === 'string') {
              answer.text += data['text']
              draw()
            } else if (event.event === 'error' && typeof data['message'] === 'string') {
              answer.incomplete = String(data['code'] ?? 'error')
              history.push({ role: 'assistant', text: '', at: '', incomplete: data['message'] })
            } else if (event.event === 'cancelled') {
              answer.incomplete = 'cancelled'
            }
          },
        }
      )
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) {
        answer.incomplete = err instanceof Error ? err.message : String(err)
      }
    } finally {
      streaming = false
      inFlight = null
      render()
    }
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
      const r = restatements[Number(target.dataset['restatement'])]
      if (r !== undefined) {
        options.onApprove(decision, r)
        close()
      }
    } else if (act === 'edit' && decision !== null) {
      const r = restatements[Number(target.dataset['restatement'])]
      const card = target.closest('.tour-restate')
      if (r !== undefined && card !== null) {
        card.outerHTML = restatementFormHtml(decision, r, { cancel: 'redraw' })
        dialog.querySelector('textarea')?.focus()
      }
    } else if (act === 'redraw') {
      render()
    } else if (act === 'reject') {
      const box = composer()
      if (box !== null) {
        box.value = 'No, that is not it: '
        box.focus()
      }
    } else if (act === 'reverse') {
      void send(REVERSE_QUIZ_MESSAGE)
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
      const box = composer()
      if (box !== null) {
        void send(box.value)
      }
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
      void send(target.value)
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

  /** The thread, read once per page; later turns are appended as they are sent. */
  const loadHistory = async () => {
    if (historyLoaded) {
      return
    }
    try {
      history = (await api.fetchGrillHistory(key)).turns
    } catch {
      history = []
    }
    historyLoaded = true
  }

  /**
   * True when the thread already holds a turn about this decision, so the opening is not sent
   * again.
   * @param {Decision} d
   */
  const grilledBefore = d =>
    history.some(t => t.role === 'user' && t.context?.kind === 'tour-decision' && t.context.key === d.key)

  return {
    /**
     * @param {Decision} d
     * @param {Restatement | undefined} draft the restatement approved before, when reopening
     */
    async open(d, draft) {
      decision = d
      context = { kind: 'tour-decision', key: d.key }
      if (!grillsWithChat(bundle)) {
        dialog.innerHTML = formGrillHtml(d, draft)
        dialog.showModal()
        dialog.querySelector('textarea')?.focus()
        return
      }
      render()
      dialog.showModal()
      await loadHistory()
      render()
      if (!grilledBefore(d)) {
        await send(openingMessage(d))
      }
    },
    /** The plan as the agent restates it, at the end of the tour. */
    async openPlan() {
      decision = null
      context = { kind: 'tour-plan' }
      render()
      dialog.showModal()
      await loadHistory()
      render()
      await send(PLAN_MESSAGE)
    },
    close,
    stop() {
      close()
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('submit', onSubmit)
      dialog.removeEventListener('keydown', onKeydown)
    },
  }
}
