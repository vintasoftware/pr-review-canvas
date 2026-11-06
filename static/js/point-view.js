// @ts-check
// The one-point-at-a-time view draws no copy of the canvas. A stop is the layer section that holds
// it, seen through a lens: a layer's stop shows the layer's heading, description and tests; a
// point's stop shows the layer's heading, the point's card, and only the chunk of its file that
// holds the point. Every card stays where the layers drew it, so links, keys and commands work on
// it as they do in the layers. A bar over the stop leads back and on; after the last stop, to the
// layers. `one-layer.js` decides which stop is on screen.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./point-steps.js').Stop} Stop */
import { cssEscape, drawCardOf } from './anchors.js'
import { esc } from './dom.js'
import { layerAnchorId } from './keys.js'
import { hunkIdForPoint } from './layers.js'

const LENS_ID = 'stop-lens'
const NAV_ID = 'stop-nav'

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
  const html = stopNavHtml(
    stops,
    stops.findIndex(s => s.id === stop?.id),
    artifact
  )
  // The same bar over the stop and under it, so a reader at either end moves on without a scroll.
  const bar = (/** @type {string} */ label) => {
    const nav = doc.createElement('nav')
    nav.className = 'step-nav'
    nav.setAttribute('aria-label', label)
    nav.innerHTML = html
    return nav
  }
  const top = bar('Attention points')
  top.id = NAV_ID
  const box = section.closest('pr-layer') ?? section
  box.before(top)
  box.after(bar('Attention points, at the end'))
  if (stop === undefined) {
    return
  }
  section.setAttribute('data-lens', stop.kind)
  if (stop.kind === 'layer') {
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
  const link = (/** @type {string} */ href, /** @type {string} */ text, attrs = '') =>
    `<a href="${esc(href)}"${attrs}>${text}</a>`
  const back =
    stop === undefined
      ? ''
      : previous === undefined
        ? link('#overview', '&larr; overview')
        : link(
            `#${previous.id}`,
            `&larr; ${esc(previous.kind === 'layer' ? previous.layer.title : 'previous point')}`
          )
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
        : link(
            `#${layerAnchorId(firstLayer.key)}`,
            'the rest of the diff, by layer &rarr;',
            ' data-act="layer-view" data-view="layers"'
          )
  } else if (stop === undefined) {
    // The first stop is a layer's opening: every point's layer has one.
    const n = artifact.layers.filter(l => l.kind !== 'other').indexOf(next.layer) + 1
    const name = next.layer.kind === 'other' ? next.layer.title : `Layer ${n}: ${next.layer.title}`
    on = link(`#${next.id}`, `start with ${esc(name)} &rarr;`, ' class="step-on"')
  } else if (stop.kind === 'layer' && next.kind === 'point') {
    on = link(
      `#${next.id}`,
      `go to its ${stop.points} attention point${stop.points === 1 ? '' : 's'} &rarr;`,
      ' class="step-on"'
    )
  } else {
    on = link(
      `#${next.id}`,
      `${next.kind === 'layer' ? `next layer: ${esc(next.layer.title)}` : 'next point'} &rarr;`
    )
  }
  return `${back}${here}${on}`
}
