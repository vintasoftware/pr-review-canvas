// @ts-check
// One layer at a time. With `layerView: one` the page shows the overview or a single layer
// section and hides the rest, so the rail is how the reader moves between layers and the page
// scrolls through one layer only. Whatever brings something on screen (a rail link, the j/k and
// n/p keys, a canvas link) shows the section that holds it first, so nothing the reader is sent
// to stays hidden. A review mark is the exception: it moves on to the next card only inside the
// layer on screen. With `all` this module does nothing.
import { cssEscape } from './anchors.js'
import { decodeHash, plainClick } from './deep-link.js'
import { scrollIntoViewSafe } from './dom.js'
import { setCardCollapsed } from './layers.js'

/** @typedef {import('./layer-views.js').LayerView} LayerView */

/** The overview and every layer section: the parts of the page the rail links to. */
const SECTION_SELECTOR = '#overview, pr-layer > section'

/**
 * The sections of the page, in page order.
 * @param {ParentNode} root
 * @returns {HTMLElement[]}
 */
export function pageSections(root) {
  return Array.from(root.querySelectorAll(SECTION_SELECTOR)).filter(
    /** @returns {el is HTMLElement} */ el => el instanceof HTMLElement
  )
}

/**
 * True for an element in a section the page is not showing, whatever else hides it inside that
 * section, such as its closed layer. It hides nothing for good: `reveal-code` on anything inside
 * it shows the section.
 * @param {Element} el
 */
export function inHiddenSection(el) {
  return el.closest(SECTION_SELECTOR)?.hasAttribute('hidden') === true
}

/**
 * True for the overview or a layer section, the elements one layer at a time shows and hides.
 * @param {Element} el
 */
export function isPageSection(el) {
  return el.matches(SECTION_SELECTOR)
}

/**
 * The section that holds an element, itself when it is one, or null for an element outside every
 * section, such as the header or the chat pane.
 * @param {ParentNode} root
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null}
 */
export function sectionOf(root, target) {
  if (!(target instanceof Element)) {
    return null
  }
  const section = target.closest(SECTION_SELECTOR)
  return section instanceof HTMLElement && root.contains(section) ? section : null
}

/**
 * Shows one section and hides the others. The `hidden` attribute does the hiding, so the styles
 * of a section never fight it and the scrollspy skips what is hidden.
 * @param {ParentNode} root
 * @param {HTMLElement} section
 */
export function showOnly(root, section) {
  for (const other of pageSections(root)) {
    other.hidden = other !== section
  }
}

/**
 * The element a plain fragment names, `#layer-auth` or `#overview`. A canvas link (`#file:`,
 * `#line:`, …) names no element and is deep-link.js's to follow; it reveals its target on the way.
 * @param {ParentNode} root
 * @param {string} hash
 * @returns {HTMLElement | null}
 */
export function elementForHash(root, hash) {
  const id = decodeHash(hash.startsWith('#') ? hash.slice(1) : hash)
  const el = id === '' ? null : root.querySelector(`#${cssEscape(id)}`)
  return el instanceof HTMLElement ? el : null
}

/**
 * Keeps one section on screen at a time while the view is `one`, and gets out of the way while
 * it is `all`. Made once for the app element; `redraw` runs after every render, before the deep
 * links follow the URL, so a link into a layer lands on a layer that is showing. The URL names
 * the section on the first draw; after that the section last shown is the reader's place.
 * @param {HTMLElement} root
 * @param {{ view: LayerView, win?: Window }} opts
 * @returns {{ stop: () => void, setView: (view: LayerView) => void, redraw: () => void }}
 */
export function initOneLayer(root, opts) {
  const win = opts.win ?? window
  let view = opts.view
  /**
   * The fragment of the section on screen while the view is `one`, empty before the first draw.
   * A fragment and not the element, since a render replaces the sections.
   */
  let shownHash = ''
  const listeners = new AbortController()

  /** @param {HTMLElement} section */
  const showSection = section => {
    showOnly(root, section)
    if (section.matches('section.layer')) setCardCollapsed(section, false)
    const details = section.querySelector(':scope > details')
    if (details instanceof HTMLDetailsElement) details.open = true
    shownHash = `#${section.id}`
  }

  /** @param {HTMLElement | null} section */
  const show = section => {
    if (view === 'one' && section !== null && section.hidden) {
      showSection(section)
    }
  }

  /** @param {string} fragment */
  const sectionFor = fragment => sectionOf(root, elementForHash(root, fragment))

  /**
   * A plain fragment, such as a rail link or the `#layer-…` that `j` and `k` leave in the URL, is
   * one the browser scrolls to on its own, so nothing raises `reveal-code` on its target: it is
   * raised here, which shows the target's section and opens the layer or file it names.
   * @param {string} fragment
   */
  const revealFragment = fragment => {
    elementForHash(root, fragment)?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
  }

  const redraw = () => {
    revealFragment(win.location.hash)
    if (view === 'all') {
      for (const section of pageSections(root)) {
        section.hidden = false
      }
      return
    }
    const section = sectionFor(shownHash) ?? sectionFor(win.location.hash) ?? pageSections(root)[0] ?? null
    if (section !== null) {
      showSection(section)
    }
  }

  // Everything that scrolls to a target raises `reveal-code` on it first; a target inside a
  // hidden layer brings that layer on screen the same way it opens a code fold around it.
  root.addEventListener('reveal-code', event => show(sectionOf(root, event.target)), {
    signal: listeners.signal,
  })

  // A rail link or a "more chunks in layer 4" link is a plain fragment: what it names opens here,
  // before the browser's own scroll runs.
  root.addEventListener(
    'click',
    event => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null
      // A modified click opens the link in a new tab and leaves this page where it is.
      if (link !== null && plainClick(/** @type {MouseEvent} */ (event))) {
        revealFragment(link.getAttribute('href') ?? '')
      }
    },
    { signal: listeners.signal }
  )

  // Back and forward between plain fragments: what the fragment names opens, and when its section
  // was hidden the browser could not scroll to it, so the scroll is repeated here.
  win.addEventListener(
    'hashchange',
    () => {
      const el = elementForHash(root, win.location.hash || '#overview')
      if (el === null) return
      if (sectionOf(root, el)?.hidden === true) {
        scrollIntoViewSafe(el, 'start')
      } else {
        revealFragment(win.location.hash)
      }
    },
    { signal: listeners.signal }
  )

  redraw()

  return {
    stop: () => listeners.abort(),
    setView(next) {
      if (next !== view) {
        view = next
        // Coming from `all`, the reader is on the section the rail marks as being read.
        shownHash = root.querySelector('nav.rail a[aria-current]')?.getAttribute('href') ?? ''
        redraw()
      }
    },
    redraw,
  }
}
