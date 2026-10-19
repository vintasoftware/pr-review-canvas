// @ts-check
// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
// The tour page end to end in happy-dom, against a fake server: the walk through the steps, the
// picks, the quiz, the plan, the history, and the looks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshReaderState } from '../../../src/contract/tour-api.js'
import { missingTourBundle, syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { POLL_MS, PrTourElement } from './tour.js'

const HEAD = 'a'.repeat(40)

/** @type {import('../contract-types.js').GenerationJob} */
const TOUR_JOB = {
  kind: 'tour',
  key: 42,
  force: false,
  agent: 'claude',
  model: 'opus',
  skill: { source: 'default', version: '0.0.0-test' },
  phase: 'done',
  round: 1,
  maxRounds: 4,
  startedAt: '2026-10-16T12:00:00.000Z',
  activity: [],
  headSha: HEAD,
  sharing: { status: 'off' },
}

/** @typedef {import('../contract-types.js').TourBundle} TourBundle */
/** @typedef {import('../contract-types.js').TourReaderState} TourReaderState */

/**
 * A fake server: the bundle it answers with, the reader states it was sent, and the finishes.
 * @param {TourBundle | (() => TourBundle)} bundle
 * @param {{ finish?: () => Response, save?: () => Response, fail?: boolean, shared?: () => unknown }} [opts]
 */
function fakeServer(bundle, opts = {}) {
  /** @type {TourReaderState[]} */
  const saved = []
  /** @type {string[]} */
  const calls = []
  /** @type {Array<{ headSha: string, basis?: string }>} */
  const finishes = []
  const impl = /** @type {typeof fetch} */ (
    async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const json = (/** @type {unknown} */ body, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      // With an agent on, the page asks once whether a tour generation runs; none does here. The
      // generation's own calls are generate.test.js's to check, so they stay out of `calls`.
      if (url.endsWith('/generate') && method === 'GET') {
        return json({ job: null })
      }
      calls.push(`${method} ${url}`)
      if (opts.fail) {
        return json({ error: { code: 'PR_NOT_FOUND', message: 'no such pull request', hint: 'check' } }, 404)
      }
      if (url.endsWith('/shared-tour/fetch') && method === 'POST') {
        return json(opts.shared?.() ?? { found: false, imported: false, warnings: [] })
      }
      if (url.includes('/export')) {
        return new Response(new Uint8Array([80, 75]), {
          headers: { 'content-disposition': 'attachment; filename="pr-42-x-tour.zip"' },
        })
      }
      if (url.endsWith('/generate') && method === 'POST') {
        return json({ job: { ...TOUR_JOB, phase: 'preparing' } }, 202)
      }
      if (url.endsWith('/grill/history')) {
        return json({ name: 't0', turns: [] })
      }
      if (url.startsWith('/r/acme/widgets/api/tours/') && method === 'GET') {
        return json(typeof bundle === 'function' ? bundle() : bundle)
      }
      if (url.endsWith('/reader') && method === 'PUT') {
        const body = JSON.parse(String(init?.body))
        saved.push(body.reader)
        return opts.save?.() ?? json(body.reader)
      }
      if (url.endsWith('/finish') && method === 'POST') {
        if (opts.finish) {
          return opts.finish()
        }
        const reader = saved.at(-1) ?? freshReaderState()
        finishes.push(JSON.parse(String(init?.body)))
        const finished = {
          at: '2026-09-10T12:00:00.000Z',
          promptPath: '/data/tours/x/plan-prompt.md',
          prompt: '# Keep PR #42 as the tour settled it',
          sharing: { status: 'shared', url: 'https://github.com/acme/widgets/pull/42#issuecomment-1' },
          basis: JSON.parse(String(init?.body)).basis,
        }
        return json({ finished, record: { touredBy: [] }, reader: { ...reader, finished } })
      }
      if (url.endsWith('/api/appearance')) {
        return json(JSON.parse(String(init?.body)))
      }
      if (url.endsWith('/grill') && method === 'POST') {
        const frames =
          'event: turn\ndata: {"thread":"t0","agent":"claude","seeded":true}\n\n' +
          'event: chunk\ndata: {"text":"```plan\\n{ \\"changes\\": [], \\"kept\\": [\\"sum-over-product\\"] }\\n```"}\n\n' +
          'event: done\ndata: {"stopReason":"end_turn"}\n\n'
        return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return json({ error: { code: 'NOT_FOUND', message: url } }, 404)
    }
  )
  return { impl, saved, calls, finishes }
}

/**
 * @param {Partial<import('../contract-types.js').TourBootstrap>} [over]
 */
function mount(over = {}) {
  const bootstrap = {
    key: 42,
    owner: 'acme',
    repo: 'widgets',
    base: '/r/acme/widgets/',
    project: 'acme/widgets',
    version: '0.0.0-test',
    host: { kind: 'github', label: 'GitHub', webBase: 'https://github.com' },
    preview: false,
    ...over,
  }
  document.body.innerHTML = `<script id="bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script><pr-tour class="page tour-page"></pr-tour>`
  const el = document.querySelector('pr-tour')
  if (!(el instanceof PrTourElement)) {
    throw new Error('no element')
  }
  return el
}

/** Waits for the page to draw something matching `selector`. */
/** @param {string} selector */
async function drawn(selector) {
  await vi.waitFor(() => {
    if (document.querySelector(selector) === null) {
      throw new Error(`no ${selector}`)
    }
  })
  return /** @type {HTMLElement} */ (document.querySelector(selector))
}

/** @param {string} selector */
function click(selector) {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`nothing to click at ${selector}`)
  }
  el.click()
}

/** @param {string} key */
function press(key) {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function text() {
  return document.body.textContent ?? ''
}

beforeEach(() => {
  window.scrollTo = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
  history.replaceState(null, '', '/tour/42')
})

afterEach(async () => {
  // A save still queued would go out through the next test's fake server.
  for (const el of document.querySelectorAll('pr-tour')) {
    if (el instanceof PrTourElement) {
      await el.saver?.settle()
    }
  }
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the tour page', () => {
  it('walks from the cover through the landmarks, a keep, the quiz, and the plan, saving as it goes', async () => {
    const server = fakeServer(syntheticTourBundle())
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
    await drawn('.tour-cover-actions')
    expect(document.title).toBe('Tour · #42 feat: add b')
    expect(location.hash).toBe('#cover')
    expect(document.querySelector('.tour-rail-seg[data-state="current"]')?.getAttribute('data-step')).toBe(
      '0'
    )

    click('[data-nav="next"]')
    expect(document.querySelector('.tour-stage-tag')?.textContent).toBe('Before this change')
    expect(location.hash).toBe('#landmark-before')
    expect(document.querySelector('iframe.tour-frame')?.getAttribute('src')).toContain(
      `/tour-scene/42/before/scene?theme=auto&headSha=${HEAD}`
    )
    expect(window.scrollTo).toHaveBeenCalled()

    // The keys move too, and `i` opens the code behind a landmark that has some and scrolls to it.
    press('ArrowRight')
    expect(location.hash).toBe('#landmark-world')
    // It opens in place, so the scenes do not reload.
    const frame = document.querySelector('iframe.tour-frame')
    expect(frame).not.toBeNull()
    press('i')
    expect(document.querySelector('.tour-code')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('iframe.tour-frame')).toBe(frame)
    expect(vi.mocked(Element.prototype.scrollIntoView).mock.contexts).toEqual([
      document.querySelector('.tour-code'),
    ])
    click('.tour-code-tab[data-view="raw"]')
    expect(document.querySelector('.tour-code-tab[aria-selected="true"]')?.textContent).toBe('raw diff')
    expect(document.querySelector('.tour-code-body .tour-literate')).toBeNull()
    expect(document.querySelector('iframe.tour-frame')).toBe(frame)
    click('[data-act="code"]')
    expect(document.querySelector('.tour-code')?.hasAttribute('hidden')).toBe(true)

    // A note is saved as typed, with the rest of the state.
    const note = await drawn('textarea[data-act="note"]')
    if (!(note instanceof HTMLTextAreaElement)) {
      throw new Error('no note')
    }
    note.value = 'rename b'
    note.dispatchEvent(new Event('input', { bubbles: true }))
    press(' ')
    press('ArrowLeft')
    expect(location.hash).toBe('#landmark-world')
    press('ArrowRight')
    press('ArrowRight')
    expect(location.hash).toBe('#landmark-respect')
    // A landmark with no code ignores `i`.
    press('i')
    expect(document.querySelector('.tour-code')).toBeNull()
    press('Enter')
    expect(location.hash).toBe('#decision-sum-over-product')
    // Next stays closed until the decision is settled; the rail says so too.
    press('ArrowRight')
    expect(location.hash).toBe('#decision-sum-over-product')
    expect(document.querySelector('.tour-rail-seg[data-step="6"]')?.getAttribute('data-state')).toBe('ahead')
    click('.tour-rail-seg[data-step="6"]')
    expect(location.hash).toBe('#decision-sum-over-product')

    // Nothing is chosen at first. `k` keeps and `a` takes the alternative, each settling it; undo
    // takes the pick back, and a click on the decision's text leaves it alone.
    const chosen = () =>
      document.querySelector('.tour-option[aria-checked="true"]')?.getAttribute('data-pick')
    expect(chosen()).toBeUndefined()
    press('k')
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept')
    click('[data-act="unsettle"]')
    expect(chosen()).toBeUndefined()
    press('a')
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ alternative · in the plan')
    click('.tour-lead')
    expect(chosen()).toBe('change')
    click('[data-act="unsettle"]')
    press('ArrowRight')
    expect(location.hash).toBe('#decision-sum-over-product')
    click('.tour-option[data-pick="keep"]')
    expect(chosen()).toBe('keep')
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept')
    click('[data-nav="next"]')
    expect(location.hash).toBe('#quiz-q-run')

    // A wrong answer reopens the landmark it came from, with the way back.
    press('1')
    expect(document.querySelector('.tour-quiz-why.wrong')).not.toBeNull()
    click('[data-act="reopen"]')
    expect(location.hash).toBe('#landmark-world')
    expect(document.querySelector('.tour-return')?.textContent).toContain('Reopened from the quiz')
    click('[data-act="return"]')
    expect(location.hash).toBe('#quiz-q-run')
    expect(document.querySelector('.tour-quiz-why')).toBeNull()
    click('.tour-quiz-opt[data-i="1"]')
    expect(document.querySelector('.tour-quiz-why.right')).not.toBeNull()
    press('9')
    click('[data-nav="next"]')
    expect(location.hash).toBe('#plan')
    expect(document.querySelector('.tour-title')?.textContent).toBe('Nothing to change. 1 decision kept.')
    expect(text()).toContain('rename b')

    // Confirming waits for the saves, then shows the prompt and where it went.
    click('[data-act="confirm"]')
    await drawn('#prompt')
    expect(document.querySelector('#prompt')?.textContent).toBe('# Keep PR #42 as the tour settled it')
    expect(document.querySelector('.toast')?.textContent).toBe(
      'prompt written · record shared on the pull request'
    )
    expect(server.calls.filter(c => c.startsWith('POST'))).toEqual([
      'POST /r/acme/widgets/api/tours/42/finish',
    ])
    const last = server.saved.at(-1)
    expect(last?.notes).toEqual({ world: 'rename b' })
    expect(last?.picks).toEqual({ 'sum-over-product': { pick: 'keep', approved: true } })
    expect(last?.quiz).toEqual({ 'q-run': { answered: 1, right: true } })
    expect(last?.step).toBe(7)
    expect(server.calls.filter(c => c.startsWith('PUT')).length).toBeLessThan(server.calls.length)

    // Copying the prompt.
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    click('[data-act="copy"]')
    await vi.waitFor(() => expect(document.querySelector('[data-act="copy"]')?.textContent).toBe('copied'))
    expect(writeText).toHaveBeenCalledWith('# Keep PR #42 as the tour settled it')

    // A pick changed after confirming leaves the prompt behind: the plan asks to confirm again.
    expect(text()).not.toContain('confirm again')
    expect(document.querySelector('.tour-rail-seg[data-step="7"]')?.getAttribute('data-state')).toBe(
      'current'
    )
    click('.tour-rail-seg[data-step="5"]')
    click('[data-act="unsettle"]')
    press('a')
    click('.tour-rail-seg[data-step="7"]')
    expect(document.querySelector('.tour-plan-changed')?.textContent).toContain('You changed the plan')
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('confirm again')
    expect(text()).toContain('Confirmed before')
    click('[data-act="confirm"]')
    await vi.waitFor(() => expect(server.finishes).toHaveLength(2))
    expect(JSON.parse(server.finishes[1]?.basis ?? '{}').picks).toEqual([
      ['sum-over-product', 'change', null],
    ])
    await vi.waitFor(() => expect(document.querySelector('.tour-plan-changed')).toBeNull())
    el.remove()
  })

  it('takes something else through the drawer, stays on it once approved, and the plan lists it', async () => {
    const server = fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 5 } }))
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('.tour-options')
    expect(location.hash).toBe('#decision-sum-over-product')
    press('c')
    const dialog = document.querySelector('#tour-grill')
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error('no dialog')
    }
    expect(dialog.open).toBe(true)
    // Keys stay quiet while the drawer is open.
    press('ArrowRight')
    expect(location.hash).toBe('#decision-sum-over-product')
    const form = dialog.querySelector('form')
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('no form')
    }
    // Submitting with a field empty settles nothing.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(dialog.open).toBe(true)
    const what = form.querySelector('textarea[name="what"]')
    const unchanged = form.querySelector('textarea[name="unchanged"]')
    if (!(what instanceof HTMLTextAreaElement && unchanged instanceof HTMLTextAreaElement)) {
      throw new Error('no field')
    }
    what.value = 'Multiply.'
    unchanged.value = 'The callers.'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(dialog.open).toBe(false)
    // An approved restatement settles the decision; the reader moves on when ready.
    expect(location.hash).toBe('#decision-sum-over-product')
    expect(document.querySelector('.tour-option[aria-checked="true"]')?.getAttribute('data-pick')).toBe(
      'other'
    )
    expect(document.querySelector('.tour-state.change')?.textContent).toBe('✓ change approved · in the plan')
    expect(document.querySelector('.tour-restated')?.textContent).toContain('The callers.')
    // A click on the decision's text leaves the pick alone.
    click('.tour-lead')
    expect(document.querySelector('.tour-state.change')).not.toBeNull()
    // Reopening keeps the draft, and closing it keeps the change approved.
    click('[data-act="grill"]')
    expect(dialog.querySelector('textarea[name="unchanged"]')?.textContent).toBe('The callers.')
    click('[data-act="close-grill"]')
    expect(dialog.open).toBe(false)
    expect(document.querySelector('.tour-state.change')?.textContent).toBe('✓ change approved · in the plan')
    click('.tour-option[data-pick="other"]')
    // The drawer is drawn again each time it opens.
    dialog.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(dialog.open).toBe(false)
    click('[data-nav="next"]')
    expect(location.hash).toBe('#quiz-q-run')
    press('2')
    click('[data-nav="next"]')
    expect(document.querySelector('.tour-title')?.textContent).toBe('1 change to make, 0 kept')
    expect(document.querySelector('.tour-plan-list li')?.textContent).toContain('The callers.')
  })

  it('jumps to a decision from a landmark chip and back, and opens the help', async () => {
    vi.stubGlobal(
      'fetch',
      fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 3 } })).impl
    )
    mount()
    await drawn('.tour-chips')
    expect(location.hash).toBe('#landmark-sum')
    click('.tour-chip.link')
    expect(location.hash).toBe('#decision-sum-over-product')
    expect(document.querySelector('.tour-return')?.textContent).toContain('Jumped from landmark 3')
    click('[data-act="return"]')
    expect(location.hash).toBe('#landmark-sum')
    click('[data-nav="next"]')
    click('[data-nav="next"]')
    click('.tour-eyebrow a[data-act="landmark"]')
    expect(location.hash).toBe('#landmark-sum')
    expect(document.querySelector('.tour-return')?.textContent).toContain('Jumped from a decision')
    press('?')
    const help = document.querySelector('#help-dialog')
    if (!(help instanceof HTMLDialogElement)) {
      throw new Error('no help')
    }
    expect(help.open).toBe(true)
    click('[data-act="close-help"]')
    expect(help.open).toBe(false)
    click('[data-act="help"]')
    expect(help.open).toBe(true)
  })

  it('lands on the step in the URL, follows the browser history, and ignores a step it cannot reach', async () => {
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle()).impl)
    history.replaceState(null, '', '/tour/42#landmark-sum')
    mount()
    await drawn('.tour-chips')
    expect(document.querySelector('.tour-title')?.textContent).toBe('Sum, not product')
    press('ArrowRight')
    expect(location.hash).toBe('#landmark-respect')
    history.back()
    await vi.waitFor(() =>
      expect(document.querySelector('.tour-title')?.textContent).toBe('Sum, not product')
    )
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(document.querySelector('.tour-title')?.textContent).toBe('Sum, not product')
    document.body.innerHTML = ''
    // A step past an open decision falls back to where the reader may be.
    history.replaceState(null, '', '/tour/42#plan')
    mount()
    await drawn('.tour-cover-actions')
    expect(location.hash).toBe('#cover')
    document.body.innerHTML = ''
    // A saved step past an open decision walks back to the decision.
    vi.stubGlobal(
      'fetch',
      fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 7 } })).impl
    )
    history.replaceState(null, '', '/tour/42')
    mount()
    await drawn('.tour-options')
    expect(location.hash).toBe('#decision-sum-over-product')
  })

  it('opens on the landmark the preview names, saves nothing, and cannot finish', async () => {
    const server = fakeServer(syntheticTourBundle({ preview: true, warnings: ['previewing'] }))
    vi.stubGlobal('fetch', server.impl)
    mount({ preview: true, landmark: 'respect' })
    await drawn('.tour-stage-tag')
    expect(document.querySelector('.tour-title')?.textContent).toBe('Keep run() total')
    expect(document.querySelector('.banner')?.textContent).toBe('previewing')
    expect(document.querySelector('iframe.tour-frame')?.getAttribute('src')).toContain('&preview=1')
    // Every step is open in a preview.
    click('.tour-rail-seg[data-step="7"]')
    expect(location.hash).toBe('#plan')
    expect(text()).toContain('A preview is not finished')
    expect(server.calls).toEqual(['GET /r/acme/widgets/api/tours/42?preview=1'])
    // An unknown landmark falls back to the cover.
    document.body.innerHTML = ''
    history.replaceState(null, '', '/tour/42')
    mount({ preview: true, landmark: 'nope' })
    await drawn('.tour-cover-actions')
  })

  it('switches the theme, telling the frames and the settings file, and offers no skin', async () => {
    const server = fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 1 } }))
    vi.stubGlobal('fetch', server.impl)
    mount()
    const frame = await drawn('iframe.tour-frame')
    const postMessage = vi.fn()
    Object.defineProperty(frame, 'contentWindow', { value: { postMessage }, configurable: true })
    click('#theme-toggle')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(postMessage).toHaveBeenCalledWith({ scene: 'theme', theme: 'light' }, '*')
    expect(document.querySelector('#skin-toggle')).toBeNull()
    await vi.waitFor(() =>
      expect(server.calls.filter(c => c === 'PUT /r/acme/widgets/api/appearance')).toHaveLength(1)
    )
  })

  it('shows the missing screen and polls until the tour is published', async () => {
    vi.useFakeTimers()
    let published = false
    const server = fakeServer(() => (published ? syntheticTourBundle() : missingTourBundle()))
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
    await vi.waitFor(() => expect(document.querySelector('.tour-missing')).not.toBeNull())
    expect(document.querySelector('.tour-missing')?.textContent).toContain('/pr-tour 42')
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(document.querySelector('.tour-missing')).not.toBeNull()
    published = true
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.waitFor(() => expect(document.querySelector('.tour-cover-actions')).not.toBeNull())
    el.remove()
    expect(el.poll).toBeNull()
  })

  it('generates from the missing screen, and loads the tour a finished job published', async () => {
    const chat = { enabled: true, acpx: true, agent: 'claude', model: null }
    let published = false
    const server = fakeServer(() => (published ? syntheticTourBundle({ chat }) : missingTourBundle({ chat })))
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
    await drawn('#generate-start')
    click('#generate-start')
    const dialog = /** @type {HTMLDialogElement} */ (await drawn('#generate-dialog'))
    expect(dialog.querySelector('h2')?.textContent).toBe('Generate the tour')
    click('#generate-dialog [data-gen="start"]')
    await vi.waitFor(() => expect(server.calls).toContain('POST /r/acme/widgets/api/tours/42/generate'))
    // A job that ended badly while the dialog was closed is a toast.
    dialog.removeAttribute('open')
    await el.generationEnded({
      ...TOUR_JOB,
      phase: 'failed',
      error: { code: 'GENERATION_FAILED', message: 'no' },
    })
    expect(document.querySelector('.toast')?.textContent).toBe('tour generation failed: no')
    await el.generationEnded({ ...TOUR_JOB, phase: 'cancelled' })
    expect(text()).toContain('tour generation stopped')
    published = true
    await el.generationEnded(TOUR_JOB)
    await drawn('.tour-cover-actions')
    expect(text()).toContain('tour published')
    el.remove()
  })

  it('looks for a shared tour on demand, and exports the tour on screen', async () => {
    /** @type {unknown} */
    let shared = { found: false, imported: false, warnings: ['pr-42-x-tour.zip: broken'] }
    const server = fakeServer(missingTourBundle(), { shared: () => shared })
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
    click(`#${(await drawn('#fetch-shared')).id}`)
    await vi.waitFor(() => expect(text()).toContain('no tour is shared on the pull request'))
    shared = { found: true, imported: false, warnings: [] }
    click('#fetch-shared')
    await vi.waitFor(() => expect(text()).toContain('is no newer than this one'))
    el.remove()

    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle()).impl)
    mount()
    click(`#${(await drawn('#export-zip')).id}`)
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
  })

  it('shows the error card with a retry when the bundle cannot be read, and the stale bar', async () => {
    const server = fakeServer(syntheticTourBundle(), { fail: true })
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('.error-card')
    expect(document.querySelector('.error-card')?.textContent).toContain('no such pull request')
    vi.stubGlobal(
      'fetch',
      fakeServer(
        syntheticTourBundle({
          status: 'stale',
          stale: {
            tourHeadSha: HEAD,
            currentHeadSha: 'c'.repeat(40),
            relation: 'ancestor',
            commitsBehind: 1,
          },
        })
      ).impl
    )
    click('#retry')
    await drawn('.tour-stale')
    expect(document.querySelector('.tour-stale')?.textContent).toContain('1 commit behind')
    document.body.innerHTML = '<pr-tour></pr-tour>'
    await drawn('.error-card')
    expect(document.querySelector('.error-card')?.textContent).toContain('missing bootstrap data')
  })

  it('names a local change, ignores keys while typing or with a modifier, and a click on plain text', async () => {
    const bundle = syntheticTourBundle({
      local: 'branch',
      key: 'branch',
      reader: { ...freshReaderState(), step: 5 },
    })
    bundle.pr = { ...bundle.pr, number: null, url: '' }
    const server = fakeServer(bundle)
    vi.stubGlobal('fetch', server.impl)
    const el = mount({ key: 'branch' })
    await drawn('.tour-options')
    expect(document.title).toBe('Tour · feat/b feat: add b')
    expect(server.calls[0]).toBe('GET /r/acme/widgets/api/tours/branch')
    press('Escape')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    const note = document.createElement('textarea')
    el.append(note)
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    expect(document.querySelector('.tour-option[aria-checked="true"]')).toBeNull()
    // Other fields' input and change events, and a click on text, are not the page's business.
    note.dispatchEvent(new Event('input', { bubbles: true }))
    note.dispatchEvent(new Event('change', { bubbles: true }))
    const plain = document.createTextNode('x')
    el.append(plain)
    plain.dispatchEvent(new Event('click', { bubbles: true }))
    press('k')
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept')
    click('[data-nav="prev"]')
    expect(location.hash).toBe('#landmark-respect')
    // A change event on a landmark has no decision to update.
    document.querySelector('textarea[data-act="note"]')?.dispatchEvent(new Event('change', { bubbles: true }))
    // History with a step the tour does not have is ignored; the guards of the direct calls hold.
    window.dispatchEvent(new PopStateEvent('popstate', { state: { step: 99 } }))
    expect(location.hash).toBe('#landmark-respect')
    el.go(-1)
    el.go(99)
    el.jumpTo(-1)
    el.returnBack()
    el.answer(0)
    expect(location.hash).toBe('#landmark-respect')
    click('[data-nav="next"]')
    expect(location.hash).toBe('#decision-sum-over-product')
    click('[data-nav="next"]')
    expect(location.hash).toBe('#quiz-q-run')
    el.answer(5)
    expect(document.querySelector('.tour-quiz-why')).toBeNull()
    // Finishing may fail to share, and the toast says so.
    const finished = {
      at: 'x',
      promptPath: '/p',
      prompt: '# P',
      sharing: { status: 'failed', warning: 'boom', zipPath: '/z.zip' },
    }
    const failing = fakeServer(bundle, {
      finish: () =>
        new Response(
          JSON.stringify({
            finished,
            record: { touredBy: [] },
            reader: { ...freshReaderState(), step: 7, finished },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    })
    vi.stubGlobal('fetch', failing.impl)
    press('2')
    click('[data-nav="next"]')
    click('[data-act="confirm"]')
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toBe('prompt written · boom')
    )
    // The clipboard may be missing.
    vi.stubGlobal('navigator', {})
    click('[data-act="copy"]')
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toContain('clipboard is not available')
    )
  })

  it('offers the agent on the plan when chat is on, and shows its plan card', async () => {
    const bundle = syntheticTourBundle({
      chat: { enabled: true, acpx: true, agent: 'claude', model: null },
      reader: {
        ...freshReaderState(),
        step: 7,
        picks: { 'sum-over-product': { pick: 'keep', approved: true } },
        quiz: { 'q-run': { answered: 1, right: true } },
      },
    })
    const server = fakeServer(bundle)
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('[data-act="grill-plan"]')
    click('[data-act="grill-plan"]')
    const dialog = document.querySelector('#tour-grill')
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error('no dialog')
    }
    await vi.waitFor(() => expect(dialog.querySelector('.tour-plan-card')).not.toBeNull())
    expect(dialog.querySelector('.tour-plan-card')?.textContent).toContain('Sum over product?')
    expect(server.calls).toContain('POST /r/acme/widgets/api/tours/42/grill')
    click('[data-act="close-grill"]')
    expect(dialog.open).toBe(false)
  })

  it('shows a network failure and an error without a hint', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    mount()
    await drawn('.error-card')
    expect(document.querySelector('.error-card')?.textContent).toContain('Error: offline')
    document.body.innerHTML = ''
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'bare' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
    )
    mount()
    await drawn('.error-card')
    expect(document.querySelector('.error-card')?.textContent).toContain('bare')
  })

  it('says when a save or a finish fails, and keeps a tried recipe', async () => {
    const bundle = syntheticTourBundle({ reader: { ...freshReaderState(), step: 5 } })
    const decision = bundle.tour?.decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    decision.tryIt = { steps: ['pnpm start'], look: ['the sum'], verified: true }
    const server = fakeServer(bundle, {
      save: () => new Response('nope', { status: 500 }),
      finish: () =>
        new Response(
          JSON.stringify({ error: { code: 'SIGNOFF_INCOMPLETE', message: 'open', hint: 'settle' } }),
          {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }
        ),
    })
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('.tour-tryit')
    const tried = document.querySelector('input[data-act="tried"]')
    if (!(tried instanceof HTMLInputElement)) {
      throw new Error('no checkbox')
    }
    tried.checked = true
    tried.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toContain('could not save'))
    expect(server.saved.at(-1)?.picks['sum-over-product']?.tried).toBe(true)
    press('k')
    click('[data-nav="next"]')
    press('2')
    click('[data-nav="next"]')
    click('[data-act="confirm"]')
    await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe('open · settle'))
    expect(document.querySelector('[data-act="confirm"]')?.hasAttribute('disabled')).toBe(false)
  })
})
