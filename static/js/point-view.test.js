// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cssEscape } from './anchors.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { emptyState } from '../../src/contract/state.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { defineLayerElements, hunkIdForPoint, renderLayers, setRenderContext } from './layers.js'
import { initOneLayer } from './one-layer.js'
import { stopsOf } from './point-steps.js'
import { stopNavHtml } from './point-view.js'
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

  it('leads from the last stop to the layers, as the rail’s switch does', () => {
    draw(stopNavHtml(stops, 4, artifact))
    const on = document.querySelector('a[data-act="layer-view"]')
    expect(on?.getAttribute('data-view')).toBe('layers')
    expect(on?.getAttribute('href')).toBe('#layer-run-path')
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
    expect(document.querySelector('nav.step-nav')).toBeNull()
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
