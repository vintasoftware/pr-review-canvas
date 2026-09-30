// @ts-check
// The tour's screens as HTML: the header, the rail, the cover, a landmark, a decision, a question,
// the plan, and the footer nav. Everything built from data goes through esc().
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourPageTour} TourPageTour */
/** @typedef {import('../contract-types.js').TourPageLandmark} TourPageLandmark */
/** @typedef {import('../contract-types.js').Decision} Decision */
/** @typedef {import('../contract-types.js').QuizQuestion} QuizQuestion */
/** @typedef {import('../contract-types.js').CodeChunk} CodeChunk */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */
/** @typedef {import('../contract-types.js').ReaderPick} ReaderPick */
/** @typedef {import('../contract-types.js').Restatement} Restatement */
/** @typedef {import('./steps.js').Step} Step */
import { esc, timeAgo } from '../dom.js'
import { authorProfileUrl, currentHost } from '../host.js'
import { skinLabel } from '../skin.js'
import { themeLabel } from '../theme.js'
import {
  minutesOf,
  nextLabel,
  pickSettled,
  plural,
  positionLabel,
  reachable,
  settled,
  stepTitle,
} from './steps.js'

export const STAGE_LABEL = {
  background: 'Before this change',
  world: 'The world',
  why: 'Why',
  respect: 'What to respect',
}
export const CATEGORY_LABEL = {
  'trade-off': 'Trade-off',
  architecture: 'Architecture',
  product: 'Product and feel',
  pokayoke: 'Pokayoke',
  nfr: 'Non-functional',
  spec: 'Spec fidelity',
}
export const PLACE_LABEL = { code: 'code comment', pr: 'PR comment', lint: 'lint rule', tour: 'tour only' }

/**
 * Prose with `code` spans, the one bit of markup the generator's text carries.
 * @param {string} text
 */
export function inline(text) {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** The landmark that says what the change means; the cover leads with it. A tour has landmarks. */
/** @param {TourPageTour} tour */
export function worldLandmark(tour) {
  return /** @type {TourPageLandmark} */ (tour.landmarks.find(l => l.stage === 'world') ?? tour.landmarks[0])
}

/**
 * @param {TourBundle} bundle
 * @param {{ host: string, theme: import('../theme.js').Theme, skin: import('../skin.js').Skin, now: Date }} opts
 */
export function tourHeaderHtml(bundle, opts) {
  const { pr, tour } = bundle
  const local = bundle.local !== undefined
  const key = bundle.local ?? String(pr.number)
  const number = pr.number === null ? '' : `<span class="mono num">#${pr.number}</span>`
  const forgeLink =
    pr.url === ''
      ? ''
      : `<a class="cmd" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(currentHost().kind)}</a>`
  const author = local
    ? esc(pr.author)
    : `<a href="${esc(authorProfileUrl(pr.author))}" target="_blank" rel="noopener noreferrer">${esc(pr.author)}</a>`
  const agent = tour
    ? `<span class="pill agent" title="The agent, model, and harness that generated this tour">tour by ${esc(tour.generator.agent)}${tour.generator.model ? ` · ${esc(tour.generator.model)}` : ''} · ${esc(tour.generator.harness)}</span><span>generated ${esc(timeAgo(tour.generatedAt, opts.now))}</span>`
    : ''
  return (
    '<header class="hdr">' +
    `<div class="hdr-bar"><div class="brand"><span class="brand-wordmark"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</span><span class="mono muted">${esc(opts.host)}</span></div>` +
    '<div class="hdr-actions" role="group" aria-label="Tour actions">' +
    `<a class="cmd" id="canvas-link" href="/review/${esc(key)}" title="Open the review canvas of this change">canvas</a>` +
    '<button class="cmd" type="button" data-act="help" title="Show keyboard shortcuts and how a tour works" aria-haspopup="dialog">help</button>' +
    `<button class="cmd" type="button" id="skin-toggle" title="Switch between GitHub and Olive styling">${esc(skinLabel(opts.skin))}</button>` +
    `<button class="cmd" type="button" id="theme-toggle" title="Switch between Light, Dark, and Auto themes">${esc(themeLabel(opts.theme))}</button>` +
    '</div></div>' +
    '<div class="stripe" aria-hidden="true"></div>' +
    '<div class="hdr-title">' +
    `<div class="title"><h1><span class="tour-word">Tour</span> ${number}${esc(pr.title)}</h1>${forgeLink}</div>` +
    `<p class="meta"><span>by ${author}</span><span class="mono">${esc(pr.headRef)} &rarr; ${esc(pr.baseRef)}</span>` +
    `<span class="diffstat"><span class="ok">+${pr.additions}</span> <span class="bad">&minus;${pr.deletions}</span></span>${agent}</p>` +
    '</div></header>'
  )
}

/**
 * @param {Step[]} steps
 * @param {number} current
 * @param {TourReaderState} reader
 * @param {TourPageTour} tour
 * @param {{ preview?: boolean }} [opts] a preview opens every step
 */
export function railHtml(steps, current, reader, tour, opts = {}) {
  const q = steps.filter(s => s.kind === 'quiz').length
  /** @type {Array<{ kind: Step['kind'], label: string }>} */
  const groups = [
    { kind: 'cover', label: '' },
    { kind: 'landmark', label: plural(tour.landmarks.length, 'landmark') },
    { kind: 'decision', label: plural(tour.decisions.length, 'decision') },
    ...(q === 0 ? [] : [{ kind: /** @type {const} */ ('quiz'), label: plural(q, 'question') }]),
    { kind: 'plan', label: '' },
  ]
  return `<nav class="tour-rail" aria-label="Tour progress">${groups
    .map(g => {
      let segs = ''
      for (const [i, step] of steps.entries()) {
        if (step.kind !== g.kind) {
          continue
        }
        // A landmark ahead is open, not done: only an answered decision or question is done early.
        const answered = (step.kind === 'decision' || step.kind === 'quiz') && settled(step, reader)
        const state =
          i === current
            ? 'current'
            : i < current || answered
              ? 'done'
              : opts.preview === true || reachable(steps, i, reader)
                ? 'open'
                : 'ahead'
        const title = esc(stepTitle(step))
        segs += `<button class="tour-rail-seg" type="button" data-step="${i}" data-state="${state}" title="${title}" aria-label="${title}"${state === 'ahead' ? ' disabled' : ''}></button>`
      }
      const kind = g.kind === 'landmark' ? 'landmarks' : g.kind === 'decision' ? 'decisions' : g.kind
      return `<div class="tour-rail-group" data-kind="${kind}"><span class="tour-rail-label">${esc(g.label)}</span><div class="tour-rail-segs">${segs}</div></div>`
    })
    .join('')}</nav>`
}

/**
 * @param {Step[]} steps
 * @param {number} i
 * @param {TourReaderState} reader
 */
export function navHtml(steps, i, reader) {
  const step = steps[i]
  const canNext = step !== undefined && i < steps.length - 1 && settled(step, reader)
  return `<div class="tour-nav-inner">
    <button class="tour-btn quiet" type="button" data-nav="prev"${i === 0 ? ' disabled' : ''}>← back</button>
    <span class="tour-nav-pos">${esc(positionLabel(steps, i))}</span>
    <button class="tour-btn${canNext ? ' accent' : ''}" type="button" data-nav="next"${canNext ? '' : ' disabled'}>${esc(nextLabel(steps, i))} →</button>
  </div>`
}

/** @param {TourBundle} bundle */
export function coverHtml(bundle) {
  const { pr } = bundle
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const world = worldLandmark(tour)
  const guide =
    tour.guide === null
      ? '<span>no guide on file</span>'
      : `<span>guide: <span class="mono">${esc(tour.guide)}</span></span>`
  const blast =
    tour.blastRadius.length === 0 ? '' : `<span>touches: ${tour.blastRadius.map(esc).join(', ')}</span>`
  const link =
    pr.url === ''
      ? `${esc(pr.headRef)}`
      : `<a href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">#${pr.number}</a>`
  return `
    <p class="tour-eyebrow"><span class="tour-stage-tag">Tour</span><span>${link} · ${esc(tour.repo.owner)}/${esc(tour.repo.name)}</span></p>
    <h1 class="tour-title">${esc(pr.title)}</h1>
    <p class="tour-cover-meta"><span>by ${esc(pr.author)}</span><span class="mono">${esc(pr.headRef)} → ${esc(pr.baseRef)}</span><span><span class="ok">+${pr.additions}</span> <span class="bad">−${pr.deletions}</span> in ${plural(pr.changedFiles, 'file')}</span>${guide}${blast}</p>
    <p class="tour-lead">${inline(world.lead)}</p>
    <div class="tour-budget">
      <div><b>${tour.landmarks.length}</b><span>landmarks</span></div>
      <div><b>${tour.decisions.length}</b><span>decisions</span></div>
      <div><b>${bundle.options.finalQuiz === 'off' ? 0 : tour.quiz.length}</b><span>questions</span></div>
      <div><b>~${minutesOf(tour)}</b><span>minutes</span></div>
    </div>
    ${bundle.reader.finished ? '<p class="tour-hint">You finished this tour. Read it again, or open the plan.</p>' : ''}
    <div class="tour-cover-actions">
      <button class="tour-btn accent" type="button" data-nav="next">${bundle.reader.step > 0 ? 'Continue the tour' : 'Start the tour'}</button>
      <span class="tour-hint"><kbd>→</kbd> next · <kbd>←</kbd> back · <kbd>i</kbd> code · <kbd>?</kbd> help</span>
    </div>`
}

/**
 * The way back after a jump: from a question that reopened a landmark, or from a landmark's chip.
 * @param {Step[]} steps
 * @param {TourPageTour} tour
 * @param {number | null} from
 */
export function returnBannerHtml(steps, tour, from) {
  const origin = from === null ? undefined : steps[from]
  if (origin === undefined) {
    return ''
  }
  const [text, label] =
    origin.kind === 'quiz'
      ? ['Reopened from the quiz. Read again, then go back.', 'back to the question']
      : origin.kind === 'landmark'
        ? [
            `Jumped from landmark ${tour.landmarks.indexOf(origin.landmark) + 1}. Decide now, or go back and keep reading.`,
            'back to the landmark',
          ]
        : ['Jumped from a decision.', 'back to the decision']
  return `<div class="tour-return"><span>${esc(text)}</span><button class="tour-btn" type="button" data-act="return">${esc(label)}</button></div>`
}

/**
 * @param {TourBundle} bundle
 * @param {Step[]} steps
 * @param {TourPageLandmark} landmark
 */
export function landmarkHtml(bundle, steps, landmark) {
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const reader = bundle.reader
  const n = tour.landmarks.indexOf(landmark) + 1
  const decisionsHere = tour.decisions.filter(d => d.landmark === landmark.id)
  const codeOpen = reader.codeOpen[landmark.id] === true
  const hasLiterate = landmark.literate.length > 0
  const codeView = hasLiterate ? (reader.codeView[landmark.id] ?? 'literate') : 'raw'
  const note = reader.notes[landmark.id] ?? ''
  const frame = (/** @type {'scene' | 'micro'} */ kind) =>
    `<div class="tour-card tour-${kind}"><div class="tour-card-h"><span>${kind === 'scene' ? 'scene' : 'micro-world'}</span>${kind === 'micro' ? '<span>interactive</span>' : ''}</div><div class="tour-frame-host" data-landmark="${esc(landmark.id)}" data-kind="${kind}"></div></div>`
  const guards =
    landmark.guards.length === 0
      ? ''
      : `<div class="tour-guards"><span class="tour-guards-h">guarded by</span>${landmark.guards
          .map(
            g =>
              `<span class="tour-guard" title="${esc(g.behavior)}"><span class="mono">${esc(g.testPath)}</span> ${esc(g.behavior)}</span>`
          )
          .join('')}</div>`
  const chips =
    decisionsHere.length === 0
      ? ''
      : `<div class="tour-chips"><span class="tour-chip">${decisionsHere.length === 1 ? 'one decision waits here' : `${decisionsHere.length} decisions wait here`}</span>${decisionsHere
          .map(
            d =>
              `<button class="tour-chip link" type="button" data-cat="${esc(d.category)}" data-act="jump" data-decision="${esc(d.key)}" title="Jump to this decision now">${esc(d.title)} →</button>`
          )
          .join('')}</div>`
  const code =
    landmark.code.length === 0
      ? ''
      : `<div class="tour-actions"><button class="tour-btn quiet" type="button" data-act="code">${codeOpen ? 'hide code' : 'code behind this landmark'} <kbd>i</kbd></button></div>
         <div class="tour-code"${codeOpen ? '' : ' hidden'}>
           ${
             hasLiterate
               ? `<div class="tour-code-tabs" role="tablist">
                    <button class="tour-code-tab" type="button" role="tab" aria-selected="${codeView === 'literate'}" data-act="code-view" data-view="literate">literate diff</button>
                    <button class="tour-code-tab" type="button" role="tab" aria-selected="${codeView === 'raw'}" data-act="code-view" data-view="raw">raw diff</button>
                  </div>`
               : ''
           }
           ${codeView === 'literate' ? literateHtml(landmark) : landmark.code.map(chunkHtml).join('')}
         </div>`
  return `
    ${returnBannerHtml(steps, tour, reader.returnTo)}
    <p class="tour-eyebrow"><span class="tour-stage-tag">${esc(STAGE_LABEL[landmark.stage])}</span><span>landmark ${n} of ${tour.landmarks.length}</span>${landmark.state ? '<span class="tour-state-tag">state landmark</span>' : ''}</p>
    <h2 class="tour-title">${esc(landmark.title)}</h2>
    <p class="tour-lead">${inline(landmark.lead)}</p>
    <div class="tour-body">${landmark.body.map(p => `<p>${inline(p)}</p>`).join('')}</div>
    ${landmark.scene ? frame('scene') : ''}
    ${landmark.micro ? frame('micro') : ''}
    ${guards}
    ${chips}
    <div class="tour-note"><label for="note-${esc(landmark.id)}">Something I noticed <span class="tour-hint">optional</span></label><textarea id="note-${esc(landmark.id)}" data-act="note" data-landmark="${esc(landmark.id)}" rows="2" placeholder="A thought while reading, so you do not have to hold it until the decisions">${esc(note)}</textarea></div>
    ${code}`
}

/**
 * The literate diff: prose in reading order, with the chunks embedded where they belong.
 * @param {TourPageLandmark} landmark
 */
export function literateHtml(landmark) {
  return `<div class="tour-literate">${landmark.literate
    .map(block => {
      if (typeof block === 'string') {
        return `<p>${inline(block)}</p>`
      }
      const chunk = 'chunk' in block ? landmark.code[block.chunk] : block
      return chunk === undefined ? '' : chunkHtml(chunk)
    })
    .join('')}</div>`
}

/** @param {CodeChunk} chunk */
export function chunkHtml(chunk) {
  const lines = chunk.diff.split('\n').map(line => {
    const cls = line.startsWith('+')
      ? 'add'
      : line.startsWith('-')
        ? 'del'
        : line.startsWith('@@')
          ? 'hunk'
          : ''
    return `<div${cls === '' ? '' : ` class="${cls}"`}>${esc(line) || ' '}</div>`
  })
  return `<div class="tour-code-file">${esc(chunk.path)}</div><div class="tour-diff">${lines.join('')}</div>`
}

/**
 * @param {TourBundle} bundle
 * @param {Step[]} steps
 * @param {Decision} d
 */
export function decisionHtml(bundle, steps, d) {
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const reader = bundle.reader
  const n = tour.decisions.indexOf(d) + 1
  const landmark = tour.landmarks.find(l => l.id === d.landmark)
  const landmarkIndex = landmark === undefined ? 0 : tour.landmarks.indexOf(landmark) + 1
  const p = reader.picks[d.key] ?? { pick: d.recommended, approved: false, place: d.reason.place }
  const done = pickSettled(p)
  const note = (reader.notes[d.landmark] ?? '').trim()
  const place = p.place ?? d.reason.place
  const from =
    landmark === undefined
      ? ''
      : `<a href="#landmark-${esc(landmark.id)}" data-act="landmark" data-landmark="${esc(landmark.id)}">from landmark ${landmarkIndex}: ${esc(landmark.title)}</a>`
  const reason =
    p.pick === 'keep'
      ? `<div class="tour-reason"><div>Reason recorded, in your words: <q>${inline(d.reason.text)}</q></div>
         <label>belongs <select data-act="place">${Object.entries(PLACE_LABEL)
           .map(([k, v]) => `<option value="${k}"${place === k ? ' selected' : ''}>${v}</option>`)
           .join('')}</select></label></div>`
      : ''
  const tryIt = d.tryIt
    ? `<div class="tour-card tour-tryit"><div class="tour-card-h"><span>try it${d.tryIt.verified ? ' · verified when this tour was generated' : ''}</span></div>
       <ol>${d.tryIt.steps.map(s => `<li><code>${esc(s)}</code></li>`).join('')}</ol>
       <ul>${d.tryIt.look.map(s => `<li>${inline(s)}</li>`).join('')}</ul>
       <label><input type="checkbox" data-act="tried"${p.tried ? ' checked' : ''}> I tried it</label></div>`
    : ''
  const actions = done
    ? p.pick === 'keep'
      ? `<span class="tour-state">✓ kept · reason ${esc(PLACE_LABEL[place])}</span><button class="tour-btn quiet" type="button" data-act="unsettle">change my mind</button>`
      : `<span class="tour-state change">✓ change approved · in the plan</span><button class="tour-btn quiet" type="button" data-act="grill">reopen</button><button class="tour-btn quiet" type="button" data-act="unsettle">change my mind</button>`
    : p.pick === 'keep'
      ? `<button class="tour-btn accent" type="button" data-act="keep">Keep it <kbd>k</kbd></button>`
      : `<button class="tour-btn accent" type="button" data-act="grill">Say what you want instead <kbd>c</kbd></button>`
  return `
    ${returnBannerHtml(steps, tour, reader.returnTo)}
    <p class="tour-eyebrow"><span class="tour-stage-tag">${esc(CATEGORY_LABEL[d.category] ?? d.category)}</span><span>decision ${n} of ${tour.decisions.length}</span>${from}</p>
    <h2 class="tour-title">${esc(d.title)}</h2>
    <p class="tour-lead">${inline(d.context)}</p>
    <p class="tour-anchor"><span class="mono">${esc(d.anchor.path)}:${d.anchor.line}</span></p>
    ${note === '' ? '' : `<div class="tour-landmark-note"><b>Your note on landmark ${landmarkIndex}</b>${esc(note)}</div>`}
    <div class="tour-options" role="radiogroup" aria-label="Keep or change">
      ${optionHtml('keep', d.keep, p.pick === 'keep', true, d.recommended === 'keep')}
      ${optionHtml('change', d.change, p.pick === 'change', false, d.recommended === 'change')}
    </div>
    ${reason}
    ${tryIt}
    <div class="tour-actions">${actions}</div>
    ${done && p.pick === 'change' && p.restatement ? restatedHtml(p.restatement) : ''}`
}

/**
 * @param {'keep' | 'change'} kind
 * @param {{ label: string, consequence: string }} side
 * @param {boolean} checked
 * @param {boolean} isNow
 * @param {boolean} isRecommended
 */
function optionHtml(kind, side, checked, isNow, isRecommended) {
  return `<button class="tour-option" type="button" role="radio" aria-checked="${checked}" data-act="pick" data-pick="${kind}">
    <span class="tour-option-k"><span>${kind}</span>${isNow ? '<span class="now">what the code does</span>' : ''}${isRecommended ? '<span class="rec">recommended</span>' : ''}</span>
    <span class="tour-option-l">${esc(side.label)}</span>
    <span class="tour-option-c">${inline(side.consequence)}</span></button>`
}

/** @param {Restatement} r */
export function restatedHtml(r) {
  return `<div class="tour-restated"><b>What changes</b>${inline(r.what)}<b>Where</b>${r.where.map(esc).join(', ')}<b>Stays the same</b>${inline(r.unchanged)}</div>`
}

/**
 * @param {TourBundle} bundle
 * @param {QuizQuestion} q
 */
export function quizHtml(bundle, q) {
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const a = bundle.reader.quiz[q.id]
  const n = tour.quiz.indexOf(q) + 1
  const landmark = tour.landmarks.find(l => l.id === q.landmark)
  const landmarkIndex = landmark === undefined ? 0 : tour.landmarks.indexOf(landmark) + 1
  const reopen =
    landmark === undefined
      ? ''
      : `<button class="tour-btn" type="button" data-act="reopen" data-landmark="${esc(landmark.id)}">reopen landmark ${landmarkIndex}: ${esc(landmark.title)}</button><span class="tour-hint">then answer again</span>`
  const after = a
    ? a.right
      ? `<div class="tour-quiz-why right">${inline(q.why)}</div>`
      : `<div class="tour-quiz-why wrong">Not quite. ${inline(q.why)}<div class="tour-actions">${reopen}</div></div>`
    : '<p class="tour-hint tour-quiz-hint">press <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> to answer · a wrong answer reopens the landmark it came from</p>'
  return `
    <p class="tour-eyebrow"><span class="tour-stage-tag">Quiz</span><span>question ${n} of ${tour.quiz.length}</span><span>private · stays on this machine</span></p>
    <h2 class="tour-quiz-q">${inline(q.question)}</h2>
    <div class="tour-quiz-opts">${q.options
      .map((o, i) => {
        const result = a && a.answered === i ? (a.right ? 'right' : 'wrong') : ''
        return `<button class="tour-quiz-opt" type="button" data-act="answer" data-i="${i}" data-n="${i + 1}"${result === '' ? '' : ` data-result="${result}"`}${a?.right ? ' disabled' : ''}>${inline(o)}</button>`
      })
      .join('')}</div>
    ${after}`
}

/** @param {TourBundle} bundle */
export function planHtml(bundle) {
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const reader = bundle.reader
  const entries = tour.decisions
    .map(d => ({ d, p: reader.picks[d.key] }))
    .filter(e => pickSettled(e.p))
    .map(e => ({ d: e.d, p: /** @type {ReaderPick} */ (e.p) }))
  // A settled change has its restatement: that is what settled it.
  const changes = entries
    .filter(e => e.p.pick === 'change')
    .map(e => ({ d: e.d, r: /** @type {Restatement} */ (e.p.restatement) }))
  const kept = entries.filter(e => e.p.pick === 'keep')
  const notes = tour.landmarks
    .map(l => ({ l, text: (reader.notes[l.id] ?? '').trim() }))
    .filter(n => n.text !== '')
  const right = tour.quiz.filter(q => reader.quiz[q.id]?.right).length
  const finished = reader.finished
  const title = changes.length
    ? `${plural(changes.length, 'change')} to make, ${kept.length} kept`
    : `Nothing to change. ${plural(kept.length, 'decision')} kept.`
  const lead = changes.length
    ? `Read it once. When you confirm, the prompt is written${bundle.shares ? ' and the record is shared' : ''}. No further plan review.`
    : `Your reasons are recorded. When you confirm, ${bundle.shares ? 'the record is shared and ' : ''}the prompt carries the intent and the kept decisions for whoever touches this next.`
  const done = finished
    ? `<h3 class="tour-section-h">Done</h3><ul class="tour-sharing">
         ${sharingLine(finished.sharing)}
         ${finished.posted === undefined ? '' : `<li>${finished.posted === 0 ? 'No kept reason belonged on the pull request this time.' : `${plural(finished.posted, 'kept reason')} posted as ${finished.posted === 1 ? 'a comment' : 'comments'} on ${finished.posted === 1 ? 'its line' : 'their lines'}.`}</li>`}
         ${finished.queued === undefined ? '' : `<li>${finished.queued === 0 ? 'Nothing new for your pending review.' : `${plural(finished.queued, 'change request')} added to your pending review; it goes out with your verdict.`}</li>`}
         ${(finished.warnings ?? []).map(w => `<li class="failed">${esc(w)}</li>`).join('')}
         ${bundle.options.finalQuiz === 'off' ? '' : `<li class="private">Quiz ${right} of ${tour.quiz.length}, kept on this machine.</li>`}
         <li>Prompt written to <span class="mono">${esc(finished.promptPath)}</span>. Run <code>/pr-tour-apply ${esc(bundle.local ?? String(tour.pr.number))}</code> to implement it.</li>
       </ul>
       <h3 class="tour-section-h">Re-implementation prompt</h3>
       <div class="tour-prompt"><div class="tour-actions"><button class="tour-btn" type="button" data-act="copy">copy</button></div><pre id="prompt">${esc(finished.prompt)}</pre></div>`
    : bundle.preview
      ? '<div class="tour-actions"><span class="tour-hint">A preview is not finished: publish the tour first.</span></div>'
      : `<div class="tour-actions"><button class="tour-btn accent" type="button" data-act="confirm">Confirm the plan</button><span class="tour-hint">writes the prompt${bundle.shares ? ', shares the record' : ''}</span>${
          bundle.chat.enabled && bundle.options.grill !== 'off'
            ? '<button class="tour-btn quiet" type="button" data-act="grill-plan">Restate the plan with the agent</button>'
            : ''
        }</div>`
  return `
    <p class="tour-eyebrow"><span class="tour-stage-tag">The plan</span></p>
    <h2 class="tour-title">${esc(title)}</h2>
    <p class="tour-lead">${esc(lead)}</p>
    ${changes.length ? `<h3 class="tour-section-h">Changes</h3><ol class="tour-plan-list">${changes.map(({ d, r }) => `<li><b>${esc(d.title)}</b><br>${inline(r.what)} <span class="where">${r.where.map(esc).join(' · ')}</span><span class="where">stays: ${inline(r.unchanged)}</span></li>`).join('')}</ol>` : ''}
    ${notes.length ? `<h3 class="tour-section-h">Your notes while reading</h3><ul class="tour-kept">${notes.map(({ l, text }) => `<li><span>landmark ${tour.landmarks.indexOf(l) + 1}</span><span>${esc(text)}</span><span class="place">${esc(l.title)}</span></li>`).join('')}</ul>` : ''}
    <h3 class="tour-section-h">Kept, with reasons</h3>
    <ul class="tour-kept">${kept.map(({ d, p }) => `<li><span>${esc(d.keep.label)}</span><span><q>${inline(d.reason.text)}</q></span><span class="place">${esc(PLACE_LABEL[p.place ?? d.reason.place])}</span></li>`).join('') || '<li>none</li>'}</ul>
    ${done}
    ${tour.notToured.length ? `<h3 class="tour-section-h">Not toured</h3><ul class="tour-not">${tour.notToured.map(n => `<li><span>${esc(n.title)}</span><span class="path">${esc(n.path)}</span></li>`).join('')}</ul>` : ''}`
}

/** @param {import('../contract-types.js').TourSharing} sharing */
function sharingLine(sharing) {
  if (sharing.status === 'shared') {
    return `<li>Record shared on the pull request: <a href="${esc(sharing.url)}" target="_blank" rel="noopener noreferrer">the tour comment</a>, updated once.</li>`
  }
  if (sharing.status === 'failed') {
    return `<li class="failed">Sharing failed: ${esc(sharing.warning)} The zip is at <span class="mono">${esc(sharing.zipPath)}</span>.</li>`
  }
  if (sharing.status === 'off') {
    return '<li class="private">Sharing is off for this project: the record stays here.</li>'
  }
  return '<li class="private">A local review: the record stays on this machine.</li>'
}

/** @param {TourBundle} bundle */
export function missingHtml(bundle) {
  const what = bundle.local === undefined ? 'this pull request' : 'this local work'
  return `<section class="panel tour-missing" aria-labelledby="missing-h"><div class="panel-h"><h2 id="missing-h">No tour yet for ${what}</h2></div>
    <div class="body"><p>Run the tour skill in your agent, then this page draws it:</p>
    <p><code class="tour-cmd">${esc(bundle.skillCommand)}</code> <button class="cmd" type="button" data-copy="${esc(bundle.skillCommand)}">copy</button></p>
    <p class="muted">This page checks again every few seconds.</p></div></section>`
}

/**
 * @param {TourBundle} bundle
 */
export function staleBarHtml(bundle) {
  const stale = bundle.stale
  if (stale === undefined) {
    return ''
  }
  const behind =
    stale.relation === 'ancestor'
      ? `${plural(stale.commitsBehind ?? 0, 'commit')} behind`
      : 'on a commit the head does not contain'
  return `<div class="tour-stale" role="status">This tour is of <span class="mono">${esc(stale.tourHeadSha.slice(0, 7))}</span>, ${esc(behind)} the head <span class="mono">${esc(stale.currentHeadSha.slice(0, 7))}</span>. Run <code>${esc(bundle.skillCommand)}</code> for a tour of the current commit; picks carry by decision key.</div>`
}

export function helpHtml() {
  return `<h3>Keys</h3><dl>
    <dt><kbd>→</kbd> <kbd>space</kbd></dt><dd>next</dd>
    <dt><kbd>←</kbd></dt><dd>back</dd>
    <dt><kbd>i</kbd></dt><dd>show the code behind a landmark</dd>
    <dt><kbd>k</kbd> <kbd>c</kbd></dt><dd>keep, or say what you want instead</dd>
    <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt><dd>answer a question</dd>
    <dt><kbd>esc</kbd></dt><dd>close this, or the drawer</dd>
  </dl>
  <p>A tour has landmarks that explain the change, decisions you keep or change, and a quiz. The browser's back and forward buttons move through it, and a reload lands where you were.</p>
  <div class="tour-actions"><button class="tour-btn" type="button" data-act="close-help">close</button></div>`
}
