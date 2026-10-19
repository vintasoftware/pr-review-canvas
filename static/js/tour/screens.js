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
/** @typedef {(chunk: CodeChunk) => string | null} FileLink where a chunk's file opens on the forge */
import { esc, timeAgo } from '../dom.js'
import { dropZoneHtml } from '../empty-state.js'
import { GENERATE_BUTTON_ID, tourGenerationMode } from '../generate.js'
import { authorProfileUrl, currentHost, fileUrl } from '../host.js'
import { headerBarHtml } from '../header-bar.js'
import {
  minutesOf,
  nextLabel,
  chosenPick,
  pickSettled,
  planChanged,
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

/** Code no longer than this stays on one line; longer code wraps, so it never overflows a phone. */
const NOWRAP_CODE_MAX = 40

/**
 * Escaped text whose command-line flags stay whole: a line may break after a hyphen, so `--json`
 * would end one line with `--`.
 * @param {string} html escaped already
 */
function keepFlags(html) {
  return html.replace(/(^|[\s(])(--?[A-Za-z][\w-]*)/g, '$1<span class="nw">$2</span>')
}

/**
 * Plain text from the generator, escaped, with its flags kept whole: titles and labels.
 * @param {string} text
 */
export function plain(text) {
  return keepFlags(esc(text))
}

/**
 * Prose with `code` spans, the one bit of markup the generator's text carries. A short span stays
 * on one line, so `<pr-file>` is not cut after its hyphen.
 * @param {string} text
 */
export function inline(text) {
  return esc(text)
    .split(/`([^`]+)`/)
    .map((part, i) =>
      i % 2 === 1
        ? `<code${part.length <= NOWRAP_CODE_MAX ? ' class="nw"' : ''}>${part}</code>`
        : keepFlags(part)
    )
    .join('')
}

/**
 * The header's skyline: a row of buildings, the road, and the tour bus parked on it. Drawn with
 * classes, so the tour's tokens paint it in both themes.
 */
const SKYLINE_HTML = `<svg class="tour-skyline" viewBox="0 0 1200 124" preserveAspectRatio="xMaxYMax slice" aria-hidden="true" focusable="false">
<g class="tour-sky-city"><path d="M0 124V74h40V54h30v20h20V34h12V14h4v20h12v40h30V59h50v65Z"/><path d="M260 124V64l40-30 40 30v60Z"/><path d="M360 124V44h20V24h10v20h20v80Z"/><path d="M440 124V79q40-50 80 0v45Z"/><path d="M560 124V54h60v70Z"/><path d="M585 54V26h10v28Z"/><path d="M660 124V69h30V39h20v30h40v55Z"/><path d="M800 124V84l30-50 30 50v40Z"/><path d="M900 124V49h50v75Z"/><path d="M960 124V74h70v50Z"/><path d="M1060 124V59h20V34l10-10 10 10v25h20v65Z"/><path d="M1140 124V79h60v45Z"/></g>
<g class="tour-sky-cloud"><circle cx="150" cy="40" r="20"/><circle cx="1000" cy="30" r="14"/></g>
<rect class="tour-sky-road" y="106" width="1200" height="18"/><rect class="tour-sky-lane" y="114" width="1200" height="2"/>
<g transform="translate(860 52)"><rect class="tour-bus-body" width="134" height="56" rx="10"/><rect class="tour-bus-band" y="25" width="134" height="5"/>
<g class="tour-bus-glass"><rect x="10" y="6" width="20" height="14" rx="3"/><rect x="36" y="6" width="20" height="14" rx="3"/><rect x="62" y="6" width="20" height="14" rx="3"/><rect x="88" y="6" width="20" height="14" rx="3"/><rect x="114" y="6" width="12" height="14" rx="3"/><rect x="10" y="34" width="20" height="12" rx="3"/><rect x="36" y="34" width="20" height="12" rx="3"/><rect x="62" y="34" width="20" height="12" rx="3"/><rect x="102" y="34" width="14" height="20" rx="3"/></g>
<g class="tour-bus-wheel"><circle cx="30" cy="58" r="9"/><circle cx="104" cy="58" r="9"/></g><g class="tour-sky-road"><circle cx="30" cy="58" r="3.5"/><circle cx="104" cy="58" r="3.5"/></g></g>
</svg>`

/** GitHub's link-external octicon. */
const EXTERNAL_ICON =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.75 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-3.5a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5C2 2.784 2.784 2 3.75 2Zm6.854-1h4.146a.25.25 0 0 1 .25.25v4.146a.25.25 0 0 1-.427.177L13.03 4.03 9.28 7.78a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042l3.75-3.75-1.543-1.543A.25.25 0 0 1 10.604 1Z"/></svg>'

/**
 * @param {TourBundle} bundle
 * @param {{ host: string, theme: import('../theme.js').Theme, now: Date, project?: import('../header-bar.js').ProjectLink | undefined }} opts
 *   The wordmark links to the project list, the project to its home, and canvas to the review.
 *   The tour has a look of its own, so the header offers the theme command and no skin.
 */
export function tourHeaderHtml(bundle, opts) {
  const { pr, tour } = bundle
  const local = bundle.local !== undefined
  const key = bundle.local ?? String(pr.number)
  const number = pr.number === null ? '' : `<span class="mono num">#${pr.number}</span>`
  // The change on its forge, opened in a new tab: an icon that says "another site".
  const forgeName = `Open ${pr.number === null ? 'it' : `#${pr.number}`} on ${currentHost().label}`
  const forgeLink =
    pr.url === ''
      ? ''
      : `<a class="tour-forge" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer" title="${esc(forgeName)}" aria-label="${esc(forgeName)}">${EXTERNAL_ICON}</a>`
  const author = local
    ? esc(pr.author)
    : `<a href="${esc(authorProfileUrl(pr.author))}" target="_blank" rel="noopener noreferrer">${esc(pr.author)}</a>`
  const agent = tour
    ? `<span class="pill agent" title="The agent, model, and harness that generated this tour">tour by ${esc(tour.generator.agent)}${tour.generator.model ? ` · ${esc(tour.generator.model)}` : ''} · ${esc(tour.generator.harness)}</span><span>generated ${esc(timeAgo(tour.generatedAt, opts.now))}</span>`
    : ''
  return (
    '<header class="hdr">' +
    headerBarHtml(
      opts,
      `<a class="cmd" id="canvas-link" href="${esc(opts.project?.home ?? '/')}review/${esc(key)}" title="Open the review canvas of this change">canvas</a>` +
        generateButtonHtml(bundle) +
        (tour === undefined || bundle.preview
          ? ''
          : `<button class="cmd" type="button" id="export-zip" title="Download this tour as a zip to share on ${esc(currentHost().label)}">export zip</button>`) +
        '<button class="cmd" type="button" data-act="help" title="Show keyboard shortcuts and how a tour works" aria-haspopup="dialog">help</button>'
    ) +
    '<div class="hdr-title">' +
    `<div class="title"><h1><span class="tour-word">Tour</span> ${esc(pr.title)}${number === '' ? '' : ` ${number}`}${forgeLink}</h1></div>` +
    `<p class="meta"><span>by ${author}</span><span class="mono">${esc(pr.headRef)} &rarr; ${esc(pr.baseRef)}</span>` +
    `<span class="diffstat"><span class="ok">+${pr.additions}</span> <span class="bad">&minus;${pr.deletions}</span></span>${agent}</p>` +
    `</div>${SKYLINE_HTML}</header>`
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
    { kind: 'cover', label: 'start' },
    { kind: 'landmark', label: plural(tour.landmarks.length, 'landmark') },
    { kind: 'decision', label: plural(tour.decisions.length, 'decision') },
    ...(q === 0 ? [] : [{ kind: /** @type {const} */ ('quiz'), label: plural(q, 'question') }]),
    { kind: 'plan', label: 'plan' },
  ]
  const nav = `<nav class="tour-rail" aria-label="Tour progress">${groups
    .map(g => {
      let segs = ''
      let n = 0
      for (const [i, step] of steps.entries()) {
        if (step.kind !== g.kind) {
          continue
        }
        n += 1
        const state =
          i === current
            ? 'current'
            : stepDone(step, i, current, reader, tour)
              ? 'done'
              : opts.preview === true || reachable(steps, i, reader)
                ? 'open'
                : 'ahead'
        // A tooltip shows text as it is, so the backticks that mark code in prose go.
        const title = esc(stepTitle(step).replaceAll('`', ''))
        // The sign on the stop: a check once visited, else what kind of stop it is.
        const sign = state === 'done' ? '✓' : STOP_SIGN[step.kind] || String(n)
        segs += `<button class="tour-rail-seg" type="button" data-step="${i}" data-state="${state}" title="${title}" aria-label="${title}"${state === 'current' ? ' aria-current="step"' : ''}${state === 'ahead' ? ' disabled' : ''}><span aria-hidden="true">${sign}</span></button>`
      }
      const kind = g.kind === 'landmark' ? 'landmarks' : g.kind === 'decision' ? 'decisions' : g.kind
      return `<div class="tour-rail-group" data-kind="${kind}"><span class="tour-rail-label">${esc(g.label)}</span><div class="tour-rail-segs">${segs}</div></div>`
    })
    .join('')}</nav>`
  // The legend repeats what each stop's label says, so screen readers skip it.
  const legend =
    '<div class="tour-rail-legend" aria-hidden="true"><span><i data-state="done"></i>visited</span><span><i data-state="current"></i>the bus is here</span><span><i data-state="open"></i>hop on any time</span><span><i data-state="ahead"></i>later on the route</span></div>'
  return nav + legend
}

/** The sign on a stop that is not visited yet; a landmark's is its number. */
const STOP_SIGN = { cover: '▸', landmark: '', decision: 'D', quiz: '?', plan: '★' }

/**
 * The ticket's strip over each screen: which stop this is on the route, what it is about, and a
 * barcode for decoration. The page tints the strip by the kind of step.
 * @param {TourBundle} bundle
 * @param {Step[]} steps
 * @param {number} i
 */
export function stripHtml(bundle, steps, i) {
  const tour = bundle.tour
  const step = steps[i]
  const route = bundle.pr.number === null ? 'local' : String(bundle.pr.number)
  /** @type {[string, string, string, string]} label, number, of, what */
  const [label, number, of, what] =
    tour === undefined || step === undefined
      ? ['route', route, '', 'No tour yet']
      : step.kind === 'cover'
        ? ['route', route, '', `${plural(steps.length, 'stop')} · about ${minutesOf(tour)} minutes`]
        : step.kind === 'landmark'
          ? [
              'stop',
              String(tour.landmarks.indexOf(step.landmark) + 1),
              `of ${tour.landmarks.length}`,
              `${STAGE_LABEL[step.landmark.stage]} · ${step.landmark.title}`,
            ]
          : step.kind === 'decision'
            ? [
                'choice',
                String(tour.decisions.indexOf(step.decision) + 1),
                `of ${tour.decisions.length}`,
                decisionWhere(tour, step.decision),
              ]
            : step.kind === 'quiz'
              ? [
                  'quiz',
                  String(tour.quiz.indexOf(step.q) + 1),
                  `of ${tour.quiz.length}`,
                  'Private · stays on this machine',
                ]
              : ['last stop', '★', '', `The plan · ${planCount(bundle)}`]
  return `<span class="tour-strip-no"><small>${label}</small><b>${esc(number)}</b>${of === '' ? '' : `<small>${of}</small>`}</span><span class="tour-strip-what">${plain(what.replaceAll('`', ''))}</span><span class="tour-strip-code" aria-hidden="true"></span>`
}

/**
 * @param {TourPageTour} tour
 * @param {Decision} d
 */
function decisionWhere(tour, d) {
  const category = CATEGORY_LABEL[d.category] ?? d.category
  const n = tour.landmarks.findIndex(l => l.id === d.landmark) + 1
  return n === 0 ? category : `${category} · from landmark ${n}`
}

/**
 * How the plan stands, in a few words: the changes to make and the decisions kept.
 * @param {TourBundle} bundle
 */
function planCount(bundle) {
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  const picks = tour.decisions.map(d => bundle.reader.picks[d.key]).filter(p => pickSettled(p))
  const kept = picks.filter(p => p?.pick === 'keep').length
  return `${plural(picks.length - kept, 'change')}, ${kept} kept`
}

/**
 * Done means done, not passed: a landmark the reader had on screen, a settled decision, a question
 * answered right, the cover once left, and a plan confirmed as it stands. A jump past a landmark
 * leaves it open, and a decision taken back is open again.
 * @param {Step} step
 * @param {number} i
 * @param {number} current
 * @param {TourReaderState} reader
 * @param {TourPageTour} tour
 */
function stepDone(step, i, current, reader, tour) {
  if (step.kind === 'cover') {
    return i < current
  }
  if (step.kind === 'landmark') {
    return reader.seen[step.landmark.id] === true
  }
  if (step.kind === 'plan') {
    return reader.finished !== undefined && !planChanged(tour, reader)
  }
  return settled(step, reader)
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
    <button class="cmd" type="button" data-nav="prev"${i === 0 ? ' disabled' : ''}>← back</button>
    <span class="tour-nav-pos">${esc(positionLabel(steps, i))}</span>
    <button class="cmd${canNext ? ' fill' : ''}" type="button" data-nav="next"${canNext ? '' : ' disabled'}>${esc(nextLabel(steps, i))} →</button>
  </div>`
}

/** @param {TourBundle} bundle */
export function coverHtml(bundle) {
  const { pr } = bundle
  const tour = /** @type {TourPageTour} */ (bundle.tour)
  // The route ahead, by landmark title: each landmark tells its own lead, so the cover tells none.
  const agenda = `<ol class="tour-agenda">${tour.landmarks
    .map(
      l =>
        `<li><span class="tour-agenda-stage">${esc(STAGE_LABEL[l.stage])}</span><span class="tour-agenda-name">${esc(l.title)}</span></li>`
    )
    .join('')}</ol>`
  // The header already names the change, its author, branch, and size; the cover adds what it
  // touches, when the tour says.
  const blast =
    tour.blastRadius.length === 0
      ? ''
      : `<p class="tour-cover-meta">touches: ${tour.blastRadius.map(esc).join(', ')}</p>`
  return `
    <h1 class="tour-title">${esc(pr.title)}</h1>
    ${blast}
    ${agenda}
    <div class="tour-budget">
      <div><b>${tour.landmarks.length}</b><span>landmarks</span></div>
      <div><b>${tour.decisions.length}</b><span>decisions</span></div>
      <div><b>${bundle.options.finalQuiz === 'off' ? 0 : tour.quiz.length}</b><span>questions</span></div>
      <div><b>~${minutesOf(tour)}</b><span>minutes</span></div>
    </div>
    ${bundle.reader.finished ? '<p class="tour-hint">You finished this tour. Read it again, or open the plan.</p>' : ''}
    <div class="tour-cover-actions">
      <button class="cmd fill big" type="button" data-nav="next">${bundle.reader.step > 0 ? 'continue the tour' : 'start the tour'}</button>
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
  return `<div class="tour-return"><span>${esc(text)}</span><button class="cmd" type="button" data-act="return">${esc(label)}</button></div>`
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
  // The pictures come first and wide: the reader takes the landmark in from them, then the prose.
  const frame = (/** @type {'scene' | 'micro'} */ kind) =>
    kind === 'scene'
      ? `<div class="tour-scene"><div class="tour-frame-host" data-landmark="${esc(landmark.id)}" data-kind="scene"></div></div>`
      : `<div class="tour-micro"><div class="tour-micro-h"><span>micro-world</span><span>try it: change the inputs</span></div><div class="tour-frame-host" data-landmark="${esc(landmark.id)}" data-kind="micro"></div></div>`
  const figure =
    landmark.scene || landmark.micro
      ? `<figure class="tour-figure">${landmark.scene ? frame('scene') : ''}${landmark.micro ? frame('micro') : ''}</figure>`
      : ''
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
      : `<div class="tour-actions"><button class="cmd" type="button" data-act="code">${codeButtonHtml(codeOpen)}</button></div>
         <div class="tour-code"${codeOpen ? '' : ' hidden'}>
           ${
             hasLiterate
               ? `<div class="tour-code-tabs" role="tablist">
                    <button class="tour-code-tab" type="button" role="tab" aria-selected="${codeView === 'literate'}" data-act="code-view" data-view="literate">literate diff</button>
                    <button class="tour-code-tab" type="button" role="tab" aria-selected="${codeView === 'raw'}" data-act="code-view" data-view="raw">raw diff</button>
                  </div>`
               : ''
           }
           <div class="tour-code-body">${codeViewHtml(landmark, codeView, fileLinker(bundle))}</div>
         </div>`
  return `
    ${returnBannerHtml(steps, tour, reader.returnTo)}
    <p class="tour-eyebrow"><span class="tour-stage-tag">${esc(STAGE_LABEL[landmark.stage])}</span><span>landmark ${n} of ${tour.landmarks.length}</span>${landmark.state ? '<span class="tour-state-tag">state landmark</span>' : ''}</p>
    <h2 class="tour-title">${plain(landmark.title)}</h2>
    <p class="tour-lead">${inline(landmark.lead)}</p>
    ${figure}
    <div class="tour-body">${landmark.body.map(p => `<p>${inline(p)}</p>`).join('')}</div>
    ${chips}
    <div class="tour-note"><label for="note-${esc(landmark.id)}">Something I noticed <span class="tour-hint">optional</span></label><textarea id="note-${esc(landmark.id)}" data-act="note" data-landmark="${esc(landmark.id)}" rows="2" placeholder="A thought while reading, so you do not have to hold it until the decisions">${esc(note)}</textarea></div>
    ${code}`
}

/** @param {boolean} open */
export function codeButtonHtml(open) {
  return `${open ? 'hide code' : 'code behind this landmark'} <kbd>i</kbd>`
}

/**
 * @param {TourPageLandmark} landmark
 * @param {'literate' | 'raw'} view
 * @param {FileLink} [link]
 */
export function codeViewHtml(landmark, view, link = () => null) {
  return view === 'literate'
    ? literateHtml(landmark, link)
    : landmark.code.map(chunk => chunkHtml(chunk, link)).join('')
}

/**
 * Where each file of the tour opens on the forge: the file at the commit the tour reads, at the
 * first line the chunk shows; a removed file at the merge base, where it last lived. Local work
 * is on no forge, so its files open nowhere.
 * @param {TourBundle} bundle
 * @returns {FileLink}
 */
export function fileLinker(bundle) {
  const { pr, tour } = bundle
  if (pr.url === '' || tour === undefined) {
    return () => null
  }
  return chunk => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/m.exec(chunk.diff)
    if (hunk === null) {
      return fileUrl(tour.repo, tour.headSha, chunk.path)
    }
    const removed = hunk[2] === '0' && hunk[3] === '0'
    return removed
      ? fileUrl(tour.repo, pr.mergeBaseSha, chunk.path, Number(hunk[1]))
      : fileUrl(tour.repo, tour.headSha, chunk.path, Number(hunk[2]))
  }
}

/**
 * The literate diff: prose in reading order, with the chunks embedded where they belong.
 * @param {TourPageLandmark} landmark
 * @param {FileLink} [link]
 */
export function literateHtml(landmark, link = () => null) {
  return `<div class="tour-literate">${landmark.literate
    .map(block => {
      if (typeof block === 'string') {
        return `<p>${inline(block)}</p>`
      }
      const chunk = 'chunk' in block ? landmark.code[block.chunk] : block
      return chunk === undefined ? '' : chunkHtml(chunk, link)
    })
    .join('')}</div>`
}

/**
 * @param {CodeChunk} chunk
 * @param {FileLink} [link]
 */
export function chunkHtml(chunk, link = () => null) {
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
  const url = link(chunk)
  const name = `Open ${chunk.path} on ${currentHost().label}`
  const open =
    url === null
      ? ''
      : `<a class="tour-file-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(name)}" aria-label="${esc(name)}">${EXTERNAL_ICON}</a>`
  return `<div class="tour-code-file"><span>${esc(chunk.path)}</span>${open}</div><div class="tour-diff">${lines.join('')}</div>`
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
  const p = reader.picks[d.key]
  const done = pickSettled(p)
  const chosen = chosenPick(p)
  const note = (reader.notes[d.landmark] ?? '').trim()
  const from =
    landmark === undefined
      ? ''
      : `<a href="#landmark-${esc(landmark.id)}" data-act="landmark" data-landmark="${esc(landmark.id)}">from landmark ${landmarkIndex}: ${esc(landmark.title)}</a>`
  const tryIt = d.tryIt
    ? `<div class="tour-card tour-tryit"><div class="tour-card-h"><span>try it${d.tryIt.verified ? ' · verified when this tour was generated' : ''}</span></div>
       <ol>${d.tryIt.steps.map(tryItStepHtml).join('')}</ol>
       <ul>${d.tryIt.look.map(s => `<li>${inline(s)}</li>`).join('')}</ul>
       <label><input type="checkbox" data-act="tried"${p?.tried ? ' checked' : ''}> I tried it</label></div>`
    : ''
  const unsettle = '<button class="cmd" type="button" data-act="unsettle">undo</button>'
  const actions =
    chosen === null
      ? '<span class="tour-hint">pick one: <kbd>k</kbd> keep · <kbd>a</kbd> alternative · <kbd>c</kbd> something else</span>'
      : chosen === 'keep'
        ? `<span class="tour-state">✓ kept</span>${unsettle}`
        : chosen === 'change'
          ? `<span class="tour-state change">✓ alternative · in the plan</span>${unsettle}`
          : done
            ? `<span class="tour-state change">✓ change approved · in the plan</span><button class="cmd" type="button" data-act="grill">reopen</button>${unsettle}`
            : `<button class="cmd fill" type="button" data-act="grill">continue the conversation <kbd>c</kbd></button>${unsettle}`
  const other = {
    label: 'Something else',
    consequence: 'Neither side: say what you want instead, then approve it as restated.',
  }
  return `
    ${returnBannerHtml(steps, tour, reader.returnTo)}
    <p class="tour-eyebrow"><span class="tour-stage-tag">${esc(CATEGORY_LABEL[d.category] ?? d.category)}</span><span>decision ${n} of ${tour.decisions.length}</span>${from}</p>
    <h2 class="tour-title">${plain(d.title)}</h2>
    <p class="tour-lead">${inline(d.context)}</p>
    <p class="tour-anchor"><span class="mono">${esc(d.anchor.path)}:${d.anchor.line}</span></p>
    ${note === '' ? '' : `<div class="tour-landmark-note"><b>Your note on landmark ${landmarkIndex}</b>${esc(note)}</div>`}
    <div class="tour-options" role="radiogroup" aria-label="Keep, the alternative, or something else">
      ${optionHtml('keep', d.keep, chosen === 'keep', { isNow: true, recommended: d.recommended === 'keep' })}
      ${optionHtml('change', d.change, chosen === 'change', { isNow: false, recommended: d.recommended === 'change' })}
      ${optionHtml('other', other, chosen === 'other', { isNow: false, recommended: false })}
    </div>
    ${tryIt}
    <div class="tour-actions">${actions}</div>
    ${done && p?.pick === 'other' && p.restatement ? restatedHtml(p.restatement) : ''}`
}

/**
 * A try-it step: a bare command is one code line; a step in words marks its commands with
 * backticks, and reads as prose with code in it.
 * @param {string} step
 */
export function tryItStepHtml(step) {
  return step.includes('`') ? `<li>${inline(step)}</li>` : `<li><code>${esc(step)}</code></li>`
}

const OPTION_LABEL = { keep: 'keep', change: 'alternative', other: 'something else' }

/**
 * @param {'keep' | 'change' | 'other'} kind
 * @param {{ label: string, consequence: string }} side
 * @param {boolean} checked
 * @param {{ isNow: boolean, recommended: boolean }} marks what the code does, and what the tour advises
 */
function optionHtml(kind, side, checked, marks) {
  return `<button class="tour-option" type="button" role="radio" aria-checked="${checked}" data-act="pick" data-pick="${kind}"${marks.recommended ? ' data-recommended' : ''}>
    <span class="tour-option-k"><span>${OPTION_LABEL[kind]}</span>${marks.isNow ? '<span class="now">what the code does</span>' : ''}${marks.recommended ? '<span class="rec">the tour recommends</span>' : ''}</span>
    <span class="tour-option-l">${plain(side.label)}</span>
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
      : `<button class="cmd" type="button" data-act="reopen" data-landmark="${esc(landmark.id)}">reopen landmark ${landmarkIndex}: ${esc(landmark.title)}</button><span class="tour-hint">then answer again</span>`
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
        // The answer says how it went in words too, so a wrong one is not told by red alone.
        const mark =
          result === ''
            ? ''
            : `<span class="tour-quiz-res">${result === 'right' ? '✓ right' : '✗ your answer'}</span>`
        return `<button class="tour-quiz-opt" type="button" data-act="answer" data-i="${i}" data-n="${i + 1}"${result === '' ? '' : ` data-result="${result}"`}${a?.right ? ' disabled' : ''}><span>${inline(o)}</span>${mark}</button>`
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
  // The tour's alternative asks for its own side; something else settled with its restatement.
  const changes = entries
    .filter(e => e.p.pick !== 'keep')
    .map(e => ({
      d: e.d,
      r:
        e.p.pick === 'other'
          ? /** @type {Restatement} */ (e.p.restatement)
          : /** @type {{ what: string, where: string[], unchanged?: string }} */ ({
              what: `${e.d.change.label}. ${e.d.change.consequence}`,
              where: [`${e.d.anchor.path}:${e.d.anchor.line}`],
            }),
    }))
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
    : `When you confirm, ${bundle.shares ? 'the record is shared and ' : ''}the prompt carries the intent and the kept decisions for whoever touches this next.`
  const changed = finished !== undefined && planChanged(tour, reader)
  const confirm = `<div class="tour-actions"><button class="cmd fill" type="button" data-act="confirm">${changed ? 'confirm again' : 'confirm the plan'}</button><span class="tour-hint">writes the prompt${bundle.shares ? ', shares the record' : ''}</span>${
    bundle.chat.enabled && bundle.options.grill !== 'off'
      ? '<button class="cmd" type="button" data-act="grill-plan">restate the plan with the agent</button>'
      : ''
  }</div>`
  const done = finished
    ? `${changed ? `<p class="tour-plan-changed" role="status">You changed the plan after you confirmed it. Confirm again to write the prompt from it; the one below is from before.</p>${confirm}` : ''}
       <h3 class="tour-section-h">${changed ? 'Confirmed before' : 'Done'}</h3><ul class="tour-sharing">
         ${sharingLine(finished.sharing)}
         ${finished.queued === undefined ? '' : `<li>${finished.queued === 0 ? 'Nothing new for your pending review.' : `${plural(finished.queued, 'change request')} added to your pending review; it goes out with your verdict.`}</li>`}
         ${bundle.options.finalQuiz === 'off' ? '' : `<li class="private">Quiz ${right} of ${tour.quiz.length}, kept on this machine.</li>`}
         <li>Prompt written to <span class="mono">${esc(finished.promptPath)}</span>. Run <code>/pr-tour-apply ${esc(bundle.local ?? String(tour.pr.number))}</code> to implement it.</li>
       </ul>
       <h3 class="tour-section-h">Re-implementation prompt</h3>
       <div class="tour-prompt"><div class="tour-actions"><button class="cmd" type="button" data-act="copy">copy</button></div><pre id="prompt">${esc(finished.prompt)}</pre></div>`
    : bundle.preview
      ? '<div class="tour-actions"><span class="tour-hint">A preview is not finished: publish the tour first.</span></div>'
      : confirm
  return `
    <p class="tour-eyebrow"><span class="tour-stage-tag">The plan</span></p>
    <h2 class="tour-title">${esc(title)}</h2>
    <p class="tour-lead">${esc(lead)}</p>
    ${changes.length ? `<h3 class="tour-section-h">Changes</h3><ol class="tour-plan-list">${changes.map(({ d, r }) => `<li><b>${esc(d.title)}</b><br>${inline(r.what)} <span class="where">${r.where.map(esc).join(' · ')}</span>${r.unchanged === undefined ? '' : `<span class="stays">Stays the same: ${inline(r.unchanged)}</span>`}</li>`).join('')}</ol>` : ''}
    ${notes.length ? `<h3 class="tour-section-h">Your notes while reading</h3><ul class="tour-kept">${notes.map(({ l, text }) => `<li><span>landmark ${tour.landmarks.indexOf(l) + 1}</span><span>${esc(text)}</span><span class="place">${esc(l.title)}</span></li>`).join('')}</ul>` : ''}
    <h3 class="tour-section-h">Kept</h3>
    <ul class="tour-kept">${kept.map(({ d }) => `<li><span>${esc(d.keep.label)}</span><span>${inline(d.keep.consequence)}</span></li>`).join('') || '<li>none</li>'}</ul>
    ${done}
    ${tour.notToured.length ? `<h3 class="tour-section-h">Not toured</h3><ul class="tour-not">${tour.notToured.map(n => `<li><span>${esc(n.title)}</span><span class="path">${n.paths.map(esc).join('<br>')}</span></li>`).join('')}</ul>` : ''}`
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
  const command = `<p><code class="tour-cmd">${esc(bundle.skillCommand)}</code> <button class="cmd" type="button" data-copy="${esc(bundle.skillCommand)}">copy</button></p>`
  const body = canGenerate(bundle)
    ? `<p>Generate it here with the chat agent, or run the tour skill in your agent:</p>
    <p><button class="cmd fill" type="button" id="generate-start" aria-haspopup="dialog">generate tour</button></p>
    ${command}`
    : `<p>Run the tour skill in your agent, then this page draws it:</p>
    ${command}${notAuthorHtml(bundle)}`
  // Only a pull request takes a shared tour: local work has none to be shared on.
  const drop =
    bundle.local === undefined && !bundle.preview ? `${fetchSharedHtml()}${dropZoneHtml('tour')}` : ''
  return `<section class="panel tour-missing" aria-labelledby="missing-h"><div class="panel-h"><h2 id="missing-h">No tour yet for ${what}</h2></div>
    <div class="body">${body}${drop}
    <p class="muted">This page checks again every few seconds.</p></div></section>`
}

/** The command that looks on the pull request for a tour someone shared as a comment. */
function fetchSharedHtml() {
  return '<button class="cmd" type="button" id="fetch-shared" title="Look on the pull request for a tour someone shared, and load it">look for a shared tour</button>'
}

/**
 * Whether the page can generate the tour itself: an agent runs here, `tour.generate` lets this
 * reader, and this is no preview.
 * @param {TourBundle} bundle
 */
export function canGenerate(bundle) {
  return bundle.chat.enabled && bundle.generate === 'allowed' && !bundle.preview
}

/**
 * Why the page offers no generate command to a reader who could otherwise run one.
 * @param {TourBundle} bundle
 */
function notAuthorHtml(bundle) {
  return bundle.chat.enabled && bundle.generate === 'not-author' && !bundle.preview
    ? '<p class="muted">Only the author generates the tour here (<code>tour.generate: author</code>): its agent runs with every permission, and a diff someone else wrote could steer it. Set <code>tour.generate: on</code> in <code>pr-review.config.yml</code> to allow every reader.</p>'
    : ''
}

/**
 * The header's generate command, which opens the dialog and shows the job while one runs.
 * @param {TourBundle} bundle
 */
function generateButtonHtml(bundle) {
  if (!canGenerate(bundle)) {
    return ''
  }
  const mode = tourGenerationMode(bundle)
  return `<button class="cmd" type="button" id="${GENERATE_BUTTON_ID}" title="${esc(mode.title)}" aria-haspopup="dialog">${mode.label}</button>`
}

/**
 * @param {TourBundle} bundle
 */
export function staleBarHtml(bundle) {
  const stale = bundle.stale
  if (stale === undefined) {
    return ''
  }
  const tour = `<span class="mono">${esc(stale.tourHeadSha.slice(0, 7))}</span>`
  const head = `<span class="mono">${esc(stale.currentHeadSha.slice(0, 7))}</span>`
  // The canvas's outdated bar says the same in the same words.
  const summary =
    bundle.local !== undefined
      ? `The tour is for ${tour}; your work has moved on to ${head} since it was generated.`
      : stale.relation === 'ancestor'
        ? `The tour is for ${tour}, ${esc(plural(stale.commitsBehind ?? 0, 'commit'))} behind the head ${head}.`
        : `The tour is for ${tour}, which is not in this branch any more; the head is ${head}.`
  const shared = bundle.local === undefined ? ` ${fetchSharedHtml()}` : ''
  const action = canGenerate(bundle)
    ? ` <button class="cmd" type="button" id="stale-generate" aria-haspopup="dialog">update the tour</button> or run <code>${esc(bundle.skillCommand)}</code>; picks carry by decision key.`
    : ` Run <code>${esc(bundle.skillCommand)}</code> to update it; picks carry by decision key.`
  return `<div class="tour-stale" role="status"><strong>Tour is outdated.</strong> You are reading an older commit. ${summary}${action}${shared}</div>`
}

export function helpHtml() {
  return `<h3>Keys</h3><dl>
    <dt><kbd>→</kbd> <kbd>space</kbd></dt><dd>next</dd>
    <dt><kbd>←</kbd></dt><dd>back</dd>
    <dt><kbd>i</kbd></dt><dd>show the code behind a landmark</dd>
    <dt><kbd>k</kbd> <kbd>a</kbd> <kbd>c</kbd></dt><dd>keep, take the alternative, or ask for something else</dd>
    <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dt><dd>answer a question</dd>
    <dt><kbd>esc</kbd></dt><dd>close this, or the drawer</dd>
  </dl>
  <p>A tour has landmarks that explain the change, decisions you keep or change, and a quiz. The browser's back and forward buttons move through it, and a reload lands where you were.</p>
  <div class="tour-actions"><button class="cmd" type="button" data-act="close-help">close</button></div>`
}
