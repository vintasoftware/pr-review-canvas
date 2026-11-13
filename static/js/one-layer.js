// @ts-check
// One layer, or one attention point, at a time. With `layerView: one` the page shows the overview
// or a single layer section and hides the rest, so the rail is how the reader moves between layers
// and the page scrolls through one layer only. Whatever brings something on screen (a rail link,
// the j/k and n/p keys, a canvas link) shows the section that holds it first, so nothing the
// reader is sent to stays hidden. A review mark is the exception: it moves on to the next card
// only inside the layer on screen. With `points` the page shows one stop of the one-point view
// (`point-view.js`) the same way, under a page at its top, and a target no stop shows takes the
// page to its layers, with a note that says so. With `all` this module does nothing.
import { cssEscape } from './anchors.js'
import { toast } from './commands.js'
import { decodeHash, plainClick } from './deep-link.js'
import { scrollIntoViewSafe } from './dom.js'
import { layerAnchorId } from './keys.js'
import { getRenderContext, setCardCollapsed } from './layers.js'
import { clearStop, showStop, stopShowing, stopTarget } from './point-view.js'
import { stopsOf } from './point-steps.js'
import { markRailCurrent } from './scroll-spy.js'

/** @typedef {import('./layer-views.js').LayerView} LayerView */
/** @typedef {import('./layer-views.js').PageView} PageView */
/** @typedef {import('./point-steps.js').Stop} Stop */

/** The overview and every layer section: the parts of the page the rail links to. */
const SECTION_SELECTOR = '#overview, pr-layer > section'

/**
 * The state of a history entry the one-point view shows. Its scroll is a stop's, the top of the
 * page, so back or forward to it while the layers show goes to what its fragment names; every
 * other entry keeps the scroll the browser brings back.
 */
const STOP_ENTRY = { stop: true }

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
 * Keeps one section on screen at a time while the view is `one` or `points`, and gets out of the
 * way while it is `all`. Made once for the app element; `redraw` runs after every render, before
 * the deep links follow the URL, so a link into a layer lands on a layer that is showing. The URL
 * names the section on the first draw; after that the section last shown is the reader's place.
 * It owns the view on screen, and the layer view the settings choose, which the rail's switch
 * goes to from the one-point view; `onView` hears of every change of view.
 * @param {HTMLElement} root
 * @param {{ view: PageView, layersView?: LayerView, win?: Window, onView?: (view: PageView) => void }} opts
 *   `layersView` defaults to `view` when that is a layer view
 */
export function initOneLayer(root, opts) {
  const win = opts.win ?? window
  let view = opts.view
  /** @type {LayerView} */
  let layersView = opts.layersView ?? (view === 'points' ? 'all' : view)
  /**
   * The fragment of the section or stop on screen while one shows at a time, empty before the
   * first draw. A fragment and not the element, since a render replaces the sections.
   */
  let shownHash = ''
  const listeners = new AbortController()

  /** The stops of the canvas on the page, none before the first render. */
  const stops = () => {
    const ctx = getRenderContext()
    return ctx === null ? [] : stopsOf(ctx.artifact)
  }

  /** @param {ReadonlyArray<Stop>} all @param {string} fragment */
  const stopNamed = (all, fragment) => all.find(stop => stop.id === decodeHash(fragment.replace(/^#/, '')))

  /**
   * What a fragment names in every view: the element with that id, or what a stop shows, so a
   * point of the Other layer, which has no card, names its row in the diff.
   * @param {string} fragment
   */
  const targetFor = fragment => {
    const stop = stopNamed(stops(), fragment)
    return stop === undefined ? elementForHash(root, fragment) : stopTarget(root, stop)
  }

  /** @param {HTMLElement} section */
  const showSection = section => {
    showOnly(root, section)
    if (section.matches('section.layer')) setCardCollapsed(section, false)
    const details = section.querySelector(':scope > details')
    if (details instanceof HTMLDetailsElement) details.open = true
    shownHash = `#${section.id}`
  }

  /**
   * Shows a stop of the one-point view, or the overview for none.
   * @param {Stop | undefined} stop
   */
  const showPointStop = stop => {
    const ctx = getRenderContext()
    const section =
      stop === undefined ? elementForHash(root, '#overview') : sectionOf(root, stopTarget(root, stop))
    if (ctx === null || section === null) {
      return
    }
    showSection(section)
    shownHash = stop === undefined ? '#overview' : `#${stop.id}`
    showStop(root, section, stops(), stop, ctx.files, ctx.artifact)
    markRailCurrent(root, shownHash.slice(1))
    win.history.replaceState(STOP_ENTRY, '', win.location.href)
  }

  /** @param {HTMLElement | null} section */
  const show = section => {
    if (view !== 'all' && section !== null && section.hidden) {
      showSection(section)
    }
  }

  /** @param {string} fragment */
  const sectionFor = fragment => sectionOf(root, targetFor(fragment))

  /**
   * In the one-point view, the stop that shows `target`, the overview for a target in it, or the
   * layers for a target of a layer no stop shows.
   * @param {Element} target
   */
  const revealInPoints = target => {
    const section = sectionOf(root, target)
    const ctx = getRenderContext()
    if (section === null || ctx === null) {
      return
    }
    const all = stops()
    const current = stopNamed(all, shownHash)
    const stop = section.id === 'overview' ? undefined : stopShowing(all, target, ctx.files, current)
    if (section.id !== 'overview' && stop === undefined) {
      setView(layersView, `#${section.id}`)
      // The view changed under the reader, so the page says why.
      toast(root, 'no stop shows this, so it opens in the layers', { tone: 'note' })
    } else if (stop !== current) {
      showPointStop(stop)
    }
  }

  /**
   * A stop takes the place of the one before under a page at its top, whether a link, a key or
   * back and forward brought it. Only a point's row further down, which stands for a point of the
   * Other layer, is scrolled to from there.
   * @param {HTMLElement | null} target what the stop's fragment names
   */
  const showFromTop = target => {
    win.scrollTo({ top: 0 })
    if (target !== null && target.getBoundingClientRect().top >= win.innerHeight) {
      target.scrollIntoView({ block: 'center' })
    }
  }

  /**
   * In the one-point view, puts on screen what `fragment` names, under a page at its top. False
   * when it names nothing, or something that took the page to its layers.
   * @param {string} fragment
   */
  const followInPoints = fragment => {
    const el = targetFor(fragment)
    if (el !== null) {
      revealInPoints(el)
    }
    if (el === null || view !== 'points') {
      return false
    }
    showFromTop(el)
    return true
  }

  /**
   * A plain fragment, such as a rail link or the `#layer-…` that `j` and `k` leave in the URL, is
   * one the browser scrolls to on its own, so nothing raises `reveal-code` on its target: it is
   * raised here, which shows the target's section and opens the layer or file it names.
   * @param {string} fragment
   */
  const revealFragment = fragment => {
    targetFor(fragment)?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
  }

  const redraw = () => {
    const all = view === 'points' ? stops() : []
    if (all.length > 0) {
      // The one-point view opens where the URL points, else on its first stop.
      const fragment = shownHash || win.location.hash
      const el = targetFor(fragment)
      const ctx = getRenderContext()
      const stop = el === null || ctx === null ? undefined : stopShowing(all, el, ctx.files)
      showPointStop(el?.id === 'overview' ? undefined : (stop ?? all[0]))
      return
    }
    clearStop(root)
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

  /**
   * Where the reader is: the stop on screen, or in the layers the section being read (the rail's
   * mark while all show), or the stop the URL names in it, for a reader back from that stop. The
   * overview marked while all show also gives way to the URL's stop: on a narrow screen the rail,
   * and its switch, sit above the overview, so a reader scrolls up to it to tap the switch.
   */
  const placeNow = () => {
    const at =
      view === 'all'
        ? (root.querySelector('nav.rail a[aria-current]')?.getAttribute('href') ?? '')
        : shownHash
    const named = view === 'points' ? undefined : stopNamed(stops(), win.location.hash)
    const holds =
      named !== undefined &&
      (`#${layerAnchorId(named.layer.key)}` === at || (view === 'all' && at === '#overview'))
    return holds ? `#${named.id}` : at
  }

  /**
   * @param {PageView} next
   * @param {string} [place] where to open, as `#id`; by default where the reader is: the section
   *   the rail marks while all show, else the one on screen
   */
  const setView = (next, place) => {
    if (next === view) {
      return
    }
    const here = placeNow()
    // The points open on their first stop from the top of the page, not on the overview.
    shownHash =
      place ?? (next === 'points' && here === '#overview' ? `#${stops()[0]?.id ?? 'overview'}` : here)
    view = next
    // The rail is drawn for the new view first, so the stop the redraw shows is the one it marks.
    opts.onView?.(view)
    redraw()
  }

  // Everything that scrolls to a target raises `reveal-code` on it first; a target inside a
  // hidden layer brings that layer on screen the same way it opens a code fold around it.
  root.addEventListener(
    'reveal-code',
    event => {
      // A canvas with no stops shows its sections one at a time, as `one` does.
      if (view === 'points' && event.target instanceof Element && stops().length > 0) {
        revealInPoints(event.target)
      } else {
        show(sectionOf(root, event.target))
      }
    },
    { signal: listeners.signal }
  )

  // A rail link or a "more chunks in layer 4" link is a plain fragment: what it names opens here,
  // before the browser's own scroll runs. In the one-point view a stop takes the place of the one
  // before, under a page that stays at the top.
  root.addEventListener(
    'click',
    event => {
      const link =
        event.target instanceof Element ? event.target.closest('a[href^="#"]:not([data-act])') : null
      // A modified click opens the link in a new tab and leaves this page where it is.
      if (link === null || !plainClick(/** @type {MouseEvent} */ (event))) {
        return
      }
      const href = link.getAttribute('href') ?? ''
      if (view !== 'points') {
        revealFragment(href)
      } else if (followInPoints(href)) {
        event.preventDefault()
        win.history.pushState(STOP_ENTRY, '', href)
      }
    },
    { signal: listeners.signal }
  )

  // Back and forward between plain fragments: what the fragment names opens. The scroll is
  // repeated here when the browser could not scroll to it, its section hidden, or when it brought
  // back a stop's scroll, which means nothing in the layers.
  win.addEventListener(
    'hashchange',
    () => {
      const fragment = win.location.hash || '#overview'
      const wasPoints = view === 'points'
      if (wasPoints && followInPoints(fragment)) {
        return
      }
      const el = targetFor(fragment)
      if (el === null) return
      if (wasPoints || sectionOf(root, el)?.hidden === true) {
        scrollIntoViewSafe(el, 'start')
        return
      }
      revealFragment(win.location.hash)
      if (win.history.state?.stop === true) {
        el.scrollIntoView({ block: 'start' })
      }
    },
    { signal: listeners.signal }
  )

  redraw()

  return {
    stop: () => listeners.abort(),
    setView,
    /**
     * The rail's switch: `next` opens where the reader is, or on `place`, and the URL says so. A
     * view of one section at a time opens at its top; all the layers at once, on that place.
     * @param {PageView} next
     * @param {string} [place]
     */
    switchView(next, place) {
      // Out of the stops, the stop on screen; into them, where `setView` finds the reader.
      const from = place ?? (view === 'points' ? shownHash : undefined)
      setView(next, from)
      // Out of the stops the URL keeps the stop, which the layers show as its card or layer.
      const here = view === 'points' ? shownHash : from
      if (here !== undefined && here !== '') {
        win.history.replaceState(
          view === 'points' ? STOP_ENTRY : null,
          '',
          `${win.location.pathname}${win.location.search}${here}`
        )
      }
      const target = view !== 'all' || here === undefined ? null : targetFor(here)
      if (target === null) {
        win.scrollTo({ top: 0 })
      } else {
        scrollIntoViewSafe(target, 'start')
      }
    },
    /**
     * In the one-point view, shows the next or previous stop that `fits`, as its links do, and
     * returns what it shows to take the focus: null at either end, undefined in the other views,
     * whose keys walk the layers. With `here`, the stop on screen comes first when it fits, for a
     * reader not on it yet.
     * @param {1 | -1} direction
     * @param {(stop: Stop) => boolean} fits
     * @param {boolean} [here]
     * @returns {HTMLElement | null | undefined}
     */
    step(direction, fits, here = false) {
      const all = view === 'points' ? stops() : []
      if (all.length === 0) {
        return undefined
      }
      const at = all.findIndex(stop => `#${stop.id}` === shownHash)
      const shown = all[at]
      const next =
        here && shown !== undefined && fits(shown)
          ? shown
          : direction === 1
            ? all.find((stop, index) => index > at && fits(stop))
            : all.findLast((stop, index) => at >= 0 && index < at && fits(stop))
      if (next === undefined) {
        return null
      }
      if (next !== shown) {
        showPointStop(next)
        win.history.pushState(STOP_ENTRY, '', `#${next.id}`)
      }
      const target = stopTarget(root, next)
      showFromTop(target)
      return target
    },
    redraw,
    /** The layer view the settings now choose, which the rail's switch goes to. */
    setLayersView(/** @type {LayerView} */ next) {
      layersView = next
    },
    get view() {
      return view
    },
    get layersView() {
      return layersView
    },
  }
}
