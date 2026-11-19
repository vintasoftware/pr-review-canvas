// @ts-check
// The one-point-at-a-time view draws no copy of the canvas. A stop is the layer section that holds
// it, seen through a lens: a layer's stop shows the layer's heading, description and tests; a
// point's stop shows the layer's heading, the point's card, and only the chunk of its file that
// holds the point. Every card stays where the layers drew it, so links, keys and commands work on
// it as they do in the layers. A bar over the stop leads back and on; after the last stop, to the
// layers. One layer at a time puts the same bar around its layer. `one-layer.js` decides which
// stop or layer is on screen.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./point-steps.js').Layer} Layer */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./point-steps.js').Stop} Stop */
import { cssEscape, drawCardOf } from './anchors.js'
import { esc } from './dom.js'
import { titleHtml } from './markdown.js'
import { layerAnchorId } from './keys.js'
import { hunkIdForPoint } from './layers.js'
import { expandOpenPoint } from './points.js'

const LENS_ID = 'stop-lens'
const NAV_ID = 'stop-nav'
/** Marks the tests a layer's stop opened, which close when it goes. */
const OPENED_ATTR = 'data-stop-opened'

/**
 * The stop that shows `el`, `current` when it is one of them, or undefined for an element of a
 * layer section no stop shows.
 * @param {ReadonlyArray<Stop>} stops
 * @param {Element} el
 * @param {ReadonlyArray<FileEntry>} files
 * @param {Stop} [current]
 */
export function stopShowing(stops, el, files, current) {
  const section = el.closest('pr-layer > section')
  const point = el.closest('li.finding, tr.ifind')?.getAttribute('data-fingerprint') ?? null
  const card = el.closest('article.file')
  const hunk = el.closest('table.diff')?.getAttribute('data-hunk') ?? null
  /** @param {Stop} stop */
  const shows = stop => {
    if (section === null || layerAnchorId(stop.layer.key) !== section.id) {
      return false
    }
    if (stop.kind === 'layer') {
      return point === null && card === null && el.closest('.layer-points') === null
    }
    if (point !== null) {
      return point === stop.point.fingerprint
    }
    return (
      card?.getAttribute('data-path') === stop.point.path &&
      (hunk === null || hunk === hunkOf(stop.point, files))
    )
  }
  return current !== undefined && shows(current) ? current : stops.find(shows)
}

/**
 * @param {Extract<Stop, { kind: 'point' }>['point']} point
 * @param {ReadonlyArray<FileEntry>} files
 */
function hunkOf(point, files) {
  const entry = files.find(f => f.path === point.path)
  return entry === undefined ? '' : hunkIdForPoint(point, entry)
}

/**
 * What a stop's fragment names on the page: a layer's section, a point's card, or, for a point the
 * layers draw no card for, as the Other layer's, its row in the diff.
 * @param {ParentNode} root
 * @param {Stop} stop
 * @returns {HTMLElement | null}
 */
export function stopTarget(root, stop) {
  const named = root.querySelector(`#${cssEscape(stop.id)}`)
  if (named instanceof HTMLElement || stop.kind === 'layer') {
    return named instanceof HTMLElement ? named : null
  }
  drawCardOf(root, stop.point.path, stop.point.layerId)
  const row = root.querySelector(`tr.ifind[data-fingerprint="${cssEscape(stop.point.fingerprint)}"]`)
  return row instanceof HTMLElement ? row : null
}

/**
 * Puts `stop` on screen through the lens, in its layer's section, which the caller shows, with the
 * bar over it. Without a stop, the overview shows, and the bar leads to the first stop.
 * @param {HTMLElement} root
 * @param {HTMLElement} section
 * @param {ReadonlyArray<Stop>} stops
 * @param {Stop | undefined} stop
 * @param {ReadonlyArray<FileEntry>} files
 * @param {ReviewArtifact} artifact
 */
export function showStop(root, section, stops, stop, files, artifact) {
  const way = wayInFocus(root)
  clearStop(root)
  const doc = root.ownerDocument
  placeStepBars(
    section,
    stopNavHtml(
      stops,
      stops.findIndex(s => s.id === stop?.id),
      artifact
    ),
    'Attention points',
    way
  )
  if (stop === undefined) {
    return
  }
  section.setAttribute('data-lens', stop.kind)
  if (stop.kind === 'layer') {
    // A layer's stop is its description and tests: the tests show, however the layers start them,
    // and close again when the stop goes, if the layers had them closed.
    const tests = section.querySelector('details.test-map')
    if (tests instanceof HTMLDetailsElement && !tests.open) {
      tests.open = true
      tests.setAttribute(OPENED_ATTR, '')
    }
    return
  }
  const { point } = stop
  const fp = cssEscape(point.fingerprint)
  const lens = doc.createElement('style')
  lens.id = LENS_ID
  lens.textContent =
    `[data-lens='point'] :is(li.finding:not([data-fingerprint="${fp}"]), tr.ifind:not([data-fingerprint="${fp}"]), ` +
    `article.file:not([data-path="${cssEscape(point.path)}"]), table.diff:not([data-hunk="${cssEscape(hunkOf(point, files))}"])) { display: none !important; }`
  root.append(lens)
  // The point's lines get drawn, and its card shows a resolved point, as a link to it does.
  drawCardOf(root, point.path, point.layerId)
  for (const el of section.querySelectorAll(
    `li.finding[data-fingerprint="${fp}"], tr.ifind[data-fingerprint="${fp}"]`
  )) {
    el.dispatchEvent(new Event('reveal-code', { bubbles: true }))
  }
  // An open point shows whole in its stop, in a compact list too; one acted on stays folded.
  const card = section.querySelector(`li.finding[data-fingerprint="${fp}"]`)
  if (card !== null) expandOpenPoint(card)
}

/**
 * Puts the same bar over the box of `section` and under it, so a reader at either end moves on
 * without a scroll. The bar over it is `#stop-nav`. `clearStop` takes both off. A step from a bar
 * takes its link off the page, so `way`, the way that had the focus, gives the focus to the same
 * way in the bar over the box, which the step put on screen: Enter again moves on. When the new
 * bar has no such way, the focus goes to the way it has.
 * @param {HTMLElement} section
 * @param {string} html what the bar says, from `stopNavHtml` or `layerNavHtml`
 * @param {string} label what the bar is called, for a screen reader
 * @param {string | null} [way] from `wayInFocus`, read before the old bar went
 */
export function placeStepBars(section, html, label, way = null) {
  const doc = section.ownerDocument
  const bar = (/** @type {string} */ name) => {
    const nav = doc.createElement('nav')
    nav.className = 'step-nav'
    nav.setAttribute('aria-label', name)
    nav.innerHTML = html
    return nav
  }
  const top = bar(label)
  top.id = NAV_ID
  const box = section.closest('pr-layer') ?? section
  box.before(top)
  box.after(bar(`${label}, at the end`))
  if (way !== null) {
    const link = top.querySelector(`a[data-way="${way}"]`) ?? top.querySelector('a')
    if (link instanceof HTMLElement) link.focus({ preventScroll: true })
  }
}

/**
 * The way of the bar link in focus, `back` or `on`, or null while the focus is not on a bar.
 * @param {ParentNode} root
 */
export function wayInFocus(root) {
  const el = root.ownerDocument?.activeElement ?? null
  return el !== null && root.contains(el) && el.closest('nav.step-nav') !== null
    ? el.getAttribute('data-way')
    : null
}

/** Takes the lens and the bar off the page. @param {ParentNode} root */
export function clearStop(root) {
  root.querySelector(`#${LENS_ID}`)?.remove()
  for (const nav of root.querySelectorAll('nav.step-nav')) {
    nav.remove()
  }
  for (const el of root.querySelectorAll('[data-lens]')) {
    el.removeAttribute('data-lens')
  }
  for (const tests of root.querySelectorAll(`details[${OPENED_ATTR}]`)) {
    if (tests instanceof HTMLDetailsElement) tests.open = false
    tests.removeAttribute(OPENED_ATTR)
  }
}

/**
 * A bar's way back, to `href`, that says where it goes as HTML.
 * @param {string} href
 * @param {string} html
 */
function backLink(href, html) {
  return `<a href="${esc(href)}" data-way="back">&larr; ${html}</a>`
}

/**
 * A bar's way on, to `href`, that says where it goes as HTML. It looks like a command, so the
 * reader sees it as the step to take, apart from the plain way back.
 * @param {string} href
 * @param {string} html
 * @param {string} [attrs] more attributes, each with a space before it
 * @param {boolean} [first] the way into a layer's stops or the first stop
 */
function onLink(href, html, attrs = '', first = false) {
  return `<a class="cmd${first ? ' step-on' : ''}" href="${esc(href)}" data-way="on"${attrs}>${html} &rarr;</a>`
}

/**
 * What the way back from `stop` says, as HTML: the opening of its own layer by the layer's title,
 * another layer's opening as the previous layer, as the way on names the next one, or the previous
 * point.
 * @param {Stop} stop
 * @param {Stop} previous
 */
function backHtml(stop, previous) {
  if (previous.kind === 'point') {
    return 'previous point'
  }
  const title = titleHtml(previous.layer.title)
  return previous.layer.id === stop.layer.id ? title : `previous layer: ${title}`
}

/**
 * The bar's ways back and on from stop `index`, -1 for the overview, each saying where it goes.
 * After the last stop come the layers, for the rest of the diff: that way switches to them, as the
 * rail's switch does, on the first layer.
 * @param {ReadonlyArray<Stop>} stops
 * @param {number} index
 * @param {ReviewArtifact} artifact
 */
export function stopNavHtml(stops, index, artifact) {
  const stop = stops[index]
  const previous = stops[index - 1]
  const next = stops[index + 1]
  const back =
    stop === undefined
      ? ''
      : previous === undefined
        ? backLink('#overview', 'overview')
        : backLink(`#${previous.id}`, backHtml(stop, previous))
  const here =
    stop?.kind === 'point'
      ? `<span class="step-n">Point ${stop.number} of ${stops.filter(s => s.kind === 'point').length}</span>`
      : ''
  const firstLayer = artifact.layers[0]
  /** @type {string} */
  let on = ''
  if (next === undefined) {
    on =
      stop === undefined || firstLayer === undefined
        ? ''
        : onLink(
            `#${layerAnchorId(firstLayer.key)}`,
            'the rest of the diff, by layer',
            ' data-act="layer-view" data-view="layers"'
          )
  } else if (stop === undefined) {
    // The first stop is a layer's opening: every point's layer has one.
    on = onLink(`#${next.id}`, `start with ${layerNameHtml(artifact.layers, next.layer)}`, '', true)
  } else if (stop.kind === 'layer' && next.kind === 'point') {
    on = onLink(
      `#${next.id}`,
      `go to its ${stop.points} attention point${stop.points === 1 ? '' : 's'}`,
      '',
      true
    )
  } else {
    on = onLink(
      `#${next.id}`,
      next.kind === 'layer' ? `next layer: ${titleHtml(next.layer.title)}` : 'next point'
    )
  }
  return `${back}${here}${on}`
}

/**
 * A layer's name as the way on from the overview says it, as HTML: `Layer 2: title`, or the
 * title alone for Other, which has no number.
 * @param {ReadonlyArray<Layer>} layers every layer, in page order
 * @param {Layer} layer
 */
function layerNameHtml(layers, layer) {
  const title = titleHtml(layer.title)
  if (layer.kind === 'other') {
    return title
  }
  return `Layer ${layers.filter(l => l.kind !== 'other').indexOf(layer) + 1}: ${title}`
}

/**
 * The one-layer view's bar, in the words of the stops' bar: from layer `index`, -1 for the
 * overview, back to the layer before it or the overview, as `k` goes, and on to the next layer.
 * After the last layer, where `j` stops, it leads to the first other layer with a reviewed mark
 * that is still open, and says so when there is none.
 * @param {ReadonlyArray<Layer>} layers every layer, in page order
 * @param {number} index
 * @param {(layer: Layer) => boolean} reviewed whether the reader marked a layer reviewed
 */
export function layerNavHtml(layers, index, reviewed) {
  const layer = layers[index]
  const previous = layers[index - 1]
  const next = layers[index + 1]
  const href = (/** @type {Layer} */ l) => `#${layerAnchorId(l.key)}`
  const back =
    layer === undefined
      ? ''
      : previous === undefined
        ? backLink('#overview', 'overview')
        : backLink(href(previous), `previous layer: ${titleHtml(previous.title)}`)
  if (next === undefined && layer === undefined) {
    return ''
  }
  if (next !== undefined) {
    return layer === undefined
      ? onLink(href(next), `start with ${layerNameHtml(layers, next)}`, '', true)
      : `${back}${onLink(href(next), `next layer: ${titleHtml(next.title)}`)}`
  }
  const open = layers.find(l => l !== layer && l.kind !== 'other' && !reviewed(l))
  return open === undefined
    ? `${back}<span class="step-n">every other layer is reviewed</span>`
    : `${back}${onLink(href(open), `next open layer: ${titleHtml(open.title)}`)}`
}
