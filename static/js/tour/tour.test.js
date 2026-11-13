// @ts-check
// @vitest-environment happy-dom
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
// The tour page end to end in happy-dom, against a fake server: the walk through the steps, the
// picks, the quiz, the plan, the history, and the looks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { freshReaderState, TourReaderInputSchema } from '../../../src/contract/tour-api.js'
import { missingTourBundle, syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { GENERATION_POLL_MS } from '../generate.js'
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
 * @param {{
 *   finish?: () => Response,
 *   save?: () => Response | undefined,
 *   fail?: boolean,
 *   shared?: () => unknown,
 *   sharing?: () => unknown,
 *   job?: () => import('../contract-types.js').GenerationJob | null,
 *   threads?: unknown[],
 * }} [opts]
 *   a `save` that answers undefined lets the fake accept the state as usual; `sharing` is how a
 *   finish says the record was shared, `job` the generation the server has, and `threads` the
 *   tour's AI Chat threads
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
        return json({ job: opts.job?.() ?? null })
      }
      // With chat on, the tour's AI Chat reads its threads once, and a thread's questions when it
      // opens; they have none here.
      if (url.endsWith('/chat/threads') && method === 'GET') {
        return json({ threads: opts.threads ?? [], agent: 'claude' })
      }
      if (url.includes('/chat/threads/') && url.endsWith('/history')) {
        return json({ name: 'thread', turns: [] })
      }
      calls.push(`${method} ${url}`)
      if (opts.fail) {
        return json({ error: { code: 'PR_NOT_FOUND', message: 'no such pull request', hint: 'check' } }, 404)
      }
      if (url.endsWith('/shared-tour/fetch') && method === 'POST') {
        return json(opts.shared?.() ?? { outcome: 'none', warnings: [] })
      }
      if (url.includes('/export')) {
        return new Response(new Uint8Array([80, 75]), {
          headers: { 'content-disposition': 'attachment; filename="pr-42-x-tour.zip"' },
        })
      }
      if (url.endsWith('/generate') && method === 'POST') {
        return json({ job: { ...TOUR_JOB, phase: 'preparing' } }, 202)
      }
      if (url.endsWith('/generate') && method === 'DELETE') {
        return json({ error: { code: 'INTERNAL', message: 'the agent did not stop' } }, 500)
      }
      if (url.endsWith('/grill/history')) {
        return json({ name: 't0', turns: [] })
      }
      if (url.startsWith('/r/acme/widgets/api/tours/') && method === 'GET') {
        return json(typeof bundle === 'function' ? bundle() : bundle)
      }
      if (url.endsWith('/reader') && method === 'PUT') {
        // Parsed as the server parses it, so a state the page builds that the server would refuse fails here.
        const body = TourReaderInputSchema.parse(JSON.parse(String(init?.body)))
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
          sharing: opts.sharing?.() ?? {
            status: 'shared',
            url: 'https://github.com/acme/widgets/pull/42#issuecomment-1',
          },
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
    let sharingOff = false
    const server = fakeServer(syntheticTourBundle(), {
      sharing: () => (sharingOff ? { status: 'off' } : undefined),
    })
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
    await drawn('.tour-cover-actions')
    expect(document.title).toBe('Tour · #42 feat: add b')
    expect(location.hash).toBe('#cover')
    expect(document.querySelector('.tour-rail-seg[data-state="current"]')?.getAttribute('data-step')).toBe(
      '0'
    )

    click('[data-nav="next"]')
    expect(document.querySelector('#strip')?.textContent).toBe('stop1of 4Before this change')
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
    click('.tour-code-tab[data-view="literate"]')
    expect(document.querySelector('.tour-code-tab[aria-selected="true"]')?.textContent).toBe('literate diff')
    expect(document.querySelector('.tour-code-body .tour-literate')).not.toBeNull()
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
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('note')

    // Nothing is chosen at first. `k` keeps and `a` takes the alternative, each settling it; undo
    // takes the pick back, and a click on the decision's text leaves it alone.
    const chosen = () =>
      document.querySelector('.tour-option[aria-pressed="true"]')?.getAttribute('data-pick')
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
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('done')
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
    click('.tour-option[data-pick="change"]')
    expect(chosen()).toBe('change')
    click('.tour-rail-seg[data-step="7"]')
    expect(document.querySelector('.tour-plan-changed')?.textContent).toContain('You changed the plan')
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('confirm again')
    expect(text()).toContain('Confirmed before')
    // With sharing off, the prompt is all there is to say.
    sharingOff = true
    click('[data-act="confirm"]')
    await vi.waitFor(() => expect(server.finishes).toHaveLength(2))
    await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe('prompt written'))
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('done')
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
    expect(document.querySelector('.tour-option[aria-pressed="true"]')?.getAttribute('data-pick')).toBe(
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
    // An ordinary move drops the way back: the banner does not follow the reader on.
    press('ArrowRight')
    expect(document.querySelector('.tour-return')).toBeNull()
    press('ArrowLeft')
    expect(document.querySelector('.tour-return')).toBeNull()
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
    const el = mount()
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
    // The focus follows a move to the step, so the keyboard reads on from there.
    press('ArrowRight')
    expect(document.activeElement?.id).toBe('stage')
    expect(document.title).toBe('Keep run() total · Tour · #42 feat: add b')
    // A hash typed into the address bar past the open decision lands on that decision, and says so.
    history.replaceState(null, '', '/tour/42#plan')
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    expect(location.hash).toBe('#decision-sum-over-product')
    expect(document.querySelector('.toast')?.textContent).toBe('The plan opens after decision 1')
    // Forward to a step an undo has since closed lands there too.
    press('k')
    press('ArrowRight')
    expect(location.hash).toBe('#quiz-q-run')
    history.back()
    await vi.waitFor(() => expect(location.hash).toBe('#decision-sum-over-product'))
    click('[data-act="unsettle"]')
    window.dispatchEvent(new PopStateEvent('popstate', { state: { step: 6 } }))
    expect(location.hash).toBe('#decision-sum-over-product')
    // Going where the page already is adds no history entry.
    const entries = history.length
    el.go(5)
    expect(history.length).toBe(entries)
    // The moves saved above go out before the page goes, not through a later test's server.
    await el.saver?.settle()
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

  it('keeps the rail one tab stop, says why a stop is closed, and swallows the keys it uses', async () => {
    vi.stubGlobal(
      'fetch',
      fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 5 } })).impl
    )
    mount()
    await drawn('.tour-options')
    // A closed stop says what opens it.
    click('.tour-rail-seg[data-step="7"]')
    expect(location.hash).toBe('#decision-sum-over-product')
    expect(document.querySelector('.toast')?.textContent).toBe('The plan opens after decision 1')
    // The arrows move the focus along the rail and leave the step where it is.
    const here = /** @type {HTMLElement} */ (document.querySelector('.tour-rail-seg[aria-current="step"]'))
    here.focus()
    here.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    const stop = /** @type {HTMLElement} */ (document.activeElement)
    expect(stop.getAttribute('data-step')).toBe('4')
    expect(stop.tabIndex).toBe(0)
    expect(location.hash).toBe('#decision-sum-over-product')
    // Enter on a focused button presses it; it does not move to the next step.
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    stop.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    stop.click()
    expect(location.hash).toBe('#landmark-respect')
    expect(document.activeElement?.getAttribute('aria-current')).toBe('step')
    // A key the tour uses goes no further, so `c` types nothing into the drawer it opens.
    press('ArrowRight')
    const keep = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })
    document.body.dispatchEvent(keep)
    expect(keep.defaultPrevented).toBe(true)
    expect(document.querySelector('.tour-state')?.textContent).toBe('✓ kept')
    const other = new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })
    document.body.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)
    // Home and End reach the rail's ends, the arrows stop there, and the rail stays one tab stop.
    const railKey = (/** @type {string} */ key) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      )
    const focused = () => document.activeElement?.getAttribute('data-step')
    ;/** @type {HTMLElement} */ (document.querySelector('.tour-rail-seg[aria-current="step"]')).focus()
    railKey('End')
    expect(focused()).toBe('7')
    railKey('ArrowRight')
    expect(focused()).toBe('7')
    railKey('Home')
    expect(focused()).toBe('0')
    railKey('ArrowRight')
    expect(focused()).toBe('1')
    const inTabOrder = [...document.querySelectorAll('.tour-rail-seg')].filter(
      seg => seg instanceof HTMLElement && seg.tabIndex === 0
    )
    expect(inTabOrder.map(seg => seg.getAttribute('data-step'))).toEqual(['1'])
    // A key the rail does not use is the page's: `?` opens the help from a stop too.
    railKey('?')
    expect(document.querySelector('#help-dialog')?.hasAttribute('open')).toBe(true)
  })

  it('opens on the landmark the preview names, saves nothing, and cannot finish', async () => {
    const server = fakeServer(syntheticTourBundle({ preview: true, warnings: ['previewing'] }))
    vi.stubGlobal('fetch', server.impl)
    mount({ preview: true, landmark: 'respect' })
    await drawn('.tour-title')
    expect(document.querySelector('.tour-title')?.textContent).toBe('Keep run() total')
    expect(document.querySelector('.banner')?.textContent).toBe('previewing')
    expect(document.querySelector('iframe.tour-frame')?.getAttribute('src')).toContain('&preview=1')
    // Every step is open in a preview.
    click('.tour-rail-seg[data-step="7"]')
    expect(location.hash).toBe('#plan')
    expect(text()).toContain('a preview is not finished')
    expect(server.calls).toEqual(['GET /r/acme/widgets/api/tours/42?preview=1'])
    // An unknown landmark falls back to the cover.
    document.body.innerHTML = ''
    history.replaceState(null, '', '/tour/42')
    mount({ preview: true, landmark: 'nope' })
    await drawn('.tour-cover-actions')
  })

  it('switches the theme, telling the frames and the settings file, says when that file refuses it, and offers no skin', async () => {
    const server = fakeServer(syntheticTourBundle({ reader: { ...freshReaderState(), step: 1 } }))
    vi.stubGlobal('fetch', server.impl)
    const el = mount()
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
    // A settings file that cannot be written says so; the page still wears the theme.
    await el.saver?.settle()
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle(), { fail: true }).impl)
    click('#theme-toggle')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toBe('could not save the theme to settings.yml')
    )
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('failed')
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
    // A job that ended badly while the dialog was open shows there, not as a toast.
    await el.generationEnded({ ...TOUR_JOB, phase: 'failed' })
    expect(document.querySelector('.toast')).toBeNull()
    // A job that ended badly while the dialog was closed is a toast.
    dialog.removeAttribute('open')
    await el.generationEnded({
      ...TOUR_JOB,
      phase: 'failed',
      error: { code: 'GENERATION_FAILED', message: 'no' },
    })
    expect(document.querySelector('.toast')?.textContent).toBe('tour generation failed: no')
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('failed')
    await el.generationEnded({ ...TOUR_JOB, phase: 'cancelled' })
    expect(text()).toContain('tour generation stopped')
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('note')
    await el.generationEnded({ ...TOUR_JOB, phase: 'failed' })
    expect(document.querySelector('.toast')?.textContent).toBe(
      'tour generation failed: open the generation dialog for details'
    )
    published = true
    await el.generationEnded(TOUR_JOB)
    await drawn('.tour-cover-actions')
    expect(text()).toContain('tour published')
    el.remove()
  })

  it('opens the dialog a generate link asks for, says when a stop fails, and shows the end in the open dialog', async () => {
    vi.useFakeTimers()
    const chat = { enabled: true, acpx: true, agent: 'claude', model: null }
    /** @type {import('../contract-types.js').GenerationJob | null} */
    let job = null
    const server = fakeServer(
      () => (job?.phase === 'done' ? syntheticTourBundle({ chat }) : missingTourBundle({ chat })),
      { job: () => job }
    )
    vi.stubGlobal('fetch', server.impl)
    // The home page's generate links land with `?generate=1`, which opens the dialog once.
    history.replaceState(null, '', '/tour/42?generate=1')
    mount()
    const dialog = await drawn('#generate-dialog')
    expect(dialog.hasAttribute('open')).toBe(true)
    expect(location.search).toBe('')
    job = { ...TOUR_JOB, phase: 'preparing' }
    click('#generate-dialog [data-gen="start"]')
    ;(await drawn('#generate-dialog [data-gen="stop"]')).click()
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toBe('the agent did not stop')
    )
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('failed')
    // The job ends while the reader watches it: the tour loads, and the dialog says how it went.
    job = TOUR_JOB
    await vi.advanceTimersByTimeAsync(GENERATION_POLL_MS)
    await drawn('.tour-cover-actions')
    const shown = /** @type {HTMLElement} */ (document.querySelector('#generate-dialog'))
    expect(shown.hasAttribute('open')).toBe(true)
    expect(shown.querySelector('h2')?.textContent).toBe('Done')
    expect(text()).not.toContain('tour published')
  })

  it('looks for a shared tour on demand, draws one it imports, and exports the tour on screen', async () => {
    /** @type {unknown} */
    let shared = { outcome: 'none', warnings: [] }
    let imported = false
    const server = fakeServer(() => (imported ? syntheticTourBundle() : missingTourBundle()), {
      shared: () => shared,
    })
    vi.stubGlobal('fetch', server.impl)
    mount()
    const toastSays = () => document.querySelector('.toast')?.textContent
    const tone = () => document.querySelector('.toast')?.getAttribute('data-tone')
    click(`#${(await drawn('#fetch-shared')).id}`)
    await vi.waitFor(() => expect(toastSays()).toBe('no tour is shared on the pull request'))
    // A shared tour that will not import says why, in the same toast.
    shared = { outcome: 'unreadable', warnings: ['pr-42-x-tour.zip is not a zip file'] }
    click('#fetch-shared')
    await vi.waitFor(() =>
      expect(toastSays()).toBe(
        'the tour shared on the pull request would not import · pr-42-x-tour.zip is not a zip file'
      )
    )
    expect(tone()).toBe('failed')
    shared = { outcome: 'exists', warnings: [] }
    click('#fetch-shared')
    await vi.waitFor(() =>
      expect(toastSays()).toBe('the tour shared on the pull request is no newer than this one')
    )
    expect(tone()).toBe('note')
    // A newer one is imported and drawn, and what went wrong on the way is still up once it is.
    shared = { outcome: 'imported', warnings: ['pr-42-y-tour.zip could not be downloaded'] }
    imported = true
    click('#fetch-shared')
    await drawn('.tour-cover-actions')
    await vi.waitFor(() => expect(toastSays()).toBe('pr-42-y-tour.zip could not be downloaded'))

    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    click('#export-zip')
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
  })

  it('uploads a tour zip dropped on the missing screen and draws the tour it brought', async () => {
    let imported = false
    vi.stubGlobal('fetch', fakeServer(() => (imported ? syntheticTourBundle() : missingTourBundle())).impl)
    /** @type {string[]} */
    const uploads = []
    // The browser's upload: the server takes the zip and answers once it is sent.
    vi.stubGlobal('XMLHttpRequest', function () {
      const xhr = {
        status: 200,
        responseText: '',
        upload: {},
        /** @type {(() => void) | null} */
        onload: null,
        open: (/** @type {string} */ method, /** @type {string} */ url) => uploads.push(`${method} ${url}`),
        setRequestHeader: () => undefined,
        send: () => {
          imported = true
          xhr.responseText = JSON.stringify({ status: 'imported', headSha: HEAD, warnings: [] })
          queueMicrotask(() => xhr.onload?.())
        },
      }
      return xhr
    })
    mount()
    const input = await drawn('#zip')
    const zip = new File(['zip'], 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-tour.zip')
    Object.defineProperty(input, 'files', { value: [zip] })
    input.dispatchEvent(new Event('change'))
    await drawn('.tour-cover-actions')
    expect(uploads).toEqual(['POST /r/acme/widgets/api/tours/42/import'])
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
    // A bootstrap that is not JSON is as good as none.
    document.body.innerHTML =
      '<script id="bootstrap" type="application/json">{"key":</script><pr-tour></pr-tour>'
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
    expect(document.title).toBe('Sum over product? · Tour · feat/b feat: add b')
    expect(server.calls[0]).toBe('GET /r/acme/widgets/api/tours/branch')
    press('Escape')
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    const note = document.createElement('textarea')
    el.append(note)
    note.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    expect(document.querySelector('.tour-option[aria-pressed="true"]')).toBeNull()
    // A key pressed on an AI Chat pane control belongs to the pane.
    const pane = document.createElement('aside')
    pane.id = 'tour-ask'
    pane.innerHTML = '<button type="button" id="pane-send">send</button>'
    el.append(pane)
    document
      .querySelector('#pane-send')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    expect(document.querySelector('.tour-option[aria-pressed="true"]')).toBeNull()
    pane.remove()
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
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('note')
    // The clipboard may be missing.
    vi.stubGlobal('navigator', {})
    click('[data-act="copy"]')
    await vi.waitFor(() =>
      expect(document.querySelector('.toast')?.textContent).toContain('clipboard is not available')
    )
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('failed')
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

  it('opens AI Chat beside the tour from the nav or with /, on the thread of the stop on screen', async () => {
    const bundle = syntheticTourBundle({ chat: { enabled: true, acpx: true, agent: 'claude', model: null } })
    vi.stubGlobal('fetch', fakeServer(bundle).impl)
    const page = mount()
    await drawn('[data-act="ask"]')
    const pane = /** @type {HTMLElement} */ (document.querySelector('#tour-ask'))
    expect(pane.hidden).toBe(true)
    click('[data-act="ask"]')
    expect(pane.hidden).toBe(false)
    expect(page.hasAttribute('data-asking')).toBe(true)
    expect(document.querySelector('[data-act="ask"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(pane.querySelector('#tour-ask-title')?.textContent).toBe('the whole tour')
    // The pane follows the reader to the next stop.
    click('[data-nav="next"]')
    expect(pane.querySelector('#tour-ask-title')?.textContent).toBe('landmark · run() returned a() alone')
    // The launcher is gone while the pane is open, and back once it closes.
    expect(/** @type {HTMLElement} */ (document.querySelector('[data-act="ask"]')).hidden).toBe(true)
    click('[data-act="ask-close"]')
    expect(pane.hidden).toBe(true)
    expect(page.hasAttribute('data-asking')).toBe(false)
    expect(/** @type {HTMLElement} */ (document.querySelector('[data-act="ask"]')).hidden).toBe(false)
    press('/')
    expect(pane.hidden).toBe(false)
    expect(document.activeElement).toBe(pane.querySelector('#tour-ask-box'))
  })

  it('takes the reader from an AI Chat thread to its stop, once that stop is open', async () => {
    const chat = { enabled: true, acpx: true, agent: 'claude', model: null }
    const thread = (/** @type {string} */ name, /** @type {unknown} */ place) => ({
      name,
      agent: 'claude',
      title: name,
      createdAt: '2026-10-16T12:00:00.000Z',
      turns: 1,
      place,
    })
    const threads = [
      thread('t-before', { kind: 'tour-landmark', id: 'before' }),
      thread('t-plan', { kind: 'tour-plan' }),
    ]
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle({ chat }), { threads }).impl)
    mount()
    await drawn('[data-act="ask"]')
    // `/` opens the pane whether or not an earlier visit left it open.
    press('/')
    const goto = /** @type {HTMLElement} */ (document.querySelector('[data-act="ask-goto"]'))
    click('[data-act="ask-switch"]')
    click(`[data-act="ask-open"][data-thread="${(await drawn('[data-thread="t-plan"]')).dataset['thread']}"]`)
    // The plan opens after the decision, so its thread does not offer to go there yet.
    expect(goto.hidden).toBe(true)
    click('[data-act="ask-switch"]')
    click('[data-act="ask-open"][data-thread="t-before"]')
    expect(goto.hidden).toBe(false)
    click('[data-act="ask-goto"]')
    expect(location.hash).toBe('#landmark-before')
    // On its own stop, the thread has nowhere to go.
    expect(goto.hidden).toBe(true)
  })

  it('saves the reader turning audio off in the drawer', async () => {
    // A browser with speech recognition, so the drawer offers the microphone.
    vi.stubGlobal('SpeechRecognition', function () {})
    const server = fakeServer(
      syntheticTourBundle({
        chat: { enabled: true, acpx: true, agent: 'claude', model: null },
        reader: { ...freshReaderState(), step: 5 },
      })
    )
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('.tour-options')
    press('c')
    ;(await drawn('#tour-grill [data-act="mic"]')).click()
    click('[data-act="notice-off"]')
    expect(document.querySelector('#tour-grill [data-act="mic"]')).toBeNull()
    await vi.waitFor(() => expect(server.saved.at(-1)?.audioOff).toBe(true))
    expect(server.saved.at(-1)?.audioNoticeSeen).toBe(true)
  })

  it('fades the ends of the rail with more stops past the window, as it scrolls and as the window resizes', async () => {
    /** @type {Array<() => void>} */
    const resized = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        /** @param {() => void} callback */
        constructor(callback) {
          resized.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle()).impl)
    mount()
    const road = await drawn('.tour-rail')
    expect(road.dataset['more']).toBe('')
    // The window narrows to a third of the rail.
    Object.defineProperty(road, 'clientWidth', { value: 100, configurable: true })
    Object.defineProperty(road, 'scrollWidth', { value: 300, configurable: true })
    for (const callback of resized) callback()
    expect(road.dataset['more']).toBe('right')
    road.scrollLeft = 100
    road.dispatchEvent(new Event('scroll'))
    expect(road.dataset['more']).toBe('left right')
    road.scrollLeft = 200
    road.dispatchEvent(new Event('scroll'))
    expect(road.dataset['more']).toBe('left')
  })

  it('has no AI Chat with chat off', async () => {
    vi.stubGlobal('fetch', fakeServer(syntheticTourBundle()).impl)
    mount()
    await drawn('[data-nav="next"]')
    expect(document.querySelector('[data-act="ask"]')).toBeNull()
    expect(document.querySelector('#tour-ask')).toBeNull()
    press('/')
    expect(document.querySelector('#tour-ask')).toBeNull()
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

  it('saves the mode the cover chooses, and finishes as a reviewer with a review', async () => {
    const bundle = syntheticTourBundle({
      reader: {
        ...freshReaderState(),
        step: 7,
        picks: { 'sum-over-product': { pick: 'keep', approved: true } },
      },
    })
    const server = fakeServer(bundle)
    vi.stubGlobal('fetch', server.impl)
    mount()
    await drawn('.tour-kept')
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('confirm the plan')
    click('[data-nav="prev"]')
    click('.tour-rail-seg[data-step="0"]')
    const box = await drawn('input[data-act="mode"]')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no checkbox')
    }
    expect(box.checked).toBe(true)
    box.checked = false
    box.dispatchEvent(new Event('change', { bubbles: true }))
    expect(document.querySelector('.tour-mode .tour-hint')?.textContent).toContain('reviewer mode')
    await vi.waitFor(() => expect(server.saved.at(-1)?.mode).toBe('reviewer'))
    click('.tour-rail-seg[data-step="7"]')
    expect(document.querySelector('[data-act="confirm"]')?.textContent).toBe('confirm the review')
    click('[data-act="confirm"]')
    await drawn('#prompt')
    expect(document.querySelector('.toast')?.textContent).toBe(
      'review written · record shared on the pull request'
    )
  })

  it('says when a save or a finish fails, and keeps a tried recipe', async () => {
    const bundle = syntheticTourBundle({ reader: { ...freshReaderState(), step: 5 } })
    const decision = bundle.tour?.decisions[0]
    if (decision === undefined) {
      throw new Error('no decision')
    }
    decision.tryIt = { steps: ['pnpm start'], look: ['the sum'], verified: true }
    let saveFails = true
    const server = fakeServer(bundle, {
      save: () =>
        saveFails
          ? new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'nope' } }), {
              status: 400,
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
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
    // Confirming sends the unsaved state once more; while the server refuses it, nothing is finished.
    const finishCalls = () => server.calls.filter(url => url.endsWith('/finish')).length
    click('[data-act="confirm"]')
    await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe('nope'))
    expect(finishCalls()).toBe(0)
    expect(document.querySelector('[data-act="confirm"]')?.hasAttribute('disabled')).toBe(false)
    saveFails = false
    click('[data-act="confirm"]')
    await vi.waitFor(() => expect(document.querySelector('.toast')?.textContent).toBe('open · settle'))
    expect(finishCalls()).toBe(1)
    expect(document.querySelector('[data-act="confirm"]')?.hasAttribute('disabled')).toBe(false)
  })
})
