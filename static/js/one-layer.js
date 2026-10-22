// @ts-check
// One layer at a time. With `layerView: one` the page shows the overview or a single layer
// section and hides the rest, so the rail is how the reader moves between layers and the page
// scrolls through one layer only. Whatever brings something on screen (a rail link, the j/k and
// n/p keys, a canvas link) shows the section that holds it first, so nothing the reader is sent
// to stays hidden. A review mark is the exception: it moves on to the next card only inside the
// layer on screen. With `points` it shows one stop of the one-point view at a time the same way
// (`point-view.js`), and a link to a whole section swaps it in under a page that stays at the top.
// With `all` this module does nothing.
import { cssEscape } from './anchors.js'
import { decodeHash, plainClick } from './deep-link.js'
import { scrollIntoViewSafe } from './dom.js'
import { setCardCollapsed } from './layers.js'

/** @typedef {import('./layer-views.js').LayerView} LayerView */

/** The overview, every stop of the one-point view, and every layer section: the parts of the page the rail links to. */
const SECTION_SELECTOR = '#overview, section.point-step, pr-layer > section'

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
 * True for an element that a section the page is not showing hides. It hides nothing for good:
 * `reveal-code` on anything inside it shows the section.
 * @param {Element} el
 */
export function inHiddenSection(el) {
  return el.closest('[hidden]')?.matches(SECTION_SELECTOR) === true
}

/**
 * True for the overview, a stop, or a layer section, the elements one at a time shows and hides.
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
 * Keeps one section on screen at a time while the view is `one` or `points`, and gets out of the
 * way while it is `all`. Made once for the app element; `redraw` runs after every render, before the deep
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
   * The fragment of the section on screen while one shows at a time, empty before the first draw.
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
    if (view !== 'all' && section !== null && section.hidden) {
      showSection(section)
    }
  }

  /** @param {string} fragment */
  const sectionFor = fragment => sectionOf(root, elementForHash(root, fragment))

  const redraw = () => {
    if (view === 'all') {
      for (const section of pageSections(root)) {
        section.hidden = false
      }
      return
    }
    // The one-point view opens on its first stop, and on the overview of a canvas with none.
    const firstStop = view === 'points' ? root.querySelector('section.point-step') : null
    const section =
      sectionFor(shownHash) ??
      sectionFor(win.location.hash) ??
      (firstStop instanceof HTMLElement ? firstStop : null) ??
      pageSections(root)[0] ??
      null
    if (section !== null) {
      showSection(section)
    }
  }

  // Everything that scrolls to a target raises `reveal-code` on it first; a target inside a
  // hidden layer brings that layer on screen the same way it opens a code fold around it.
  root.addEventListener('reveal-code', event => show(sectionOf(root, event.target)), {
    signal: listeners.signal,
  })

  /**
   * In the one-point view, a link to a whole section puts it in place of the one before, under a
   * page that stays at the top: the header and the rail do not scroll away, whatever the section's
   * height or where the reader was. True when it moved to the section `fragment` names, which the
   * URL then records.
   * @param {string} fragment
   */
  const swapInPlace = fragment => {
    const target = elementForHash(root, fragment)
    if (view !== 'points' || target === null || !isPageSection(target)) {
      return false
    }
    show(target)
    win.scrollTo({ top: 0 })
    return true
  }

  // A rail link or a "more chunks in layer 4" link is a plain fragment the browser scrolls to on
  // its own; its section is shown here, before that default scroll runs.
  root.addEventListener(
    'click',
    event => {
      const link = event.target instanceof Element ? event.target.closest('a[href^="#"]') : null
      // A modified click opens the link in a new tab and leaves this page where it is.
      if (link === null || !plainClick(/** @type {MouseEvent} */ (event))) {
        return
      }
      const href = link.getAttribute('href') ?? ''
      if (swapInPlace(href)) {
        event.preventDefault()
        win.history.pushState(null, '', href)
      } else {
        show(sectionOf(root, elementForHash(root, href)))
      }
    },
    { signal: listeners.signal }
  )

  // Back and forward between plain fragments: the browser has already tried to scroll to the
  // target, and could not while its section was hidden, so the scroll is repeated here.
  win.addEventListener(
    'hashchange',
    () => {
      if (swapInPlace(win.location.hash || '#overview')) {
        return
      }
      const el = elementForHash(root, win.location.hash || '#overview')
      const section = sectionOf(root, el)
      if (el !== null && section?.hidden === true) {
        scrollIntoViewSafe(el, 'start')
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
        // Coming from `all`, the reader is on the section the rail marks as being read. The
        // one-point view starts where the URL points, else from its first stop.
        shownHash =
          next === 'points'
            ? ''
            : (root.querySelector('nav.rail a[aria-current]')?.getAttribute('href') ?? '')
        redraw()
      }
    },
    redraw,
  }
}
