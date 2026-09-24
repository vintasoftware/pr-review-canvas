// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initScrollSpy } from './scroll-spy.js'

/** @type {{ stop: () => void } | undefined} */
let spy
/** @type {Record<string, number>} */
let tops
/** @type {() => void} */
let resized

const selected = () =>
  Array.from(document.querySelectorAll('.rail a[aria-current]'), a => a.getAttribute('href'))

beforeEach(() => {
  vi.useFakeTimers()
  tops = { overview: 40, 'layer-auth': 600, 'layer-storage': 1400, 'layer-other': 2200 }
  document.body.innerHTML = `<nav class="rail">
    <a href="#overview" aria-current="location">Overview</a>
    <a href="#layer-auth">Auth</a><a href="#layer-storage">Storage</a>
    <a href="#layer-other">Other</a></nav>
    <main><section id="overview"></section><section id="layer-auth"></section>
    <section id="layer-storage"></section><section id="layer-other"></section></main>`
  for (const section of document.querySelectorAll('main section')) {
    vi.spyOn(section, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(240, tops[section.id], 800, 400)
    )
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(/** @type {() => void} */ callback) {
        resized = callback
      }
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  spy?.stop()
  spy = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function scroll() {
  window.dispatchEvent(new Event('scroll'))
  vi.advanceTimersByTime(20)
}

describe('initScrollSpy', () => {
  it('follows scrolling down, jumping over layers, and returning to Overview', () => {
    spy = initScrollSpy(document.body)
    expect(selected()).toEqual(['#overview'])
    tops = { overview: -700, 'layer-auth': -140, 'layer-storage': 660, 'layer-other': 1460 }
    scroll()
    expect(selected()).toEqual(['#layer-auth'])
    tops = { overview: -2200, 'layer-auth': -1640, 'layer-storage': -840, 'layer-other': -40 }
    scroll()
    expect(selected()).toEqual(['#layer-other'])
    tops = { overview: 40, 'layer-auth': 600, 'layer-storage': 1400, 'layer-other': 2200 }
    scroll()
    expect(selected()).toEqual(['#overview'])
  })

  it('never marks a hidden section, so one layer at a time marks the layer that shows', () => {
    // Nothing reaches the upper third, so the first section that shows is the one marked.
    for (const id of ['overview', 'layer-auth']) {
      const hidden = document.getElementById(id)
      if (hidden !== null) {
        hidden.hidden = true
      }
    }
    spy = initScrollSpy(document.body)
    expect(selected()).toEqual(['#layer-storage'])
    tops = { overview: 0, 'layer-auth': 0, 'layer-storage': -900, 'layer-other': 100 }
    scroll()
    expect(selected()).toEqual(['#layer-other'])
  })

  it('reads the initial scroll position without changing the URL or focus', () => {
    tops = { overview: -1200, 'layer-auth': -640, 'layer-storage': 160, 'layer-other': 960 }
    const hash = window.location.hash
    const focus = document.activeElement
    spy = initScrollSpy(document.body)
    expect(selected()).toEqual(['#layer-storage'])
    expect(window.location.hash).toBe(hash)
    expect(document.activeElement).toBe(focus)
  })

  it('updates after content changes size and after the viewport resizes', () => {
    spy = initScrollSpy(document.body)
    tops['layer-auth'] = 100
    resized()
    vi.advanceTimersByTime(20)
    expect(selected()).toEqual(['#layer-auth'])
    tops['layer-auth'] = 600
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(20)
    expect(selected()).toEqual(['#overview'])
  })

  it('skips rail links that name no section, and follows the ones that do', () => {
    const rail = document.querySelector('nav.rail')
    rail?.insertAdjacentHTML('afterbegin', '<a href="#">Top</a><a href="#layer-gone">Gone</a><a>No href</a>')
    spy = initScrollSpy(document.body)
    expect(selected()).toEqual(['#overview'])
    tops = { overview: -700, 'layer-auth': -140, 'layer-storage': 660, 'layer-other': 1460 }
    scroll()
    expect(selected()).toEqual(['#layer-auth'])
  })

  it('marks nothing when the rail names no section at all', () => {
    document.body.innerHTML = '<nav class="rail"><a href="#gone">Gone</a></nav><main></main>'
    spy = initScrollSpy(document.body)
    scroll()
    expect(selected()).toEqual([])
  })

  it('finds the current links after the sidebar is redrawn', () => {
    spy = initScrollSpy(document.body)
    const rail = document.querySelector('.rail')
    if (rail === null) {
      throw new Error('missing rail')
    }
    rail.innerHTML = '<a href="#overview">Overview</a><a href="#layer-auth">Auth</a>'
    tops['layer-auth'] = 100
    scroll()
    expect(selected()).toEqual(['#layer-auth'])
  })

  it('cancels a pending update and removes listeners when stopped', () => {
    spy = initScrollSpy(document.body)
    tops['layer-auth'] = 100
    window.dispatchEvent(new Event('scroll'))
    spy.stop()
    scroll()
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(20)
    expect(selected()).toEqual(['#overview'])
  })

  it('handles a screen without review sections', () => {
    document.body.innerHTML = '<main>No canvas yet</main>'
    spy = initScrollSpy(document.body)
    scroll()
    expect(selected()).toEqual([])
  })
})
