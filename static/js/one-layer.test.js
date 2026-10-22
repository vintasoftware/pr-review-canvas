// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAYER_VIEW, isLayerView, LAYER_VIEW_LABELS, LAYER_VIEWS } from './layer-views.js'
import { elementForHash, initOneLayer, pageSections, sectionOf, showOnly } from './one-layer.js'

/** @type {HTMLElement} */
let root
/** @type {ReturnType<typeof initOneLayer> | undefined} */
let oneLayer

const PAGE = `
    <header class="hdr"><button id="settings">settings</button></header>
    <nav class="rail"><ul>
      <li><a href="#overview" aria-current="location">Overview</a></li>
      <li><a href="#layer-auth">Auth</a></li>
      <li><a href="#layer-storage">Storage</a></li>
      <li><a href="#layer-other">Other</a></li>
    </ul></nav>
    <main id="main">
      <div class="stale-bar outdated-bar">outdated</div>
      <section class="panel" id="overview"><a href="#line:src/auth.ts:4" data-link="#line:src/auth.ts:4">line 4</a></section>
      <pr-layer><section class="layer" id="layer-auth"><article class="file" id="file-src_auth_ts"><table><tr id="src_auth_ts-new-4"><td>row</td></tr></table></article></section></pr-layer>
      <pr-layer><section class="layer" id="layer-storage"><div class="more-hunks"><a href="#layer-auth">2 more chunks in layer 1</a></div></section></pr-layer>
      <pr-layer><section class="panel" id="layer-other"><details></details></section></pr-layer>
    </main>`

beforeEach(() => {
  root = document.createElement('pr-app')
  root.innerHTML = PAGE
  document.body.replaceChildren(root)
})

afterEach(() => {
  oneLayer?.stop()
  oneLayer = undefined
  window.location.hash = ''
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** @param {string} id */
const section = id => {
  const el = root.querySelector(`#${id}`)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no #${id}`)
  }
  return el
}

const shownIds = () =>
  pageSections(root)
    .filter(s => !s.hidden)
    .map(s => s.id)

/** @param {Element | null} el */
const click = el => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

/** @param {Element | null} el */
const reveal = el => el?.dispatchEvent(new Event('reveal-code', { bubbles: true }))

describe('the layer views', () => {
  it('names three views, all by default, each with a label', () => {
    expect(LAYER_VIEWS).toEqual(['all', 'one', 'points'])
    expect(DEFAULT_LAYER_VIEW).toBe('all')
    expect(isLayerView('one')).toBe(true)
    expect(isLayerView('points')).toBe(true)
    expect(isLayerView('some')).toBe(false)
    expect(isLayerView(1)).toBe(false)
    expect(Object.keys(LAYER_VIEW_LABELS)).toEqual(['all', 'one', 'points'])
  })
})

describe('the sections of the page', () => {
  it('lists the overview and every layer in page order', () => {
    expect(pageSections(root).map(s => s.id)).toEqual([
      'overview',
      'layer-auth',
      'layer-storage',
      'layer-other',
    ])
  })

  it('finds the section that holds an element, and none for the header', () => {
    expect(sectionOf(root, root.querySelector('#src_auth_ts-new-4'))?.id).toBe('layer-auth')
    expect(sectionOf(root, section('layer-other'))?.id).toBe('layer-other')
    expect(sectionOf(root, root.querySelector('#settings'))).toBeNull()
    expect(sectionOf(root, null)).toBeNull()
    // An element of another tree is not on this page.
    const stray = document.createElement('section')
    stray.id = 'overview'
    document.body.appendChild(stray)
    expect(sectionOf(root, stray)).toBeNull()
  })

  it('shows one section and hides the rest', () => {
    showOnly(root, section('layer-storage'))
    expect(shownIds()).toEqual(['layer-storage'])
  })

  it('resolves a plain fragment to its element and leaves canvas links to the deep links', () => {
    expect(elementForHash(root, '#layer-auth')?.id).toBe('layer-auth')
    expect(elementForHash(root, 'overview')?.id).toBe('overview')
    expect(elementForHash(root, '#layer%2Dauth')?.id).toBe('layer-auth')
    expect(elementForHash(root, '#file:src/auth.ts')).toBeNull()
    expect(elementForHash(root, '#')).toBeNull()
    expect(elementForHash(root, '#nope')).toBeNull()
  })
})

describe('initOneLayer', () => {
  it('leaves every section on the page in the all view', () => {
    oneLayer = initOneLayer(root, { view: 'all' })
    expect(shownIds()).toHaveLength(4)
    // A target inside a layer changes nothing here.
    reveal(section('layer-auth'))
    expect(shownIds()).toHaveLength(4)
  })

  it('opens on the overview alone in the one view, and leaves the bar above the canvas', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    expect(shownIds()).toEqual(['overview'])
    expect(root.querySelector('.stale-bar')?.hasAttribute('hidden')).toBe(false)
  })

  it('opens on the layer the URL names', () => {
    window.location.hash = '#layer-storage'
    oneLayer = initOneLayer(root, { view: 'one' })
    expect(shownIds()).toEqual(['layer-storage'])
  })

  it('shows the layer that holds whatever is scrolled to', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    reveal(root.querySelector('#src_auth_ts-new-4'))
    expect(shownIds()).toEqual(['layer-auth'])
    // The overview again, the way `g o` gets there.
    reveal(section('overview'))
    expect(shownIds()).toEqual(['overview'])
    // A target outside every section, such as the chat pane, changes nothing.
    reveal(root.querySelector('#settings'))
    expect(shownIds()).toEqual(['overview'])
  })

  it('shows the layer a rail link or a "more chunks" link points at before the browser scrolls', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    click(root.querySelector('nav.rail a[href="#layer-storage"]'))
    expect(shownIds()).toEqual(['layer-storage'])
    click(root.querySelector('.more-hunks a'))
    expect(shownIds()).toEqual(['layer-auth'])
  })

  it('leaves a modified click, and one on no link, alone', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    root
      .querySelector('nav.rail a[href="#layer-storage"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(shownIds()).toEqual(['overview'])
    click(root.querySelector('#settings'))
    expect(shownIds()).toEqual(['overview'])
  })

  it('follows a hash change to a hidden layer and scrolls to it, since the browser could not', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    const scrolled = vi.fn()
    section('layer-other').scrollIntoView = scrolled
    window.location.hash = '#layer-other'
    window.dispatchEvent(new Event('hashchange'))
    expect(shownIds()).toEqual(['layer-other'])
    expect(scrolled).toHaveBeenCalledWith({ block: 'start' })
    // A hash change to the section already showing does nothing more.
    window.dispatchEvent(new Event('hashchange'))
    expect(scrolled).toHaveBeenCalledTimes(1)
    window.location.hash = ''
    window.dispatchEvent(new Event('hashchange'))
    expect(shownIds()).toEqual(['overview'])
  })

  it('switches views on the open page, keeping the section the rail marks as being read', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    // The URL still names where the reader was sent, not where they scrolled to since.
    window.location.hash = '#overview'
    oneLayer.setView('all')
    expect(shownIds()).toHaveLength(4)
    root.querySelector('nav.rail a[aria-current]')?.removeAttribute('aria-current')
    root.querySelector('nav.rail a[href="#layer-storage"]')?.setAttribute('aria-current', 'location')
    oneLayer.setView('one')
    expect(shownIds()).toEqual(['layer-storage'])
    // Setting the view it already has changes nothing.
    oneLayer.setView('one')
    expect(shownIds()).toEqual(['layer-storage'])
    // With no section marked, the URL names one.
    oneLayer.setView('all')
    root.querySelector('nav.rail a[aria-current]')?.removeAttribute('aria-current')
    oneLayer.setView('one')
    expect(shownIds()).toEqual(['overview'])
  })

  it('keeps the section on screen when the page is redrawn, whatever the URL says', () => {
    window.location.hash = '#layer-storage'
    oneLayer = initOneLayer(root, { view: 'one' })
    expect(shownIds()).toEqual(['layer-storage'])
    // Revealing code moves on to another layer without writing the URL.
    reveal(root.querySelector('#src_auth_ts-new-4'))
    root.innerHTML = PAGE
    expect(shownIds()).toHaveLength(4)
    oneLayer.redraw()
    expect(shownIds()).toEqual(['layer-auth'])
    // The listeners are on the element, so the new content is served by the same ones.
    reveal(root.querySelector('#src_auth_ts-new-4'))
    expect(shownIds()).toEqual(['layer-auth'])
  })

  it('stops listening when told to', () => {
    oneLayer = initOneLayer(root, { view: 'one' })
    oneLayer.stop()
    reveal(section('layer-auth'))
    expect(shownIds()).toEqual(['overview'])
  })

  it('does nothing on a screen without sections', () => {
    root.innerHTML = '<main id="main"><div class="empty">no canvas</div></main>'
    oneLayer = initOneLayer(root, { view: 'one' })
    oneLayer.redraw()
    expect(pageSections(root)).toEqual([])
  })
})

describe('the one-point view', () => {
  const STOPS = `
    <div class="point-steps" id="point-steps">
      <section class="point-step" id="step-p-1"><li class="finding" id="step-p-1-card"></li><nav class="step-nav"><a href="#step-p-2">next point</a></nav></section>
      <section class="point-step" id="step-p-2"><nav class="step-nav"><a href="#layer-auth">the rest of the diff</a></nav></section>
    </div>`

  beforeEach(() => {
    section('overview').insertAdjacentHTML('afterend', STOPS)
  })

  it('opens on the first point alone', () => {
    oneLayer = initOneLayer(root, { view: 'points' })
    expect(shownIds()).toEqual(['step-p-1'])
  })

  it('opens on the point the URL names', () => {
    window.location.hash = '#step-p-2'
    oneLayer = initOneLayer(root, { view: 'points' })
    expect(shownIds()).toEqual(['step-p-2'])
  })

  it('moves from point to point and on to the layers with the stops’ links', () => {
    oneLayer = initOneLayer(root, { view: 'points' })
    click(root.querySelector('#step-p-1 .step-nav a'))
    expect(shownIds()).toEqual(['step-p-2'])
    click(root.querySelector('#step-p-2 .step-nav a'))
    expect(shownIds()).toEqual(['layer-auth'])
  })

  it('still shows a layer that holds whatever is scrolled to, and the overview', () => {
    oneLayer = initOneLayer(root, { view: 'points' })
    reveal(root.querySelector('#src_auth_ts-new-4'))
    expect(shownIds()).toEqual(['layer-auth'])
    reveal(section('overview'))
    expect(shownIds()).toEqual(['overview'])
  })

  it('swaps a section in under a page that stays at the top, and records it in the URL', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    oneLayer = initOneLayer(root, { view: 'points' })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    root.querySelector('#step-p-1 .step-nav a')?.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(shownIds()).toEqual(['step-p-2'])
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(window.location.hash).toBe('#step-p-2')
    // Back and forward land in place too.
    window.location.hash = '#step-p-1'
    window.dispatchEvent(new Event('hashchange'))
    expect(shownIds()).toEqual(['step-p-1'])
    expect(scrollTo).toHaveBeenCalledTimes(2)
  })

  it('leaves the one-layer view and the all view to the browser’s own scroll', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    oneLayer = initOneLayer(root, { view: 'one' })
    const inOne = new MouseEvent('click', { bubbles: true, cancelable: true })
    root.querySelector('nav.rail a[href="#layer-storage"]')?.dispatchEvent(inOne)
    expect(inOne.defaultPrevented).toBe(false)
    expect(shownIds()).toEqual(['layer-storage'])
    oneLayer.setView('all')
    const inAll = new MouseEvent('click', { bubbles: true, cancelable: true })
    root.querySelector('nav.rail a[href="#layer-auth"]')?.dispatchEvent(inAll)
    expect(inAll.defaultPrevented).toBe(false)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('starts where the URL says, or at its first stop, when switched to from another view', () => {
    oneLayer = initOneLayer(root, { view: 'all' })
    root.querySelector('nav.rail a[href="#layer-auth"]')?.setAttribute('aria-current', 'location')
    window.location.hash = '#step-p-2'
    oneLayer.setView('points')
    expect(shownIds()).toEqual(['step-p-2'])
    oneLayer.setView('all')
    window.location.hash = ''
    oneLayer.setView('points')
    expect(shownIds()).toEqual(['step-p-1'])
  })
})
