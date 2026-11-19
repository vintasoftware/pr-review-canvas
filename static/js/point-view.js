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
import { layerStop } from './point-steps.js'
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
  clearStop(root)
  const doc = root.ownerDocument
  placeStepBars(
    section,
    stopNavHtml(
      stops,
      stops.findIndex(s => s.id === stop?.id),
      artifact
    ),
    'Attention points'
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
 * Puts the same bar over the box of `section` and under it, in place of the bars on the page, so a
 * reader at either end moves on without a scroll. The bar over it is `#stop-nav`.
 *
 * When the focus was on a bar link, the same way in the new bar over the box takes it, so Enter
 * again moves on. A bar without that way gives the focus to the way it has. Only this function
 * removes a bar that a new one replaces, so no step can lose the focus before the new bar is there.
 * @param {HTMLElement} section
 * @param {string} html what the bar says, from `stopNavHtml` or `layerNavHtml`
 * @param {string} label what the bar is called, for a screen reader
 */
export function placeStepBars(section, html, label) {
  const doc = section.ownerDocument
  const focused = doc.activeElement
  const way = focused?.closest('nav.step-nav') ? focused.getAttribute('data-way') : null
  removeStepBars(doc)
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
 * Takes the bars off the page, for a view that shows none.
 * @param {ParentNode} root
 */
export function removeStepBars(root) {
  for (const nav of root.querySelectorAll('nav.step-nav')) {
    nav.remove()
  }
}

/**
 * Takes a stop's lens off the page and closes the tests it opened. `placeStepBars` replaces the
 * bars, and `removeStepBars` takes them off.
 * @param {ParentNode} root
 */
export function clearStop(root) {
  root.querySelector(`#${LENS_ID}`)?.remove()
  for (const el of root.querySelectorAll('[data-lens]')) {
    el.removeAttribute('data-lens')
  }
  for (const tests of root.querySelectorAll(`details[${OPENED_ATTR}]`)) {
    if (tests instanceof HTMLDetailsElement) tests.open = false
    tests.removeAttribute(OPENED_ATTR)
  }
}

/**
 * A bar's way back, to `href`, that says where it goes as HTML. Both ways are commands, so they
 * read as a pair.
 * @param {string} href
 * @param {string} html
 */
function backLink(href, html) {
  return `<a class="cmd" href="${esc(href)}" data-way="back">&larr; ${html}</a>`
}

/**
 * A bar's way on, to `href`, that says where it goes as HTML.
 * @param {string} href
 * @param {string} html
 * @param {string} [attrs] more attributes, each with a space before it
 */
function onLink(href, html, attrs = '') {
  return `<a class="cmd" href="${esc(href)}" data-way="on"${attrs}>${html} &rarr;</a>`
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
 * The way on from the last stop. It switches to the layers, as the rail's switch does.
 * @param {ReviewArtifact} artifact
 */
function restOfDiffHtml(artifact) {
  const first = artifact.layers[0]
  return first === undefined
    ? ''
    : onLink(
        `#${layerAnchorId(first.key)}`,
        'the rest of the diff, by layer',
        ' data-act="layer-view" data-view="layers"'
      )
}

/**
 * The bar's ways back and on from stop `index`, -1 for the overview, each saying where it goes.
 * After the last stop comes `end`: by default the way to the layers, for the rest of the diff.
 * @param {ReadonlyArray<Stop>} stops
 * @param {number} index
 * @param {ReviewArtifact} artifact
 * @param {string} [end] what the bar of the last stop says in place of a way on, as HTML
 */
export function stopNavHtml(stops, index, artifact, end = restOfDiffHtml(artifact)) {
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
  /** @type {string} */
  let on = ''
  if (next === undefined) {
    on = stop === undefined ? '' : end
  } else if (stop === undefined) {
    // The first stop is a layer's opening: every point's layer has one.
    on = onLink(`#${next.id}`, `start with ${layerNameHtml(artifact.layers, next.layer)}`)
  } else if (stop.kind === 'layer' && next.kind === 'point') {
    on = onLink(`#${next.id}`, `go to its ${stop.points} attention point${stop.points === 1 ? '' : 's'}`)
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
 * The one-layer view's bar for layer `index`, -1 for the overview. It is the stops' bar, built from
 * every layer's opening stop, so both bars use the same words.
 *
 * After the last layer, where `j` stops, it leads to the first layer not marked reviewed, or says
 * there is none. Other has no reviewed mark, but it never becomes that target: validation keeps
 * Other last, so it is the layer on screen.
 * @param {ReviewArtifact} artifact
 * @param {number} index
 * @param {(layer: Layer) => boolean} reviewed whether the reader marked a layer reviewed
 */
export function layerNavHtml(artifact, index, reviewed) {
  const { layers, points } = artifact
  const stops = layers.map(layer =>
    layerStop(
      layer,
      points.filter(p => p.layerId === layer.id)
    )
  )
  const layer = layers[index]
  const open = layers.find(l => l !== layer && !reviewed(l))
  const end =
    open === undefined
      ? '<span class="step-done">every other layer is reviewed</span>'
      : onLink(`#${layerAnchorId(open.key)}`, `next open layer: ${titleHtml(open.title)}`)
  return stopNavHtml(stops, index, artifact, end)
}
