// @ts-check
// @vitest-environment happy-dom
// Canvas links as navigation: a click on a link in the page, the fragment the page was opened
// with, and every later hashchange.
import { emptyState } from '../../src/contract/state.js'
import { toPatchMap } from '../../src/git/diff-collector.js'
import { SYNTHETIC_FILES, syntheticArtifact } from '../../src/testing/synthetic.js'
import { decodeHash, followLink, initDeepLinks } from './deep-link.js'
import { renderMarkdown } from './markdown.js'

const NOW = new Date('2026-09-10T12:00:00.000Z')

/** A page with one rail item, one layer section, and one file card whose line 2 is folded away. */
function page() {
  document.body.innerHTML = `
    <nav class="rail"><ul class="tree">
      <li><a href="#overview" aria-current="location">Overview</a></li>
      <li><a href="#layer-auth">Auth</a></li>
    </ul></nav>
    <main>
      <section class="layer" id="layer-auth"></section>
      <article class="file" id="file-src_app_ts"><div class="file-body" hidden>
      <table class="diff" id="chunk-src_app_ts-1" data-key="src_app_ts"><tbody>
        <tr id="L-src_app_ts-new-1" class="ctx"></tr>
        <tr id="L-src_app_ts-new-2" class="add folded noise"></tr>
        <tr id="L-src_app_ts-new-3" class="add"></tr>
      </tbody></table></div></article>
    </main>`
  const root = document.body
  return root
}

/** @param {string} hash */
function setHash(hash) {
  window.location.hash = hash
}

/**
 * A click the delegated handler sees.
 * @param {Element | null} el
 * @param {MouseEventInit} [init]
 */
function click(el, init = {}) {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
  el?.dispatchEvent(event)
  return event
}

beforeEach(() => {
  setHash('')
})

describe('decodeHash', () => {
  it('decodes a percent-encoded fragment and keeps a malformed one as written', () => {
    expect(decodeHash('#line:src/app%20one.ts:4')).toBe('#line:src/app one.ts:4')
    expect(decodeHash('#line:src/app.ts:4')).toBe('#line:src/app.ts:4')
    expect(decodeHash('#line:bad%ZZ.ts:4')).toBe('#line:bad%ZZ.ts:4')
  })
})

describe('followLink', () => {
  beforeEach(page)

  it('opens the file body and lands on the row of a line link', () => {
    expect(followLink('#line:src/app.ts:3')).toBe(true)
    const row = document.querySelector('#L-src_app_ts-new-3')
    expect(row?.classList.contains('is-target')).toBe(true)
    expect(document.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('marks the rail item of a layer link', () => {
    expect(followLink('#layer:auth')).toBe(true)
    expect(document.querySelector('.rail a[aria-current]')?.getAttribute('href')).toBe('#layer-auth')
  })

  it('falls back to the nearest row when the line is folded as noise', () => {
    expect(followLink('#line:src/app.ts:2')).toBe(true)
    const row = document.querySelector('#L-src_app_ts-new-1')
    expect(row?.classList.contains('is-approx')).toBe(true)
    expect(row?.classList.contains('is-target')).toBe(true)
    expect(document.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
  })

  it('lands on the rows of a file card the page holds without the card element', () => {
    document.body.innerHTML = `<table class="diff" data-key="src_app_ts"><tbody>
      <tr id="L-src_app_ts-new-3" class="add"></tr></tbody></table>`
    expect(followLink('#line:src/app.ts:3')).toBe(true)
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
  })

  it('follows an older chunk bookmark to the current anchor', () => {
    expect(followLink('#hunk:src/app.ts#1')).toBe(true)
    expect(document.querySelector('#chunk-src_app_ts-1')?.classList.contains('is-target')).toBe(true)
  })

  it('jumps to a layer on a page that has no rail', () => {
    document.body.innerHTML = '<section class="layer" id="layer-auth"></section>'
    expect(followLink('#layer:auth')).toBe(true)
  })

  it('answers false for a link that does not parse and for a target the page does not hold', () => {
    expect(followLink('#section-2')).toBe(false)
    expect(followLink('')).toBe(false)
    expect(followLink('#file:src/gone.ts')).toBe(false)
    expect(followLink('#line:src/gone.ts:1')).toBe(false)
    expect(followLink('#chunk:src/app.ts#9')).toBe(false)
  })

  it('keeps a percent escape that belongs to the path', () => {
    // sanitizeKey turns every character outside [A-Za-z0-9_-] into `_`.
    document.body.innerHTML = `<table class="diff" data-key="src_a_20b_ts"><tbody>
      <tr id="L-src_a_20b_ts-new-3" class="add"></tr></tbody></table>`
    expect(followLink('#line:src/a%20b.ts:3')).toBe(true)
    expect(document.querySelector('#L-src_a_20b_ts-new-3')?.classList.contains('is-target')).toBe(true)
  })

  it('reads a percent-encoded fragment', () => {
    expect(followLink('#line%3Asrc/app.ts%3A3')).toBe(true)
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
  })
})

describe('initDeepLinks', () => {
  it('follows a click on a canvas link the markdown wrote and leaves the URL shareable', () => {
    const root = page()
    const note = document.createElement('div')
    note.innerHTML = renderMarkdown('See [line 3](#line:src/app.ts:3).')
    root.appendChild(note)
    const links = initDeepLinks(root)
    const anchor = note.querySelector('a[data-link]')
    expect(anchor?.getAttribute('data-link')).toBe('#line:src/app.ts:3')
    const event = click(anchor)
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
    expect(window.location.hash).toBe('#line:src/app.ts:3')
    links.stop()
  })

  it('leaves a rail link, a plain anchor, and a modified click to the browser', () => {
    const root = page()
    const links = initDeepLinks(root)
    const rail = document.querySelector('.rail a[href="#layer-auth"]')
    expect(click(rail).defaultPrevented).toBe(false)
    const note = document.createElement('div')
    note.innerHTML = '<a href="#line:src/app.ts:3" data-link="#line:src/app.ts:3">l</a>'
    root.appendChild(note)
    expect(click(note.querySelector('a'), { metaKey: true }).defaultPrevented).toBe(false)
    expect(click(note.querySelector('a'), { button: 1 }).defaultPrevented).toBe(false)
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(false)
    links.stop()
  })

  it('follows an anchor that carries the link in its href alone', () => {
    const root = page()
    const links = initDeepLinks(root)
    const note = document.createElement('div')
    note.innerHTML = '<a href="#layer:auth">auth</a>'
    root.appendChild(note)
    expect(click(note.querySelector('a')).defaultPrevented).toBe(true)
    expect(document.querySelector('#layer-auth')?.classList.contains('is-target')).toBe(true)
    links.stop()
  })

  it('ignores a click that lands on no element', () => {
    page()
    const links = initDeepLinks(document)
    expect(() => document.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))).not.toThrow()
    links.stop()
  })

  it('jumps to the fragment the page was opened with', () => {
    setHash('#line:src/app.ts:3')
    const root = page()
    const links = initDeepLinks(root)
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
    links.stop()
  })

  it('skips the first jump when the caller asks it to, and jumps on demand', () => {
    setHash('#line:src/app.ts:3')
    const root = page()
    const links = initDeepLinks(root, { jumpOnInit: false })
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(false)
    expect(links.followHash()).toBe(true)
    expect(links.follow('#layer:auth')).toBe(true)
    links.stop()
  })

  it('jumps on a hashchange and does nothing for a hash that is not a canvas link', () => {
    const root = page()
    const links = initDeepLinks(root)
    setHash('#line:src/app.ts:3')
    window.dispatchEvent(new window.Event('hashchange'))
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
    setHash('#not-a-canvas-link')
    expect(() => window.dispatchEvent(new window.Event('hashchange'))).not.toThrow()
    links.stop()
  })

  it('stops its listeners, so two renders never jump twice', () => {
    const root = page()
    const first = initDeepLinks(root)
    first.stop()
    const second = initDeepLinks(root)
    const note = document.createElement('div')
    note.innerHTML = '<a href="#line:src/app.ts:3" data-link="#line:src/app.ts:3">l</a>'
    root.appendChild(note)
    /** @type {Array<string | URL | null | undefined>} */
    const replaced = []
    const real = window.history.replaceState.bind(window.history)
    window.history.replaceState = (...args) => {
      replaced.push(args[2])
      real(...args)
    }
    click(note.querySelector('a'))
    window.history.replaceState = real
    expect(replaced).toEqual(['#line:src/app.ts:3'])
    second.stop()
  })

  it('keeps the jump when the view has no session history', () => {
    const root = page()
    const view = /** @type {Window} */ (
      /** @type {unknown} */ ({
        location: { hash: '' },
        history: {
          replaceState: () => {
            throw new Error('no history')
          },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      })
    )
    const links = initDeepLinks(root, { view })
    const note = document.createElement('div')
    note.innerHTML = '<a href="#line:src/app.ts:3" data-link="#line:src/app.ts:3">l</a>'
    root.appendChild(note)
    expect(() => click(note.querySelector('a'))).not.toThrow()
    expect(document.querySelector('#L-src_app_ts-new-3')?.classList.contains('is-target')).toBe(true)
    links.stop()
  })
})

describe('a rendered review screen', () => {
  it('lands on the line of the URL fragment, drawing the card it is in', async () => {
    const { defineLayerElements, renderLayers, renderRail, setRenderContext } = await import('./layers.js')
    const artifact = syntheticArtifact()
    const state = emptyState(NOW.toISOString())
    setRenderContext({
      artifact,
      files: artifact.files,
      patches: toPatchMap(SYNTHETIC_FILES),
      comments: [],
      state,
      now: NOW,
    })
    defineLayerElements()
    setHash('#line:src/app.ts:4')
    document.body.innerHTML = `${renderRail(artifact, state)}<main>${renderLayers(artifact, artifact.files, state, [])}</main>`
    const links = initDeepLinks(document.body)
    const row = document.querySelector('#L-src_app_ts-new-4')
    expect(row).not.toBeNull()
    expect(row?.classList.contains('is-target')).toBe(true)
    expect(links.follow('#layer:run-path')).toBe(true)
    expect(document.querySelector('.rail a[aria-current]')?.getAttribute('href')).toBe('#layer-run-path')
    links.stop()
  })
})
