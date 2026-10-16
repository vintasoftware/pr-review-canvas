// @ts-check
// Generating the canvas or the tour from its page: the dialog that starts a run and shows where it
// is. The server runs the job and keeps it across reloads; the page only polls it, and loads the
// new canvas or tour once the job publishes one. While a job runs, the header's generate command
// shows it and opens its dialog.
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').TourBundle} TourBundle */
/** @typedef {import('./contract-types.js').GenerationKind} GenerationKind */
/** @typedef {import('./contract-types.js').ReviewKey} ReviewKey */
/** @typedef {import('./contract-types.js').GenerationJob} GenerationJob */
/** @typedef {import('./contract-types.js').GenerationResponse} GenerationResponse */
/** @typedef {import('./contract-types.js').AgentPulse} AgentPulse */
/** @typedef {import('./contract-types.js').GenerationSkill} GenerationSkill */
import { ApiError, fetchJson } from './api.js'
import { esc } from './dom.js'
import { isRunning, phaseLabel } from './generation-phases.js'
import { hostLabel } from './host.js'

export const GENERATE_DIALOG_ID = 'generate-dialog'
export const GENERATION_POLL_MS = 2000
/**
 * How long the agent can say nothing before the dialog says it may be stuck. Thinking and writing
 * both stream, so a working agent is rarely quiet this long; a slow first answer can be.
 */
export const QUIET_MS = 3 * 60 * 1000

/** @type {Record<AgentPulse['doing'], string>} */
const DOING_LABELS = {
  starting: 'Waiting for the agent to start',
  thinking: 'Thinking',
  writing: 'Writing the answer',
  tool: 'Running a tool',
}

/**
 * How long the job has run, as `3m 12s`.
 * @param {Pick<GenerationJob, 'startedAt' | 'endedAt'>} job
 * @param {Date} now
 */
export function elapsedText(job, now) {
  const end = job.endedAt === undefined ? now.getTime() : Date.parse(job.endedAt)
  return durationText(end - Date.parse(job.startedAt))
}

/**
 * A span of time as `42s` or `3m 12s`.
 * @param {number} ms
 */
function durationText(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * What the agent is doing in the turn that runs now, and how long since it last showed it was
 * working. A quiet spell past QUIET_MS adds a warning, with the stop command below it.
 * @param {AgentPulse | undefined} pulse
 * @param {Date} now
 * @returns {string}
 */
export function pulseHtml(pulse, now) {
  if (pulse === undefined) {
    return ''
  }
  const quiet = now.getTime() - Date.parse(pulse.at)
  const written = pulse.doing === 'writing' ? ` · ${pulse.written.toLocaleString('en-US')} characters` : ''
  const stuck = quiet >= QUIET_MS
  const line = `<p class="gen-pulse" data-doing="${pulse.doing}"${stuck ? ' data-quiet' : ''}>${DOING_LABELS[pulse.doing]}${written} · last activity ${durationText(quiet)} ago</p>`
  return !stuck
    ? line
    : `${line}<div class="callout warn" role="status">Nothing from the agent for ${durationText(quiet)}. It may be stuck: stop the run, or keep waiting.</div>`
}

/**
 * What generating does on this screen, named once for the header command and the dialog: the
 * first canvas, an update of an outdated one, or the current one written again. `choice` is true
 * when the reader may pick between updating an earlier canvas and a blank page, and `blank` is
 * the default. A head that already has a canvas needs neither: the server always writes it again
 * from a blank page.
 * @param {PrBundle} bundle
 * @returns {{ label: string, title: string, heading: string, text: string, blank: boolean, choice: boolean }}
 */
export function generationMode(bundle) {
  const what = bundle.local ? 'this local work' : 'this PR'
  if (bundle.status === 'stale') {
    return {
      label: 'update',
      title: `Update the canvas of ${what} for its current head`,
      heading: 'Update the canvas',
      text: 'The agent updates the canvas of the earlier commit for the current head. What the new commits left untouched is carried over, and review progress on it follows.',
      blank: false,
      choice: true,
    }
  }
  if (bundle.status === 'ready') {
    return {
      label: 'regenerate',
      title: `Generate the canvas of ${what} again from a blank page`,
      heading: 'Regenerate the canvas',
      text: 'The agent writes the canvas for the current head again. The current canvas stays until the new one is published.',
      blank: true,
      // A carried-over canvas belongs to an earlier commit, so the head may still be updated from it.
      choice: bundle.carriedOver !== undefined,
    }
  }
  return {
    label: 'generate',
    title: `Generate a canvas for ${what}`,
    heading: 'Generate the canvas',
    text: 'The agent reads the diff and writes the canvas. It usually takes several minutes.',
    blank: false,
    choice: false,
  }
}

/**
 * Where the canvas goes once it is published.
 * @param {PrBundle} bundle
 */
function sharingNote(bundle) {
  return bundle.canvasComment
    ? `Publishing shares the canvas as a comment on the ${bundle.local ? 'review' : 'pull request'}, with your ${esc(hostLabel())} login.`
    : 'The canvas stays on this machine; nothing is posted.'
}

/**
 * Which pr-review-canvas skill the run follows: the project's own copy, or the default when the
 * project has none.
 * @param {GenerationSkill} skill
 * @returns {string}
 */
export function skillHtml(skill) {
  if (skill.source === 'default') {
    return `<p class="hint gen-skill">Follows the default skill of pr-review ${esc(skill.version)}: this project has none installed.</p>`
  }
  const where = `this project's skill, <code>${esc(skill.path)}</code>`
  const state = {
    current: '',
    edited: ', changed from the copy pr-review installs',
    'other-version':
      ', which a different pr-review version installed; <code>pr-review upgrade</code> refreshes it',
  }[skill.state]
  return `<p class="hint gen-skill">Follows ${where}${state}.</p>`
}

/**
 * @param {string} command
 */
function skillFallbackHtml(command) {
  return (
    '<p class="hint">Or run it yourself in Claude Code or Codex from this repo:</p>' +
    `<div class="cmdbox"><code>${esc(command)}</code><button class="cmd" type="button" data-copy="${esc(command)}">copy</button></div>`
  )
}

/**
 * The screen that starts a run, with why the server refused the last start when it did, and the
 * skill the run would follow once the server has said which.
 * @param {PrBundle} bundle
 * @param {{ message: string, hint?: string } | null} [refused]
 * @param {GenerationSkill | null} [skill]
 * @returns {string}
 */
export function generationStartHtml(bundle, refused = null, skill = null) {
  const mode = generationMode(bundle)
  const agent = bundle.chat.agent ? `<strong>${esc(bundle.chat.agent)}</strong>` : 'the chat agent'
  const choice = mode.choice
    ? `<label class="gen-force"><input type="checkbox" name="force"${mode.blank ? ' checked' : ''}> Start from a blank page instead of updating the earlier canvas</label>`
    : ''
  return (
    `<h2 id="gen-h">${mode.heading}</h2>` +
    (refused === null
      ? ''
      : `<div class="callout warn" role="alert">${esc(refused.message)}${refused.hint ? ` — ${esc(refused.hint)}` : ''}</div>`) +
    `<p class="hint">${esc(mode.text)}</p>` +
    `<p class="hint">It runs ${agent} through acpx with the chat's permissions, which deny writes, and the model the project config names for it. ${sharingNote(bundle)}</p>` +
    (skill === null ? '' : skillHtml(skill)) +
    choice +
    skillFallbackHtml(bundle.skillCommand) +
    '<div class="dialog-actions">' +
    '<button class="cmd" type="submit" value="close">cancel</button>' +
    '<button class="cmd fill" type="button" data-gen="start">start</button>' +
    '</div>'
  )
}

/**
 * What generating does on the tour page: the first tour, an update of an outdated one, or this
 * head's written again. Updating starts from the earlier tour, so the reader may pick a blank page
 * instead; a head that has its own tour is always written again from one.
 * @param {TourBundle} bundle
 * @returns {{ label: string, title: string, heading: string, text: string, choice: boolean }}
 */
export function tourGenerationMode(bundle) {
  const what = bundle.local ? 'this local work' : 'this PR'
  if (bundle.status === 'stale') {
    return {
      label: 'update',
      title: `Update the tour of ${what} for its current head`,
      heading: 'Update the tour',
      text: 'The agent updates the tour of the earlier commit for the current head: what the new commits left untouched is carried over, the rest is judged again, and your picks carry by decision key. The earlier tour stays until the new one is published.',
      choice: true,
    }
  }
  if (bundle.status === 'ready') {
    return {
      label: 'regenerate',
      title: `Generate the tour of ${what} again`,
      heading: 'Regenerate the tour',
      text: 'The agent writes the tour of the current head again. The current tour stays until the new one is published.',
      choice: false,
    }
  }
  return {
    label: 'generate',
    title: `Generate a tour of ${what}`,
    heading: 'Generate the tour',
    text: 'The agent reads the diff, draws a picture for each landmark, looks at them, and writes the tour. It usually takes ten minutes or more.',
    choice: false,
  }
}

/**
 * The tour page's start screen. Unlike the canvas's, the tour's agent writes files and runs
 * commands, and the screen says so before the reader starts it.
 * @param {TourBundle} bundle
 * @param {{ message: string, hint?: string } | null} [refused]
 * @param {GenerationSkill | null} [skill]
 * @returns {string}
 */
export function tourGenerationStartHtml(bundle, refused = null, skill = null) {
  const mode = tourGenerationMode(bundle)
  const agent = bundle.chat.agent ? `<strong>${esc(bundle.chat.agent)}</strong>` : 'the chat agent'
  const sharing =
    bundle.local === undefined && bundle.shares
      ? `Publishing shares the tour as a comment on the pull request, with your ${esc(hostLabel())} login.`
      : 'The tour stays on this machine; nothing is posted.'
  return (
    `<h2 id="gen-h">${mode.heading}</h2>` +
    (refused === null
      ? ''
      : `<div class="callout warn" role="alert">${esc(refused.message)}${refused.hint ? ` — ${esc(refused.hint)}` : ''}</div>`) +
    `<p class="hint">${esc(mode.text)}</p>` +
    `<p class="hint">It runs ${agent} through acpx with every permission approved, from this repository's folder: it writes the tour's files, runs pr-review's tour commands, and runs the project's try-it recipes in a checkout of its own. The model is the one the project config names for it. ${sharing}</p>` +
    (skill === null ? '' : skillHtml(skill)) +
    (mode.choice
      ? '<label class="gen-force"><input type="checkbox" name="force"> Start from a blank page instead of updating the earlier tour</label>'
      : '') +
    skillFallbackHtml(bundle.skillCommand) +
    '<div class="dialog-actions">' +
    '<button class="cmd" type="submit" value="close">cancel</button>' +
    '<button class="cmd fill" type="button" data-gen="start">start</button>' +
    '</div>'
  )
}

/**
 * What publish did with the canvas or tour of a done job, in a sentence. A failed share keeps the warning
 * publish wrote, which already says to upload the ZIP, and adds where the ZIP is.
 * @param {GenerationJob} job
 */
function outcomeHtml(job) {
  const sharing = job.sharing
  if (sharing?.status === 'shared') {
    return `<p class="hint">The ${job.kind} is published and <a href="${esc(sharing.url)}" target="_blank" rel="noopener noreferrer">shared on ${esc(hostLabel())}</a>.</p>`
  }
  if (sharing?.status === 'failed') {
    return `<div class="callout warn" role="status">${esc(sharing.warning)} The ZIP: <code>${esc(sharing.zipPath)}</code></div>`
  }
  if (sharing?.status === 'off') {
    return `<p class="hint">The ${job.kind} is published. Sharing is off, so nothing was posted.</p>`
  }
  return `<p class="hint">The ${job.kind} is published.</p>`
}

/**
 * The status of a job: its phase, how long it has run, what the agent did last, and the problems
 * it was sent back with.
 * @param {GenerationJob} job
 * @param {Date} now
 * @returns {string}
 */
export function generationStatusHtml(job, now) {
  const running = isRunning(job)
  const attempt = job.round > 1 ? ` · attempt ${job.round} of ${job.maxRounds}` : ''
  const model = job.model === null ? '' : ` (${esc(job.model)})`
  const label = job.stopping && running ? 'Stopping…' : phaseLabel(job)
  const activity =
    job.activity.length === 0
      ? ''
      : `<ol class="gen-activity" aria-label="Latest agent tool calls">${job.activity.map(a => `<li>${esc(a)}</li>`).join('')}</ol>`
  const problems =
    job.phase === 'done' || job.problems === undefined || job.problems.length === 0
      ? ''
      : `<details class="gen-problems"${job.phase === 'failed' ? ' open' : ''}><summary>${job.problems.length} issue${job.problems.length === 1 ? '' : 's'} found during validation</summary><ul>${job.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>`
  const error = job.error
    ? `<div class="callout warn" role="alert">${esc(job.error.message)}${job.error.hint ? ` — ${esc(job.error.hint)}` : ''}</div>`
    : ''
  const done = job.phase === 'done' ? outcomeHtml(job) : ''
  const actions = running
    ? `<button class="cmd" type="submit" value="close">hide</button><button class="cmd" type="button" data-gen="stop"${job.stopping ? ' disabled' : ''}>stop</button>`
    : `<button class="cmd" type="submit" value="close">close</button>${job.phase === 'done' ? '' : '<button class="cmd fill" type="button" data-gen="again">try again</button>'}`
  return (
    `<h2 id="gen-h">${esc(label)}</h2>` +
    `<p class="gen-meta mono" aria-live="polite">${esc(job.agent)}${model} · ${elapsedText(job, now)}${attempt}</p>` +
    (running
      ? `<p class="hint">You can close this dialog; the run goes on. The page loads the ${job.kind} when it is published.</p>`
      : '') +
    skillHtml(job.skill) +
    error +
    done +
    (job.phase === 'repairing' && !job.stopping
      ? '<p class="hint" role="status">The agent is automatically correcting the issues below. No action is needed.</p>'
      : '') +
    (running ? pulseHtml(job.pulse, now) : '') +
    activity +
    problems +
    `<div class="dialog-actions">${actions}</div>`
  )
}

/** The id of the header's generate command, which shows the job while one runs. */
export const GENERATE_BUTTON_ID = 'regenerate'

/**
 * What the header's generate command says while a job runs.
 * @param {GenerationJob} job
 * @param {Date} now
 */
export function runningLabel(job, now) {
  return `${job.stopping ? 'stopping' : 'generating'} · ${elapsedText(job, now)}`
}

/** @typedef {{ fetchImpl?: typeof fetch | undefined, kind?: GenerationKind | undefined }} GenerationApi */

/**
 * Where a review's job of this kind lives: the canvas's under `prs`, the tour's under `tours`.
 * @param {ReviewKey} prNumber
 * @param {GenerationKind | undefined} kind
 */
function jobPath(prNumber, kind) {
  return `/api/${kind === 'tour' ? 'tours' : 'prs'}/${prNumber}/generate`
}

/**
 * @param {ReviewKey} prNumber
 * @param {GenerationApi} [opts]
 * @returns {Promise<GenerationResponse>}
 */
export function fetchGeneration(prNumber, opts = {}) {
  return fetchJson(jobPath(prNumber, opts.kind), { fetchImpl: opts.fetchImpl })
}

/**
 * The skill a run started now would follow.
 * @param {GenerationApi} [opts]
 * @returns {Promise<import('./contract-types.js').GenerationSkillResponse>}
 */
export function fetchGenerationSkill(opts = {}) {
  return fetchJson(`/api/generate/skill${opts.kind === 'tour' ? '?kind=tour' : ''}`, {
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {boolean} force
 * @param {GenerationApi} [opts]
 * @returns {Promise<GenerationResponse>}
 */
export function startGeneration(prNumber, force, opts = {}) {
  return fetchJson(jobPath(prNumber, opts.kind), {
    method: 'POST',
    body: { force },
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {GenerationApi} [opts]
 * @returns {Promise<{ cancelled: boolean, job: GenerationJob | null }>}
 */
export function stopGeneration(prNumber, opts = {}) {
  return fetchJson(jobPath(prNumber, opts.kind), { method: 'DELETE', fetchImpl: opts.fetchImpl })
}

/**
 * The dialog under `root`, made on first use. A render replaces the page's content, so it is made
 * again after one.
 * @param {HTMLElement} root
 * @returns {HTMLDialogElement}
 */
function ensureDialog(root) {
  const found = root.querySelector(`#${GENERATE_DIALOG_ID}`)
  if (found instanceof HTMLDialogElement) {
    return found
  }
  const dialog = document.createElement('dialog')
  dialog.id = GENERATE_DIALOG_ID
  dialog.className = 'gen'
  dialog.setAttribute('aria-labelledby', 'gen-h')
  dialog.innerHTML = '<form method="dialog"></form>'
  root.appendChild(dialog)
  return dialog
}

/** @param {HTMLDialogElement} dialog */
function showDialog(dialog) {
  if (dialog.open) {
    return
  }
  if (typeof dialog.showModal === 'function') {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
}

/**
 * The page's side of generation: one per review or tour page, kept across renders. A tour page
 * passes `kind: 'tour'` and its own start screen; the review page's are the defaults.
 * @template [B=PrBundle]
 * @param {HTMLElement} root
 * @param {{
 *   prNumber: ReviewKey,
 *   onEnded: (job: GenerationJob) => void | Promise<void>,
 *   onError?: (message: string) => void,
 *   kind?: GenerationKind,
 *   startHtml?: (bundle: B, refused: { message: string, hint?: string } | null, skill: GenerationSkill | null) => string,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   pollMs?: number,
 * }} opts
 */
export function createGeneration(root, opts) {
  const now = opts.now ?? (() => new Date())
  const pollMs = opts.pollMs ?? GENERATION_POLL_MS
  const kind = opts.kind ?? 'canvas'
  // Without its own start screen, B is the review page's PrBundle.
  const startHtml =
    opts.startHtml ??
    /** @type {NonNullable<typeof opts.startHtml>} */ (/** @type {unknown} */ (generationStartHtml))
  const api = { fetchImpl: opts.fetchImpl, kind }
  /** @type {GenerationJob | null} */
  let job = null
  /** @type {B | null} */
  let bundle = null
  /** The dialog shows the start screen rather than a job. */
  let starting = false
  /**
   * Why the server refused the last start, shown on the start screen until the next try.
   * @type {{ message: string, hint?: string } | null}
   */
  let startError = null
  /**
   * The skill a run would follow, read each time the start screen opens: the project's copy can
   * change between runs.
   * @type {GenerationSkill | null}
   */
  let skill = null
  /** True once this page saw the job running, so its end is news to it. */
  let watching = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let stopped = false

  const dialogOpen = () => root.querySelector(`#${GENERATE_DIALOG_ID}`)?.hasAttribute('open') === true

  /** Reads which skill a run would follow; the start screen shows without it until then. */
  const readSkill = async () => {
    try {
      skill = (await fetchGenerationSkill(api)).skill
    } catch {
      return
    }
    if (starting && dialogOpen()) drawDialog()
  }

  /**
   * Puts the running job on the header's generate command, and gives it back its own label and
   * title when the job ends. The header is drawn again on every render, so this runs after each.
   */
  const drawButton = () => {
    const button = root.querySelector(`#${GENERATE_BUTTON_ID}`)
    if (!(button instanceof HTMLElement)) {
      return
    }
    // The header's own words, kept the first time so the button can have them back.
    const label = (button.dataset['label'] ??= String(button.textContent))
    const title = (button.dataset['title'] ??= button.title)
    const running = job !== null && isRunning(job) ? job : null
    button.textContent = running === null ? label : runningLabel(running, now())
    button.title = running === null ? title : `Show the ${kind} generation`
    button.classList.toggle('gen-running', running !== null)
  }

  const drawDialog = () => {
    // ensureDialog always makes the dialog with its form.
    const form = /** @type {HTMLFormElement} */ (ensureDialog(root).querySelector('form'))
    if (starting || job === null) {
      if (bundle !== null) {
        form.innerHTML = startHtml(bundle, startError, skill)
      }
      return
    }
    form.innerHTML = generationStatusHtml(job, now())
  }

  const schedule = () => {
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = null
    if (!stopped && job !== null && isRunning(job)) {
      timer = setTimeout(() => void poll(), pollMs)
    }
  }

  /** @param {GenerationJob | null} next */
  const update = next => {
    job = next
    drawButton()
    if (dialogOpen() && !starting) {
      drawDialog()
    }
    if (job !== null && isRunning(job)) {
      watching = true
    } else if (job !== null && watching) {
      watching = false
      void opts.onEnded(job)
    }
    schedule()
  }

  const poll = async () => {
    // A page that stopped following the job asks nothing more, even for a poll already queued.
    if (stopped) {
      return
    }
    try {
      update((await fetchGeneration(opts.prNumber, api)).job)
    } catch {
      // A missed poll is tried again; the server keeps the job either way.
      schedule()
    }
  }

  /** @param {boolean} force */
  const start = async force => {
    try {
      const res = await startGeneration(opts.prNumber, force, api)
      startError = null
      starting = false
      update(res.job)
      drawDialog()
    } catch (err) {
      startError =
        err instanceof ApiError
          ? { message: err.message, ...(err.hint === undefined ? {} : { hint: err.hint }) }
          : { message: err instanceof Error ? err.message : String(err) }
      // A run another tab started is the one to show; otherwise the start screen says why the
      // server refused, such as a host login that could not share the canvas.
      await poll()
      starting = job === null || !isRunning(job)
      drawDialog()
    }
  }

  root.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    const action = target?.closest(`#${GENERATE_DIALOG_ID} [data-gen]`)
    if (!(action instanceof HTMLButtonElement)) {
      return
    }
    const act = action.dataset['gen']
    if (act === 'start') {
      // Only the blank-page box is the reader's to decide; with none on screen there is no earlier
      // canvas to update, and a head that has its own canvas the server writes again anyway.
      const box = root.querySelector(`#${GENERATE_DIALOG_ID} input[name="force"]`)
      const force = box instanceof HTMLInputElement && box.checked
      action.disabled = true
      void start(force)
    } else if (act === 'stop') {
      action.disabled = true
      void stopGeneration(opts.prNumber, api).then(
        res => update(res.job),
        err => opts.onError?.(err instanceof Error ? err.message : String(err))
      )
    } else if (act === 'again') {
      startError = null
      starting = true
      drawDialog()
      void readSkill()
    }
  })

  return {
    /**
     * Opens the dialog: the running job when there is one, else the start screen for `next`.
     * @param {B} next
     */
    open(next) {
      bundle = next
      startError = null
      // The project's copy can change between openings, so the last answer is not this one's.
      skill = null
      starting = job === null || !isRunning(job)
      drawDialog()
      showDialog(ensureDialog(root))
      if (starting) {
        void readSkill()
      }
    },
    /**
     * Called after every render: the bundle the screen shows, and the running job put back on the
     * header the render replaced. The first call reads the job the server has, if any.
     * @param {B} next
     */
    attach(next) {
      bundle = next
      drawButton()
      if (job === null && timer === null) {
        void poll()
      }
    },
    /** Shows the status of the job that just ended, on the screen that loaded its canvas. */
    showLast() {
      if (job !== null) {
        starting = false
        drawDialog()
        showDialog(ensureDialog(root))
      }
    },
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = null
    },
    /** @returns {GenerationJob | null} */
    get job() {
      return job
    },
  }
}
