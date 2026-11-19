// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cssEscape } from './anchors.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { emptyState } from '../../src/contract/state.js'
import {
  publishedSyntheticArtifact,
  SYNTHETIC_FILES,
  syntheticArtifact,
  withMarkdownTitles,
} from '../../src/testing/synthetic.js'
import { defineLayerElements, hunkIdForPoint, renderLayers, setRenderContext } from './layers.js'
import { initOneLayer } from './one-layer.js'
import { stopsOf } from './point-steps.js'
import { layerNavHtml, stopNavHtml } from './point-view.js'
import { renderRail } from './rail.js'
import { markRailCurrent } from './scroll-spy.js'

const artifact = syntheticArtifact()
const state = emptyState('2026-10-21T10:00:00.000Z')

/** @param {string} html */
function draw(html) {
  document.body.innerHTML = html
  return document.body
}

describe('stopsOf', () => {
  it('opens each layer with points or tests with a stop of its own, then its points, layer by layer', () => {
    expect(stopsOf(artifact).map(stop => stop.id)).toEqual([
      'layer-run-path',
      'point-p-1',
      'layer-other',
      'point-p-2',
      'point-p-3',
    ])
    expect(stopsOf(artifact).flatMap(stop => (stop.kind === 'point' ? [stop.number] : []))).toEqual([1, 2, 3])
  })

  it('opens a layer with tests and no points, skips one with neither, and has none without points', () => {
    const otherOnly = { ...artifact, points: artifact.points.filter(p => p.layerId === 'other') }
    expect(stopsOf(otherOnly).map(stop => stop.id)).toEqual([
      'layer-run-path',
      'layer-other',
      'point-p-2',
      'point-p-3',
    ])
    const bare = { ...otherOnly, layers: artifact.layers.map(layer => ({ ...layer, tests: [] })) }
    expect(stopsOf(bare).map(stop => stop.id)).not.toContain('layer-run-path')
    expect(stopsOf({ ...artifact, points: [] })).toEqual([])
  })
})

describe('stopNavHtml', () => {
  const stops = stopsOf(artifact)
  /** @param {number} index */
  const links = index =>
    Array.from(draw(stopNavHtml(stops, index, artifact)).querySelectorAll('a')).map(a => [
      a.getAttribute('href'),
      a.textContent,
    ])

  it('leads from the overview to the first stop, and from a layer’s stop to its points', () => {
    expect(links(-1)).toEqual([['#layer-run-path', 'start with Layer 1: Run path →']])
    expect(links(0)).toEqual([
      ['#overview', '← overview'],
      ['#point-p-1', 'go to its 1 attention point →'],
    ])
  })

  it('numbers a point among all of them, and leads on to the next layer and point', () => {
    draw(stopNavHtml(stops, 1, artifact))
    expect(document.querySelector('.step-n')?.textContent).toBe('Point 1 of 3')
    expect(links(1)).toEqual([
      ['#layer-run-path', '← Run path'],
      ['#layer-other', 'next layer: Other changes →'],
    ])
    expect(links(4)).toEqual([['#point-p-2', '← previous point'], expect.anything()])
  })

  it('names a way back to another layer’s opening as the previous layer, and to its own by its title', () => {
    const otherOnly = { ...artifact, points: artifact.points.filter(p => p.layerId === 'other') }
    const ids = stopsOf(otherOnly)
    const back = (/** @type {number} */ index) =>
      draw(stopNavHtml(ids, index, otherOnly)).querySelector('a')?.textContent
    expect(back(1)).toBe('← previous layer: Run path')
    expect(back(2)).toBe('← Other changes')
  })

  it('renders the Markdown of the layer titles it names', () => {
    const titled = withMarkdownTitles(artifact)
    const html = (/** @type {typeof titled} */ canvas, /** @type {number} */ index) =>
      Array.from(draw(stopNavHtml(stopsOf(canvas), index, canvas)).querySelectorAll('a')).map(
        a => a.innerHTML
      )
    expect(html(titled, -1)).toEqual(['start with Layer 1: Run <code>path</code> →'])
    expect(html(titled, 1)).toEqual([
      '← Run <code>path</code>',
      'next layer: Other <strong>changes</strong> →',
    ])
    const otherOnly = { ...titled, points: titled.points.filter(p => p.layerId === 'other') }
    expect(html(otherOnly, 1)[0]).toBe('← previous layer: Run <code>path</code>')
  })

  it('says the way of each link, back or on', () => {
    const ways = stops.flatMap((_, index) =>
      Array.from(draw(stopNavHtml(stops, index, artifact)).querySelectorAll('a')).map(a => [
        a.getAttribute('data-way'),
        a.textContent?.startsWith('←') ? 'back' : 'on',
      ])
    )
    expect(ways.length).toBeGreaterThan(stops.length)
    for (const [way, by] of ways) expect(way).toBe(by)
  })

  it('leads from the last stop to the layers, as the rail’s switch does', () => {
    draw(stopNavHtml(stops, 4, artifact))
    const on = document.querySelector('a[data-act="layer-view"]')
    expect(on?.getAttribute('data-view')).toBe('layers')
    expect(on?.getAttribute('href')).toBe('#layer-run-path')
  })
})

describe('layerNavHtml', () => {
  const none = () => false
  /**
   * @param {import('./contract-types.js').ReviewArtifact} canvas
   * @param {number} index
   * @param {(layer: import('./point-steps.js').Layer) => boolean} [reviewed]
   */
  const links = (canvas, index, reviewed = none) =>
    Array.from(draw(layerNavHtml(canvas, index, reviewed)).querySelectorAll('a')).map(a => [
      a.getAttribute('href'),
      a.textContent,
      a.getAttribute('data-way'),
    ])

  it('leads from the overview to the first layer, by its number and title', () => {
    expect(links(artifact, -1)).toEqual([['#layer-run-path', 'start with Layer 1: Run path →', 'on']])
  })

  it('leads back to the overview from the first layer, as k does, and on to the next layer', () => {
    expect(links(artifact, 0)).toEqual([
      ['#overview', '← overview', 'back'],
      ['#layer-other', 'next layer: Other changes →', 'on'],
    ])
  })

  it('leads from the last layer back to the one before and on to the first open layer', () => {
    expect(links(artifact, 1)).toEqual([
      ['#layer-run-path', '← previous layer: Run path', 'back'],
      ['#layer-run-path', 'next open layer: Run path →', 'on'],
    ])
  })

  it('says so when every other layer is reviewed', () => {
    expect(links(artifact, 1, () => true)).toEqual([
      ['#layer-run-path', '← previous layer: Run path', 'back'],
    ])
    expect(document.querySelector('.step-n')?.textContent).toBe('every other layer is reviewed')
  })

  it('names Other by its title alone, and renders the Markdown of the titles it names', () => {
    const otherOnly = { ...artifact, layers: artifact.layers.filter(l => l.kind === 'other') }
    expect(links(otherOnly, -1).map(([, text]) => text)).toEqual(['start with Other changes →'])
    expect(
      draw(layerNavHtml(withMarkdownTitles(artifact), 0, none)).querySelector('[data-way="on"]')?.innerHTML
    ).toBe('next layer: Other <strong>changes</strong> →')
  })
})

describe('the one-point view on a rendered page', () => {
  /** @type {ReturnType<typeof initOneLayer> | null} */
  let view = null
  /** @type {Array<import('./layer-views.js').PageView>} */
  let seen = []

  beforeEach(() => {
    setRenderContext({
      artifact,
      headSha: artifact.pr.headSha,
      mergeBaseSha: artifact.pr.mergeBaseSha,
      files: artifact.files,
      patches: toPatchMap(SYNTHETIC_FILES),
      comments: [],
      state,
      now: new Date('2026-10-21T10:00:00.000Z'),
    })
    defineLayerElements()
    window.history.replaceState(null, '', '/review/7')
    draw(
      `${renderRail(artifact, state, { points: true, switchable: true })}<main><section class="panel" id="overview"></section>${renderLayers(artifact, artifact.files, state, [])}</main>`
    )
    seen = []
    view = initOneLayer(document.body, { view: 'points', layersView: 'one', onView: next => seen.push(next) })
  })

  afterEach(() => {
    view?.stop()
    setRenderContext(null)
  })

  const lensed = () => document.querySelector('[data-lens]')
  const shown = () => Array.from(document.querySelectorAll('main section[id]:not([hidden])')).map(s => s.id)
  /** @param {string} selector */
  const reveal = selector =>
    document.querySelector(selector)?.dispatchEvent(new Event('reveal-code', { bubbles: true }))

  it('opens on the first stop, the first layer through its lens, with the bar over it', () => {
    expect(shown()).toEqual(['layer-run-path'])
    expect(lensed()?.getAttribute('data-lens')).toBe('layer')
    expect(document.querySelector('#stop-nav')?.nextElementSibling?.querySelector('section')?.id).toBe(
      'layer-run-path'
    )
    // The same bar under the stop.
    const bars = Array.from(document.querySelectorAll('nav.step-nav'))
    expect(bars).toHaveLength(2)
    expect(bars[1]?.previousElementSibling?.querySelector('section')?.id).toBe('layer-run-path')
    expect(bars[1]?.innerHTML).toBe(bars[0]?.innerHTML)
    expect(document.querySelector('nav.rail a[aria-current]')?.getAttribute('href')).toBe('#layer-run-path')
  })

  it('shows a point’s stop through a lens on its card, its chunk and its row, under a page at its top', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    document
      .querySelector('#stop-nav a[href="#point-p-1"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(window.location.hash).toBe('#point-p-1')
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(lensed()?.id).toBe('layer-run-path')
    expect(lensed()?.getAttribute('data-lens')).toBe('point')
    const point = artifact.points.find(p => p.id === 'p-1')
    const entry = artifact.files.find(f => f.path === point?.path)
    if (point === undefined || entry === undefined) throw new Error('fixture changed')
    const lens = document.querySelector('#stop-lens')?.textContent ?? ''
    expect(lens).toContain('data-fingerprint="fp-1"')
    expect(lens).toContain(`data-hunk="${cssEscape(hunkIdForPoint(point, entry))}"`)
    expect(document.querySelectorAll('#point-p-1')).toHaveLength(1)
    expect(document.querySelector('nav.rail a[aria-current]')?.getAttribute('href')).toBe('#point-p-1')
  })

  it('keeps the focus on the bar after a step from it: the same way, else the way the new bar has', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    /** @param {string} selector */
    const press = selector => {
      const link = document.querySelector(selector)
      if (!(link instanceof HTMLElement)) throw new Error(`no ${selector}`)
      link.focus()
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }
    // The bar under the stop gives the focus to the bar over the next one, which is on screen.
    press('nav.step-nav:not(#stop-nav) a[data-way="on"]')
    expect(window.location.hash).toBe('#point-p-1')
    expect(document.activeElement?.closest('nav')?.id).toBe('stop-nav')
    expect(document.activeElement?.getAttribute('href')).toBe('#layer-other')
    press('#stop-nav a[data-way="back"]')
    expect(document.activeElement?.getAttribute('href')).toBe('#overview')
    // The overview's bar has no way back, so the focus goes to its way on.
    press('#stop-nav a[data-way="back"]')
    expect(window.location.hash).toBe('#overview')
    expect(document.activeElement?.textContent).toBe('start with Layer 1: Run path →')
  })

  it('leaves the focus where it is after a step that no bar made', () => {
    const rail = document.querySelector('nav.rail a[href="#point-p-1"]')
    if (!(rail instanceof HTMLElement)) throw new Error('no rail link')
    rail.focus()
    view?.step(1, () => true)
    expect(document.activeElement).toBe(rail)
  })

  it('shows the stop of a point of the Other layer, which has its row in the diff only', () => {
    window.location.hash = '#point-p-2'
    window.dispatchEvent(new Event('hashchange'))
    expect(shown()).toEqual(['layer-other'])
    expect(lensed()?.getAttribute('data-lens')).toBe('point')
    expect(document.querySelector('tr.ifind[data-fingerprint="fp-2"]')).not.toBeNull()
  })

  it('moves to the stop that shows a target, and to the layers for one no stop shows', () => {
    reveal('#point-p-1')
    expect(lensed()?.getAttribute('data-lens')).toBe('point')
    reveal('#layer-run-path')
    expect(lensed()?.getAttribute('data-lens')).toBe('layer')
    reveal('article.file[data-layer="run-path"][data-path="src/new-name.ts"]')
    expect(view?.view).toBe('one')
    expect(seen).toEqual(['one'])
    // The page says why the view changed under the reader.
    expect(document.querySelector('.toast')?.textContent).toBe(
      'no stop shows this, so it opens in the layers'
    )
    expect(document.querySelector('.toast')?.getAttribute('data-tone')).toBe('note')
    expect(lensed()).toBeNull()
    // The stops' bar goes; one layer at a time puts its own around the layer.
    expect(document.querySelector('#stop-nav')?.getAttribute('aria-label')).toBe('Layers')
    expect(shown()).toEqual(['layer-run-path'])
  })

  it('opens a layer’s tests in its stop, and closes them when it goes, as the layers had them', () => {
    const tests = () => document.querySelector('#layer-run-path details.test-map')
    expect(tests()).toHaveProperty('open', true)
    view?.step(1, () => true)
    expect(tests()).toHaveProperty('open', false)
    // Tests the reader opened in the layers stay open after the stop.
    view?.step(-1, () => true)
    view?.switchView('all')
    const opened = tests()
    if (opened instanceof HTMLDetailsElement) opened.open = true
    view?.switchView('points', '#layer-run-path')
    view?.step(1, () => true)
    expect(tests()).toHaveProperty('open', true)
  })

  it('shows a stop from the top of the page, and scrolls to a point’s row only when it is further down', () => {
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    // The rail's link, as the bar's: a point of the Other layer stands for its row in the diff.
    document
      .querySelector('nav.rail a[href="#point-p-2"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(lensed()?.id).toBe('layer-other')
    expect(scrolled).toHaveBeenLastCalledWith({ top: 0 })
    const row = document.querySelector('tr.ifind[data-fingerprint="fp-2"]')
    if (!(row instanceof HTMLElement)) throw new Error('no row')
    const centered = vi.fn()
    row.scrollIntoView = centered
    // A key on the same stop, with the row on screen and then below the fold.
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 100, 30))
    expect(view?.step(1, () => true, true)).toBe(row)
    expect(centered).not.toHaveBeenCalled()
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, window.innerHeight + 200, 100, 30))
    expect(view?.step(1, () => true, true)).toBe(row)
    expect(scrolled).toHaveBeenLastCalledWith({ top: 0 })
    expect(centered).toHaveBeenCalledWith({ block: 'center' })
    scrolled.mockRestore()
  })

  it('steps through the stops that fit, the one on screen first when asked, and stops at either end', () => {
    const any = () => true
    const layers = (/** @type {import('./point-steps.js').Stop} */ s) => s.kind === 'layer'
    const points = (/** @type {import('./point-steps.js').Stop} */ s) => s.kind === 'point'
    expect(view?.step(-1, any)).toBeNull()
    expect(view?.step(1, any)?.id).toBe('point-p-1')
    expect(window.location.hash).toBe('#point-p-1')
    expect(view?.step(1, points, true)?.id).toBe('point-p-1')
    expect(view?.step(1, points)?.getAttribute('data-fingerprint')).toBe('fp-2')
    expect(view?.step(1, layers)).toBeNull()
    expect(view?.step(-1, layers)?.id).toBe('layer-other')
    view?.setView('all')
    expect(view?.step(1, any)).toBeUndefined()
  })

  it('switches from a point of the Other layer, which has no card, to its layer', () => {
    window.location.hash = '#point-p-2'
    window.dispatchEvent(new Event('hashchange'))
    expect(lensed()?.id).toBe('layer-other')
    view?.switchView('one')
    expect(shown()).toEqual(['layer-other'])
    expect(window.location.hash).toBe('#point-p-2')
  })

  it('marks every history entry a stop shows, and none the layers show, so back in the layers knows a stop’s scroll', () => {
    expect(window.history.state).toEqual({ stop: true })
    view?.step(1, () => true)
    expect(window.location.hash).toBe('#point-p-1')
    expect(window.history.state).toEqual({ stop: true })
    view?.switchView('all')
    expect(window.history.state).toBeNull()
    view?.switchView('points')
    expect(window.history.state).toEqual({ stop: true })
  })

  it('comes back from the layers to the stop the URL still names in the layer being read', () => {
    view?.step(1, () => true)
    view?.switchView('one')
    expect(window.location.hash).toBe('#point-p-1')
    expect(shown()).toEqual(['layer-run-path'])
    view?.switchView('points')
    expect(window.location.hash).toBe('#point-p-1')
    expect(lensed()?.getAttribute('data-lens')).toBe('point')
    // The URL's stop counts only while its layer is the one the rail marks as being read.
    view?.switchView('all')
    markRailCurrent(document, 'layer-other')
    view?.switchView('points')
    expect(window.location.hash).toBe('#layer-other')
  })

  it('comes back from the overview to the stop the URL names, where a narrow screen puts the switch', () => {
    view?.step(1, () => true)
    view?.switchView('all')
    // The reader scrolled up past the overview to reach the switch.
    markRailCurrent(document, 'overview')
    view?.switchView('points')
    expect(window.location.hash).toBe('#point-p-1')
    expect(lensed()?.getAttribute('data-lens')).toBe('point')
    // One layer at a time still opens on the overview.
    view?.switchView('all')
    markRailCurrent(document, 'overview')
    view?.switchView('one')
    expect(shown()).toEqual(['overview'])
  })

  it('switches to the layers on the place being read, and back to its stop', () => {
    view?.step(1, () => true)
    view?.switchView('all')
    expect(window.location.hash).toBe('#point-p-1')
    expect(shown()).toEqual(['overview', 'layer-run-path', 'layer-other'])
    expect(lensed()).toBeNull()
    view?.switchView('points', '#layer-other')
    expect(shown()).toEqual(['layer-other'])
    expect(lensed()?.getAttribute('data-lens')).toBe('layer')
    expect(window.location.hash).toBe('#layer-other')
    expect(seen).toEqual(['all', 'points'])
  })
})

describe('a missing behavior’s row in the one-point view', () => {
  it('leads from the layer’s stop to the point publish made for the behavior', () => {
    const published = publishedSyntheticArtifact()
    // The behavior's point shares its chunk with the layer's decision, which sorts first.
    const missing = published.points.find(p => p.origin === 'tests')
    expect(published.points[0]?.path).toBe(missing?.path)
    setRenderContext({
      artifact: published,
      headSha: published.pr.headSha,
      mergeBaseSha: published.pr.mergeBaseSha,
      files: published.files,
      patches: toPatchMap(SYNTHETIC_FILES),
      comments: [],
      state,
      now: new Date('2026-10-21T10:00:00.000Z'),
    })
    defineLayerElements()
    window.history.replaceState(null, '', '/review/7')
    draw(
      `${renderRail(published, state, { points: true, switchable: true })}<main><section class="panel" id="overview"></section>${renderLayers(published, published.files, state, [])}</main>`
    )
    const view = initOneLayer(document.body, { view: 'points', layersView: 'all' })
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    try {
      expect(document.querySelector('[data-lens]')?.getAttribute('data-lens')).toBe('layer')
      Array.from(document.querySelectorAll('details.test-map a'))
        .find(a => a.textContent === 'See its attention point')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      expect(window.location.hash).toBe(`#point-${missing?.id}`)
      expect(document.querySelector('#stop-lens')?.textContent).toContain(
        `data-fingerprint="${cssEscape(missing?.fingerprint ?? '')}"`
      )
    } finally {
      scrollTo.mockRestore()
      view.stop()
      setRenderContext(null)
    }
  })
})

describe('the one-layer view on a rendered page', () => {
  /** @type {ReturnType<typeof initOneLayer> | null} */
  let view = null

  beforeEach(() => {
    setRenderContext({
      artifact,
      headSha: artifact.pr.headSha,
      mergeBaseSha: artifact.pr.mergeBaseSha,
      files: artifact.files,
      patches: toPatchMap(SYNTHETIC_FILES),
      comments: [],
      state,
      now: new Date('2026-10-21T10:00:00.000Z'),
    })
    defineLayerElements()
    window.history.replaceState(null, '', '/review/7#layer-run-path')
    draw(
      `${renderRail(artifact, state, {})}<main><section class="panel" id="overview"></section>${renderLayers(artifact, artifact.files, state, [])}</main>`
    )
    view = initOneLayer(document.body, { view: 'one' })
  })

  afterEach(() => {
    view?.stop()
    setRenderContext(null)
    vi.restoreAllMocks()
  })

  const bars = () => Array.from(document.querySelectorAll('nav.step-nav'))
  /** @param {string} selector */
  const press = selector => {
    const link = document.querySelector(selector)
    if (!(link instanceof HTMLElement)) throw new Error(`no ${selector}`)
    link.focus()
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }

  it('puts the same bar over the layer on screen and under it', () => {
    const [top, end] = bars()
    expect(bars()).toHaveLength(2)
    expect(top?.id).toBe('stop-nav')
    expect(top?.getAttribute('aria-label')).toBe('Layers')
    expect(end?.getAttribute('aria-label')).toBe('Layers, at the end')
    expect(top?.nextElementSibling?.querySelector('section')?.id).toBe('layer-run-path')
    expect(end?.previousElementSibling?.querySelector('section')?.id).toBe('layer-run-path')
    expect(end?.innerHTML).toBe(top?.innerHTML)
  })

  it('steps from the bar under a page at its top, with the URL, history and focus a rail link gives', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const pushState = vi.spyOn(window.history, 'pushState')
    press('nav.step-nav:not(#stop-nav) a[data-way="on"]')
    expect(window.location.hash).toBe('#layer-other')
    expect(pushState).toHaveBeenCalledWith({ stop: true }, '', '#layer-other')
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(document.querySelector('#layer-other')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('#layer-run-path')?.hasAttribute('hidden')).toBe(true)
    // The last layer leads to the first open one, so the focus keeps its way.
    expect(document.activeElement?.closest('nav')?.id).toBe('stop-nav')
    expect(document.activeElement?.textContent).toBe('next open layer: Run path →')
    press('#stop-nav a[data-way="back"]')
    press('#stop-nav a[data-way="back"]')
    expect(window.location.hash).toBe('#overview')
    // The overview's bar has no way back, so the focus goes to its way on.
    expect(document.activeElement?.textContent).toBe('start with Layer 1: Run path →')
  })

  it('reads the reviewed mark off the page when it draws the bar of the last layer', () => {
    document.querySelector('#layer-run-path')?.classList.add('is-reviewed')
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    press('nav.rail a[href="#layer-other"]')
    expect(document.querySelector('#stop-nav [data-way="on"]')).toBeNull()
    expect(document.querySelector('#stop-nav .step-n')?.textContent).toBe('every other layer is reviewed')
  })

  it('opens a section at the top for the keys only in this view, and takes the bar off in the others', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    const other = document.querySelector('#layer-other')
    expect(view?.openAtTop(other)).toBe(true)
    expect(other?.hasAttribute('hidden')).toBe(false)
    expect(view?.openAtTop(document.querySelector('#layer-other article.file'))).toBe(false)
    expect(view?.openAtTop(null)).toBe(false)
    view?.switchView('all')
    expect(bars()).toHaveLength(0)
    expect(view?.openAtTop(other)).toBe(false)
  })
})
