// @ts-check
// The tour page: read the bootstrap, fetch the bundle, and walk the reader through the steps. Every
// step is a history entry, so the browser's back and forward move through the tour and a reload
// lands where the reader was. What the reader answers is saved to the server as they go.
/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourBootstrap} TourBootstrap */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */
/** @typedef {import('../contract-types.js').Decision} Decision */
/** @typedef {import('./steps.js').Step} Step */
import { fetchSharedTour, importTour, saveAppearance, setApiBase } from '../api.js'
import { runCommand, toast, wireCopyCommands } from '../commands.js'
import { exportTourZip } from '../download.js'
import { validateTourFilename } from '../empty-state.js'
import { wireDropZone } from '../import-zone.js'
import { copyToClipboard, esc, qs, scrollIntoViewSafe } from '../dom.js'
import { bannerHtml, errorCardHtml, toEnvelopeError } from '../errors.js'
import { wireEnvBadge } from '../header-bar.js'
import { hostLabel, setHost } from '../host.js'
import { isTypingTarget } from '../keyboard.js'
import { applyTheme, nextTheme, readTheme, themeLabel } from '../theme.js'
import { createGeneration, GENERATE_DIALOG_ID, tourGenerationStartHtml } from '../generate.js'
import { listenToFrames, mountFrames, tellFramesTheme } from './frames.js'
import { createGrill, GRILL_DIALOG_ID } from './grill.js'
import {
  canGenerate,
  codeButtonHtml,
  codeViewHtml,
  coverHtml,
  decisionHtml,
  helpHtml,
  landmarkHtml,
  missingHtml,
  navHtml,
  planHtml,
  quizHtml,
  railHtml,
  staleBarHtml,
  stripHtml,
  tourHeaderHtml,
} from './screens.js'
import { buildSteps, planBasis, reachable, stepFromHash, stepHash, stepIndexOf } from './steps.js'
import { createSaver, fetchTour, finishTour, saveReader } from './tour-api.js'

export const POLL_MS = 5000

/** @returns {TourBootstrap | null} */
function readBootstrap() {
  const el = document.getElementById('bootstrap')
  if (!el?.textContent) {
    return null
  }
  try {
    return /** @type {TourBootstrap} */ (JSON.parse(el.textContent))
  } catch {
    return null
  }
}

/** @param {string} version */
function footerHtml(version) {
  return `<footer><span>pr-review ${esc(version)}</span><span>local review app · ${esc(hostLabel())} operations and AI requests contact their services</span></footer>`
}

export class PrTourElement extends HTMLElement {
  /** @type {TourBootstrap | null} */
  bootstrap = null
  /** @type {TourBundle | null} */
  bundle = null
  /** @type {Step[]} */
  steps = []
  current = 0
  /** @type {import('../theme.js').Theme} */
  theme = 'auto'
  /** @type {ReturnType<typeof createSaver> | null} */
  saver = null
  /** @type {{ stop: () => void } | null} */
  frames = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  poll = null
  /** @type {ReturnType<typeof createGrill> | null} */
  grill = null
  /** @type {(() => void) | null} */
  unwire = null
  /**
   * The tour generation this page starts and follows, kept across renders.
   * @type {ReturnType<typeof createGeneration<TourBundle>> | null}
   */
  generation = null

  connectedCallback() {
    wireCopyCommands(this)
    wireEnvBadge(this)
    void this.boot()
  }

  disconnectedCallback() {
    this.stopPolling()
    this.generation?.stop()
    this.generation = null
    this.grill?.stop()
    this.grill = null
    this.frames?.stop()
    this.frames = null
    this.unwire?.()
    this.unwire = null
  }

  /** The review key as the URL names it, set at boot. */
  key = ''

  async boot() {
    this.bootstrap = readBootstrap()
    if (!this.bootstrap) {
      this.innerHTML = errorCardHtml({ code: 'INTERNAL', message: 'missing bootstrap data' })
      return
    }
    setHost(this.bootstrap.host)
    // The tour's API lives under the project's path on the shared server, as the review's does.
    setApiBase(this.bootstrap.base)
    this.key = String(this.bootstrap.key)
    this.theme = readTheme(document.documentElement)
    /** @type {TourBundle} */
    let bundle
    try {
      bundle = await fetchTour(this.key, { preview: this.bootstrap.preview })
    } catch (err) {
      this.innerHTML = errorCardHtml(toEnvelopeError(err)) + footerHtml(this.bootstrap.version)
      qs('#retry', this)?.addEventListener('click', () => void this.boot())
      return
    }
    this.render(bundle)
    // The home page's generate links land here with `?generate=1`: the dialog opens, and the flag
    // leaves the URL so a reload does not open it again.
    const url = new URL(location.href)
    if (url.searchParams.has('generate')) {
      url.searchParams.delete('generate')
      history.replaceState(history.state, '', url)
      this.generation?.open(bundle)
    }
  }

  /**
   * With an agent to run it, the page generates the tour itself: the header's command, the empty
   * screen's, and the stale bar's open the dialog. The render replaced them, so this runs after each.
   * @param {TourBundle} bundle
   */
  wireGeneration(bundle) {
    if (!canGenerate(bundle)) {
      return
    }
    const generation = (this.generation ??= createGeneration(this, {
      kind: 'tour',
      prNumber: bundle.key,
      startHtml: tourGenerationStartHtml,
      onEnded: job => this.generationEnded(job),
      onError: message => toast(this, message),
    }))
    generation.attach(bundle)
    for (const id of ['#regenerate', '#generate-start', '#stale-generate']) {
      qs(id, this)?.addEventListener('click', () => generation.open(bundle))
    }
  }

  /**
   * The header's export command, which saves the tour on screen, and the empty screen's drop zone,
   * which imports a tour a teammate shared and draws it.
   * @param {TourBundle} bundle
   */
  wireZips(bundle) {
    const exportZip = qs('#export-zip', this)
    const headSha = bundle.tour?.headSha
    if (exportZip instanceof HTMLElement && headSha !== undefined) {
      exportZip.addEventListener('click', () => {
        void runCommand(exportZip, () => exportTourZip(bundle.key, { headSha }), {
          pendingLabel: 'exporting…',
        })
      })
    }
    const fetchShared = qs('#fetch-shared', this)
    if (fetchShared instanceof HTMLElement) {
      fetchShared.addEventListener('click', () => {
        void runCommand(
          fetchShared,
          async () => {
            const result = await fetchSharedTour(bundle.key)
            for (const warning of result.warnings) toast(this, warning)
            if (result.imported) {
              await this.boot()
            } else {
              toast(
                this,
                result.found
                  ? 'the tour shared on the pull request is no newer than this one'
                  : 'no tour is shared on the pull request'
              )
            }
          },
          { pendingLabel: 'looking…' }
        )
      })
    }
    if (typeof bundle.key === 'number') {
      wireDropZone(this, {
        prNumber: bundle.key,
        importImpl: importTour,
        validate: validateTourFilename,
        onImported: result => {
          for (const warning of result.warnings) toast(this, warning)
          void this.boot()
        },
      })
    }
  }

  /**
   * A job this page saw running ended: a published tour is loaded, and the dialog shows how it went
   * when it was open, or when sharing failed; a failure the reader is not looking at is a toast.
   * @param {import('../contract-types.js').GenerationJob} job
   */
  async generationEnded(job) {
    const wasOpen = this.querySelector(`#${GENERATE_DIALOG_ID}`)?.hasAttribute('open') === true
    if (job.phase !== 'done') {
      if (!wasOpen) {
        toast(
          this,
          job.phase === 'cancelled'
            ? 'tour generation stopped'
            : `tour generation failed: ${job.error?.message ?? 'open the generation dialog for details'}`
        )
      }
      return
    }
    const boot = this.bootstrap
    if (boot === null) {
      return
    }
    try {
      this.render(await fetchTour(this.key, { preview: boot.preview }))
    } catch {
      return
    }
    if (wasOpen || job.sharing?.status === 'failed') {
      this.generation?.showLast()
    } else {
      toast(this, 'tour published')
    }
  }

  /** @param {TourBundle} bundle */
  render(bundle) {
    const boot = /** @type {TourBootstrap} */ (this.bootstrap)
    this.stopPolling()
    this.frames?.stop()
    this.grill?.stop()
    this.grill = null
    this.unwire?.()
    this.bundle = bundle
    const now = new Date()
    const project = { slug: boot.project, name: boot.projectName, home: boot.base, reopenIn: boot.reopenIn }
    const header = tourHeaderHtml(bundle, {
      host: location.host,
      theme: this.theme,
      now,
      project,
    })
    const what = bundle.pr.number === null ? bundle.pr.headRef : `#${bundle.pr.number}`
    document.title = `Tour · ${what} ${bundle.pr.title}`
    if (bundle.tour === undefined) {
      this.innerHTML =
        header +
        bannerHtml(bundle.warnings) +
        `<main id="main" class="tour-main"><div class="tour-ticket"><div class="tour-strip">${stripHtml(bundle, [], 0)}</div><div class="tour-stage">${missingHtml(bundle)}</div></div></main>` +
        footerHtml(boot.version)
      this.wireCommands()
      this.startPolling()
      return
    }
    const { headSha } = bundle.tour
    this.steps = buildSteps(bundle.tour, bundle.options)
    this.saver = bundle.preview
      ? null
      : createSaver(reader => saveReader(this.key, headSha, reader), {
          onError: err => toast(this, `could not save your progress: ${toEnvelopeError(err).message}`),
        })
    this.innerHTML =
      header +
      bannerHtml(bundle.warnings) +
      staleBarHtml(bundle) +
      '<div class="tour-rail-wrap" id="rail"></div>' +
      // Each screen is a ticket: a strip that says which stop it is, then the stop itself.
      '<main id="main" class="tour-main"><div class="tour-ticket"><div class="tour-strip" id="strip"></div>' +
      '<section class="tour-stage" id="stage"></section></div></main>' +
      '<nav class="tour-nav" id="nav" aria-label="Tour navigation"></nav>' +
      `<dialog class="tour-chat" id="${GRILL_DIALOG_ID}" aria-label="Something else"></dialog>` +
      '<dialog class="tour-help" id="help-dialog" aria-label="Tour help"></dialog>' +
      footerHtml(boot.version)
    this.frames = listenToFrames(this, { preview: bundle.preview })
    this.grill = createGrill({
      dialog: /** @type {HTMLDialogElement} */ (qs(`#${GRILL_DIALOG_ID}`, this)),
      key: this.key,
      bundle,
      onApprove: (decision, restatement) => {
        this.updatePick(decision, pick => {
          pick.pick = 'other'
          pick.approved = true
          pick.restatement = restatement
        })
        toast(this, 'change approved · in the plan')
      },
      onReader: () => this.save(),
    })
    this.wireCommands()
    this.wireEvents()
    const first = this.firstStep(boot)
    this.current = first
    bundle.reader.step = first
    history.replaceState({ step: first }, '', stepHash(/** @type {Step} */ (this.steps[first])))
    this.renderStep()
  }

  /**
   * Where the tour opens: the landmark the URL names (a preview screenshot), else the step in the
   * URL when the reader may be there, else where they left off.
   * @param {TourBootstrap} boot
   */
  firstStep(boot) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    if (boot.landmark !== undefined) {
      const i = stepIndexOf(this.steps, 'landmark', boot.landmark)
      if (i >= 0) {
        return i
      }
    }
    const fromHash = stepFromHash(this.steps, location.hash)
    if (fromHash >= 0 && (bundle.preview || reachable(this.steps, fromHash, bundle.reader))) {
      return fromHash
    }
    let step = Math.min(Math.max(0, bundle.reader.step), this.steps.length - 1)
    while (step > 0 && !bundle.preview && !reachable(this.steps, step, bundle.reader)) {
      step -= 1
    }
    return step
  }

  /**
   * Moves to a step. Steps past an unsettled decision or an unanswered question stay closed,
   * unless the move is forced: a jump the page offered, or the browser's own history.
   * @param {number} i
   * @param {{ force?: boolean, fromHistory?: boolean }} [opts]
   */
  go(i, opts = {}) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    if (i < 0 || i >= this.steps.length) {
      return
    }
    if (!opts.force && !bundle.preview && !reachable(this.steps, i, bundle.reader)) {
      return
    }
    this.current = i
    bundle.reader.step = i
    this.save()
    this.renderStep()
    window.scrollTo({ top: 0 })
    if (!opts.fromHistory) {
      history.pushState({ step: i }, '', stepHash(/** @type {Step} */ (this.steps[i])))
    }
  }

  /** Draws the current step into the shell `render` put up, with the rail and the nav. */
  renderStep() {
    const bundle = /** @type {TourBundle & { tour: import('../contract-types.js').TourPageTour }} */ (
      this.bundle
    )
    const stage = /** @type {HTMLElement} */ (qs('#stage', this))
    const rail = /** @type {HTMLElement} */ (qs('#rail', this))
    const strip = /** @type {HTMLElement} */ (qs('#strip', this))
    const nav = /** @type {HTMLElement} */ (qs('#nav', this))
    const step = /** @type {Step} */ (this.steps[this.current])
    // The kind of step on screen, for the layout: the cover drops the header's title.
    this.dataset['at'] = step.kind
    if (step.kind === 'landmark' && bundle.reader.seen[step.landmark.id] !== true) {
      bundle.reader.seen[step.landmark.id] = true
      this.save()
    }
    if (step.kind === 'cover') {
      stage.innerHTML = coverHtml(bundle)
    } else if (step.kind === 'landmark') {
      stage.innerHTML = landmarkHtml(bundle, this.steps, step.landmark)
      mountFrames(stage, {
        base: /** @type {TourBootstrap} */ (this.bootstrap).base,
        key: this.key,
        headSha: bundle.tour.headSha,
        preview: bundle.preview,
        theme: this.theme,
      })
    } else if (step.kind === 'decision') {
      stage.innerHTML = decisionHtml(bundle, this.steps, step.decision)
    } else if (step.kind === 'quiz') {
      stage.innerHTML = quizHtml(bundle, step.q)
    } else {
      stage.innerHTML = planHtml(bundle)
    }
    strip.innerHTML = stripHtml(bundle, this.steps, this.current)
    rail.innerHTML = railHtml(this.steps, this.current, bundle.reader, bundle.tour, {
      preview: bundle.preview,
    })
    nav.innerHTML = navHtml(this.steps, this.current, bundle.reader)
  }

  /** Queues the reader's state for the server. A preview saves nothing. */
  save() {
    const bundle = this.bundle
    if (bundle === null || this.saver === null) {
      return
    }
    this.saver.push(structuredClone(bundle.reader))
  }

  /** @returns {(Step & { kind: 'decision' }) | null} */
  decisionStep() {
    const step = this.steps[this.current]
    return step !== undefined && step.kind === 'decision' ? step : null
  }

  /**
   * @param {Decision} d
   * @param {(pick: import('../contract-types.js').ReaderPick) => void} update
   */
  updatePick(d, update) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    const pick = bundle.reader.picks[d.key] ?? { pick: d.recommended, approved: false }
    update(pick)
    bundle.reader.picks[d.key] = pick
    this.save()
    this.renderStep()
  }

  /**
   * Settles a decision on one of its two sides.
   * @param {Decision} d
   * @param {'keep' | 'change'} side
   */
  choose(d, side) {
    this.updatePick(d, pick => {
      pick.pick = side
      pick.approved = true
      delete pick.restatement
    })
  }

  /**
   * Opens the drawer on something else. A restatement approved before stays approved until another
   * one is: reopening is to read or continue the conversation, not to take the change back.
   * @param {Decision} d
   */
  openGrill(d) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    this.updatePick(d, pick => {
      if (pick.pick !== 'other') {
        pick.pick = 'other'
        pick.approved = false
      }
    })
    void this.grill?.open(d, bundle.reader.picks[d.key]?.restatement)
  }

  /**
   * Opens or closes the code behind a landmark, and scrolls to it when it opens. It changes the
   * code in place: drawing the step again would reload its scenes.
   * @param {string} id
   */
  toggleCode(id) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    const open = bundle.reader.codeOpen[id] !== true
    bundle.reader.codeOpen[id] = open
    this.save()
    const code = /** @type {HTMLElement} */ (qs('.tour-code', this))
    code.hidden = !open
    const button = /** @type {HTMLElement} */ (qs('[data-act="code"]', this))
    button.innerHTML = codeButtonHtml(open)
    if (open) {
      scrollIntoViewSafe(code, 'start')
    }
  }

  /**
   * Switches the code behind a landmark between its literate and raw diff, in place like
   * `toggleCode`.
   * @param {import('../contract-types.js').TourPageLandmark} landmark
   * @param {'literate' | 'raw'} view
   */
  showCodeView(landmark, view) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    bundle.reader.codeView[landmark.id] = view
    this.save()
    for (const tab of this.querySelectorAll('.tour-code-tab')) {
      tab.setAttribute('aria-selected', String(tab instanceof HTMLElement && tab.dataset['view'] === view))
    }
    const body = /** @type {HTMLElement} */ (qs('.tour-code-body', this))
    body.innerHTML = codeViewHtml(landmark, view)
  }

  openHelp() {
    const dialog = /** @type {HTMLDialogElement} */ (qs('#help-dialog', this))
    dialog.innerHTML = helpHtml()
    dialog.showModal()
  }

  /**
   * Jumps somewhere the page offers a way back from.
   * @param {number} i
   */
  jumpTo(i) {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    if (i < 0) {
      return
    }
    bundle.reader.returnTo = this.current
    this.go(i, { force: true })
  }

  returnBack() {
    const bundle = /** @type {TourBundle} */ (this.bundle)
    const i = bundle.reader.returnTo
    bundle.reader.returnTo = null
    if (i !== null) {
      this.go(i, { force: true })
    }
  }

  /** @param {number} i */
  answer(i) {
    const step = this.steps[this.current]
    const bundle = /** @type {TourBundle} */ (this.bundle)
    if (step === undefined || step.kind !== 'quiz' || bundle.reader.quiz[step.q.id]?.right === true) {
      return
    }
    if (i < 0 || i >= step.q.options.length) {
      return
    }
    bundle.reader.quiz[step.q.id] = { answered: i, right: i === step.q.answer }
    this.save()
    this.renderStep()
  }

  /** @param {HTMLElement} button */
  async confirm(button) {
    const bundle = /** @type {TourBundle & { tour: import('../contract-types.js').TourPageTour }} */ (
      this.bundle
    )
    button.setAttribute('disabled', '')
    button.textContent = 'writing the prompt…'
    try {
      await this.saver?.settle()
      const result = await finishTour(this.key, bundle.tour.headSha, planBasis(bundle.tour, bundle.reader))
      bundle.reader = result.reader
      bundle.tour.record = result.record
      this.renderStep()
      const sharing = result.finished.sharing
      toast(
        this,
        sharing.status === 'shared'
          ? 'prompt written · record shared on the pull request'
          : sharing.status === 'failed'
            ? `prompt written · ${sharing.warning}`
            : 'prompt written'
      )
    } catch (err) {
      const error = toEnvelopeError(err)
      toast(this, error.hint === undefined ? error.message : `${error.message} · ${error.hint}`)
      this.renderStep()
    }
  }

  /**
   * @param {HTMLElement} button
   * @param {string} text
   */
  async copyPrompt(button, text) {
    try {
      await copyToClipboard(text)
      button.textContent = 'copied'
    } catch {
      toast(this, 'clipboard is not available; select the prompt and copy it')
    }
  }

  wireEvents() {
    /** @param {Event} e */
    const onClick = e => {
      const target =
        e.target instanceof Element ? e.target.closest('[data-act], [data-nav], .tour-rail-seg') : null
      if (!(target instanceof HTMLElement)) {
        return
      }
      const bundle = /** @type {TourBundle} */ (this.bundle)
      const act = target.dataset['act']
      if (target.dataset['nav'] !== undefined) {
        e.preventDefault()
        this.go(this.current + (target.dataset['nav'] === 'next' ? 1 : -1))
        return
      }
      if (target.classList.contains('tour-rail-seg')) {
        this.go(Number(target.dataset['step']))
        return
      }
      const step = this.steps[this.current]
      const decision = this.decisionStep()?.decision ?? null
      if (act === 'help') {
        this.openHelp()
      } else if (act === 'close-help') {
        ;/** @type {HTMLDialogElement} */ (qs('#help-dialog', this)).close()
      } else if (act === 'grill-plan') {
        void this.grill?.openPlan()
      } else if (act === 'code' && step?.kind === 'landmark') {
        this.toggleCode(step.landmark.id)
      } else if (act === 'code-view' && step?.kind === 'landmark') {
        this.showCodeView(step.landmark, target.dataset['view'] === 'raw' ? 'raw' : 'literate')
      } else if (act === 'landmark') {
        e.preventDefault()
        this.jumpTo(stepIndexOf(this.steps, 'landmark', target.dataset['landmark'] ?? ''))
      } else if (act === 'reopen' && step?.kind === 'quiz') {
        delete bundle.reader.quiz[step.q.id]
        this.jumpTo(stepIndexOf(this.steps, 'landmark', target.dataset['landmark'] ?? ''))
      } else if (act === 'jump') {
        this.jumpTo(stepIndexOf(this.steps, 'decision', target.dataset['decision'] ?? ''))
      } else if (act === 'return') {
        this.returnBack()
      } else if (act === 'pick' && decision !== null) {
        const chosen = target.dataset['pick']
        if (chosen === 'other') {
          this.openGrill(decision)
        } else {
          this.choose(decision, chosen === 'change' ? 'change' : 'keep')
        }
      } else if (act === 'unsettle' && decision !== null) {
        delete bundle.reader.picks[decision.key]
        this.save()
        this.renderStep()
      } else if (act === 'grill' && decision !== null) {
        this.openGrill(decision)
      } else if (act === 'answer') {
        this.answer(Number(target.dataset['i']))
      } else if (act === 'confirm') {
        void this.confirm(target)
      } else if (act === 'copy') {
        void this.copyPrompt(target, /** @type {HTMLElement} */ (qs('#prompt', this)).textContent ?? '')
      }
    }
    /** @param {Event} e */
    const onInput = e => {
      const target = e.target
      if (target instanceof HTMLTextAreaElement && target.dataset['act'] === 'note') {
        const bundle = /** @type {TourBundle} */ (this.bundle)
        bundle.reader.notes[/** @type {string} */ (target.dataset['landmark'])] = target.value
        this.save()
      }
    }
    /** @param {Event} e */
    const onChange = e => {
      const target = e.target
      const decision = this.decisionStep()?.decision ?? null
      if (decision === null) {
        return
      }
      if (target instanceof HTMLInputElement && target.dataset['act'] === 'tried') {
        const tried = target.checked
        const bundle = /** @type {TourBundle} */ (this.bundle)
        const pick = bundle.reader.picks[decision.key] ?? { pick: decision.recommended, approved: false }
        pick.tried = tried
        bundle.reader.picks[decision.key] = pick
        this.save()
      }
    }
    /** @param {KeyboardEvent} e */
    const onKeydown = e => {
      if (e.key === 'Escape' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) {
        return
      }
      if (this.querySelector('dialog[open]') !== null) {
        return
      }
      const step = this.steps[this.current]
      const decision = this.decisionStep()?.decision ?? null
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        this.go(this.current + 1)
      } else if (e.key === 'ArrowLeft') {
        this.go(this.current - 1)
      } else if (e.key === 'i' && step?.kind === 'landmark' && step.landmark.code.length > 0) {
        this.toggleCode(step.landmark.id)
      } else if (e.key === 'k' && decision !== null) {
        this.choose(decision, 'keep')
      } else if (e.key === 'a' && decision !== null) {
        this.choose(decision, 'change')
      } else if (e.key === 'c' && decision !== null) {
        this.openGrill(decision)
      } else if (/^[1-9]$/.test(e.key) && step?.kind === 'quiz') {
        this.answer(Number(e.key) - 1)
      } else if (e.key === '?') {
        this.openHelp()
      }
    }
    /** @param {PopStateEvent} e */
    const onPopstate = e => {
      const state = /** @type {{ step?: unknown } | null} */ (e.state)
      const i = typeof state?.step === 'number' ? state.step : stepFromHash(this.steps, location.hash)
      if (i >= 0 && i < this.steps.length) {
        this.go(i, { force: true, fromHistory: true })
      }
    }
    this.addEventListener('click', onClick)
    this.addEventListener('input', onInput)
    this.addEventListener('change', onChange)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('popstate', onPopstate)
    this.unwire = () => {
      this.removeEventListener('click', onClick)
      this.removeEventListener('input', onInput)
      this.removeEventListener('change', onChange)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('popstate', onPopstate)
    }
  }

  wireCommands() {
    if (this.bundle !== null) {
      this.wireGeneration(this.bundle)
      this.wireZips(this.bundle)
    }
    const toggle = qs('#theme-toggle', this)
    toggle?.addEventListener('click', () => {
      this.theme = nextTheme(this.theme)
      applyTheme(this.theme, document.documentElement)
      toggle.textContent = themeLabel(this.theme)
      tellFramesTheme(this, this.theme)
      // Written to `.pr-review/settings.yml`; the tour has no skin of its own to save.
      void saveAppearance({ theme: this.theme }).catch(() =>
        toast(this, 'could not save the theme to settings.yml')
      )
    })
  }

  /** A tour published from the harness shows up here without a reload. */
  startPolling() {
    this.stopPolling()
    const boot = this.bootstrap
    if (boot === null) {
      return
    }
    this.poll = setTimeout(async () => {
      this.poll = null
      try {
        const next = await fetchTour(this.key, { preview: boot.preview, poll: true })
        if (next.tour !== undefined) {
          this.render(next)
          return
        }
      } catch {
        // Try again on the next tick.
      }
      this.startPolling()
    }, POLL_MS)
  }

  stopPolling() {
    if (this.poll !== null) {
      clearTimeout(this.poll)
      this.poll = null
    }
  }
}

if (!customElements.get('pr-tour')) {
  customElements.define('pr-tour', PrTourElement)
}
