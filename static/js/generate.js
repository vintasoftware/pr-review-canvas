// @ts-check
// Generating the canvas from the page: the dialog that starts a run and shows where it is. The
// server runs the job and keeps it across reloads; the page only polls it, and loads the new
// canvas once the job publishes one. While a job runs, the header's generate command shows it and
// opens its dialog.
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').ReviewKey} ReviewKey */
/** @typedef {import('./contract-types.js').GenerationJob} GenerationJob */
/** @typedef {import('./contract-types.js').GenerationResponse} GenerationResponse */
import { ApiError, fetchJson } from './api.js'
import { esc } from './dom.js'
import { hostLabel } from './host.js'

export const GENERATE_DIALOG_ID = 'generate-dialog'
export const GENERATION_POLL_MS = 2000

/** @type {Record<GenerationJob['phase'], string>} */
const PHASE_LABELS = {
  preparing: 'Preparing the diff',
  checkout: 'Checking out the head',
  generating: 'The agent is writing the canvas',
  publishing: 'Validating and publishing',
  repairing: 'The agent is fixing what publish rejected',
  done: 'Done',
  failed: 'Generation failed',
  cancelled: 'Generation stopped',
}

/** @param {Pick<GenerationJob, 'phase'>} job */
export function isRunning(job) {
  return job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled'
}

/**
 * True when the skill command the server built regenerates the head's own canvas.
 * @param {string} command
 */
export function forceOf(command) {
  return /\s--force$/.test(command)
}

/**
 * How long the job has run, as `3m 12s`.
 * @param {Pick<GenerationJob, 'startedAt' | 'endedAt'>} job
 * @param {Date} now
 */
export function elapsedText(job, now) {
  const end = job.endedAt === undefined ? now.getTime() : Date.parse(job.endedAt)
  const seconds = Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * What a start from this screen does: generate the first canvas, update an outdated one from
 * where it is, or write the current one again. `choice` is true when the reader may pick between
 * updating and a blank page; `force` is the default.
 * @param {PrBundle} bundle
 * @returns {{ title: string, text: string, force: boolean, choice: boolean }}
 */
export function generationMode(bundle) {
  const sameHead = forceOf(bundle.skillCommand)
  if (bundle.status === 'stale') {
    return {
      title: 'Update the canvas',
      text: 'The agent updates the canvas of the earlier commit for the current head. What the new commits left untouched is carried over, and review progress on it follows.',
      force: false,
      choice: true,
    }
  }
  if (bundle.status === 'ready') {
    return {
      title: 'Regenerate the canvas',
      text: 'The agent writes the canvas for the current head again. The current canvas stays until the new one is published.',
      force: true,
      choice: !sameHead,
    }
  }
  return {
    title: 'Generate the canvas',
    text: 'The agent reads the diff and writes the canvas. It usually takes several minutes.',
    force: sameHead,
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
 * @param {string} command
 */
function skillFallbackHtml(command) {
  return (
    '<p class="hint">Or run it yourself in Claude Code or Codex from this repo:</p>' +
    `<div class="cmdbox"><code>${esc(command)}</code><button class="cmd" type="button" data-copy="${esc(command)}">copy</button></div>`
  )
}

/**
 * The screen that starts a run, with why the server refused the last start when it did.
 * @param {PrBundle} bundle
 * @param {{ message: string, hint?: string } | null} [refused]
 * @returns {string}
 */
export function generationStartHtml(bundle, refused = null) {
  const mode = generationMode(bundle)
  const agent = bundle.chat.agent ? `<strong>${esc(bundle.chat.agent)}</strong>` : 'the chat agent'
  const choice = mode.choice
    ? `<label class="gen-force"><input type="checkbox" name="force"${mode.force ? ' checked' : ''}> Start from a blank page instead of updating the earlier canvas</label>`
    : ''
  return (
    `<h2 id="gen-h">${mode.title}</h2>` +
    (refused === null
      ? ''
      : `<div class="callout warn" role="alert">${esc(refused.message)}${refused.hint ? ` — ${esc(refused.hint)}` : ''}</div>`) +
    `<p class="hint">${esc(mode.text)}</p>` +
    `<p class="hint">It runs ${agent} through acpx with the chat's permissions, which deny writes, and the model the project config names for it. ${sharingNote(bundle)}</p>` +
    choice +
    skillFallbackHtml(bundle.skillCommand) +
    '<div class="dialog-actions">' +
    '<button class="cmd" type="submit" value="close">cancel</button>' +
    `<button class="cmd fill" type="button" data-gen="start" data-force="${mode.force ? '1' : '0'}">start</button>` +
    '</div>'
  )
}

/**
 * What a done job did, in a sentence.
 * @param {GenerationJob} job
 */
function outcomeHtml(job) {
  if (job.outcome === 'exists') {
    return '<p class="hint">A canvas already exists for this commit, so nothing was generated. Regenerate it to write it again.</p>'
  }
  const sharing = job.sharing
  if (sharing?.status === 'shared') {
    return `<p class="hint">The canvas is published and <a href="${esc(sharing.url)}" target="_blank" rel="noopener noreferrer">shared on ${esc(hostLabel())}</a>.</p>`
  }
  if (sharing?.status === 'failed') {
    return (
      `<div class="callout warn" role="status">The canvas is published here, but sharing it failed: ${esc(sharing.warning)}` +
      ` Upload <code>${esc(sharing.zipPath)}</code> to the description by hand so reviewers get it.</div>`
    )
  }
  if (sharing?.status === 'off') {
    return '<p class="hint">The canvas is published. The project config keeps canvases local, so nothing was posted.</p>'
  }
  return '<p class="hint">The canvas is published.</p>'
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
  const label = job.stopping && running ? 'Stopping…' : PHASE_LABELS[job.phase]
  const activity =
    job.activity.length === 0
      ? ''
      : `<ol class="gen-activity" aria-label="Latest agent tool calls">${job.activity.map(a => `<li>${esc(a)}</li>`).join('')}</ol>`
  const problems =
    job.problems === undefined || job.problems.length === 0
      ? ''
      : `<details class="gen-problems"${job.phase === 'failed' ? ' open' : ''}><summary>${job.problems.length} problem${job.problems.length === 1 ? '' : 's'} publish named</summary><ul>${job.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></details>`
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
      ? '<p class="hint">You can close this dialog; the run goes on. The page loads the canvas when it is published.</p>'
      : '') +
    error +
    done +
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

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch | undefined }} [opts]
 * @returns {Promise<GenerationResponse>}
 */
export function fetchGeneration(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/generate`, { fetchImpl: opts.fetchImpl })
}

/**
 * @param {ReviewKey} prNumber
 * @param {boolean} force
 * @param {{ fetchImpl?: typeof fetch | undefined }} [opts]
 * @returns {Promise<GenerationResponse>}
 */
export function startGeneration(prNumber, force, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/generate`, {
    method: 'POST',
    body: { force },
    fetchImpl: opts.fetchImpl,
  })
}

/**
 * @param {ReviewKey} prNumber
 * @param {{ fetchImpl?: typeof fetch | undefined }} [opts]
 * @returns {Promise<{ cancelled: boolean, job: GenerationJob | null }>}
 */
export function stopGeneration(prNumber, opts = {}) {
  return fetchJson(`/api/prs/${prNumber}/generate`, { method: 'DELETE', fetchImpl: opts.fetchImpl })
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
 * The page's side of generation: one per review page, kept across renders.
 * @param {HTMLElement} root
 * @param {{
 *   prNumber: ReviewKey,
 *   onEnded: (job: GenerationJob) => void | Promise<void>,
 *   onError?: (message: string) => void,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date,
 *   pollMs?: number,
 * }} opts
 */
export function createGeneration(root, opts) {
  const now = opts.now ?? (() => new Date())
  const pollMs = opts.pollMs ?? GENERATION_POLL_MS
  const api = { fetchImpl: opts.fetchImpl }
  /** @type {GenerationJob | null} */
  let job = null
  /** @type {PrBundle | null} */
  let bundle = null
  /** The dialog shows the start screen rather than a job. */
  let starting = false
  /**
   * Why the server refused the last start, shown on the start screen until the next try.
   * @type {{ message: string, hint?: string } | null}
   */
  let startError = null
  /** True once this page saw the job running, so its end is news to it. */
  let watching = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let stopped = false

  const dialogOpen = () => root.querySelector(`#${GENERATE_DIALOG_ID}`)?.hasAttribute('open') === true

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
    button.title = running === null ? title : 'Show the canvas generation'
    button.classList.toggle('gen-running', running !== null)
  }

  const drawDialog = () => {
    // ensureDialog always makes the dialog with its form.
    const form = /** @type {HTMLFormElement} */ (ensureDialog(root).querySelector('form'))
    if (starting || job === null) {
      if (bundle !== null) {
        form.innerHTML = generationStartHtml(bundle, startError)
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
    const kind = action.dataset['gen']
    if (kind === 'start') {
      const box = root.querySelector(`#${GENERATE_DIALOG_ID} input[name="force"]`)
      const force = box instanceof HTMLInputElement ? box.checked : action.dataset['force'] === '1'
      action.disabled = true
      void start(force)
    } else if (kind === 'stop') {
      action.disabled = true
      void stopGeneration(opts.prNumber, api).then(
        res => update(res.job),
        err => opts.onError?.(err instanceof Error ? err.message : String(err))
      )
    } else if (kind === 'again') {
      startError = null
      starting = true
      drawDialog()
    }
  })

  return {
    /**
     * Opens the dialog: the running job when there is one, else the start screen for `next`.
     * @param {PrBundle} next
     */
    open(next) {
      bundle = next
      startError = null
      starting = job === null || !isRunning(job)
      drawDialog()
      showDialog(ensureDialog(root))
    },
    /**
     * Called after every render: the bundle the screen shows, and the running job put back on the
     * header the render replaced. The first call reads the job the server has, if any.
     * @param {PrBundle} next
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
