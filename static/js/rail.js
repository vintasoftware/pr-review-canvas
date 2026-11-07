// @ts-check
// The rail: the overview, the layers with their progress and size, and the Other layer; in the
// one-point view, the attention points under their layers, with the switch between the two views.
// It reads the diff's sizes from the render context `layers.js` keeps.
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
import { diffstatHtml, layerChanges } from './diffstat.js'
import { esc } from './dom.js'
import { layerAnchorId } from './keys.js'
import { fileCount, getRenderContext } from './layers.js'
import { levelIconHtml } from './point-level.js'
import { stopsOf } from './point-steps.js'
import { openPoints, pointStatus } from './points.js'
import { filesReviewed, layerProgress } from './progress.js'

/**
 * Stripe color for a layer position (cycles through the six bands).
 * @param {number} index
 */
export function dotColor(index) {
  return `var(--s${(index % 6) + 1})`
}

/**
 * The switch at the head of the rail, for a canvas with points: the one-point view's attention
 * points, or the layers, in the layer view **Show layers** chooses. The one shown is pressed.
 * @param {boolean} points
 */
function railViewSwitchHtml(points) {
  const option = (/** @type {string} */ view, /** @type {string} */ label, /** @type {boolean} */ on) =>
    `<button type="button" data-act="layer-view" data-view="${view}" aria-pressed="${on}">${label}</button>`
  return `<div class="rail-view" role="group" aria-label="Read by">${option('points', 'Attention points', points)}${option('layers', 'Layers', !points)}</div>`
}

/**
 * The rail's group of attention points in the one-point view: its stops, each layer's opening
 * then its points. It is drawn from the state, so a point acted on dims at once.
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {(id: string) => string} current
 */
function railPointsHtml(artifact, state, current) {
  const items = stopsOf(artifact)
    .map(stop => {
      const link = (/** @type {string} */ inner) =>
        `<a href="#${esc(stop.id)}"${current(stop.id)}>${inner}</a>`
      if (stop.kind === 'layer') {
        return `<li class="pt-layer">${link(`<span class="t">${esc(stop.layer.title)}</span>`)}</li>`
      }
      const handled = pointStatus(stop.point, state) === 'open' ? '' : ' class="is-handled"'
      return `<li${handled}>${link(`${levelIconHtml(stop.point.level, null)}<span class="t">${esc(stop.point.title)}</span>`)}</li>`
    })
    .join('')
  return `<li class="grp">${railViewSwitchHtml(true)}<ul class="rail-points">${items}</ul></li>`
}

/**
 * With a render context, each layer shows the lines it adds and removes. `points` draws, in place
 * of the layers, the attention points the one-point view walks. `switchable`, on a page that reads
 * by attention points, heads the rail's group of a canvas with points with the switch between the
 * two.
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {{ activeId?: string, points?: boolean, switchable?: boolean }} [opts]
 * @returns {string}
 */
export function railInnerHtml(artifact, state, opts = {}) {
  const active = opts.activeId ?? 'overview'
  const ctx = getRenderContext()
  const current = /** @param {string} id */ id => (id === active ? ' aria-current="location"' : '')
  const semantic = artifact.layers.filter(l => l.kind !== 'other')
  const other = artifact.layers.find(l => l.kind === 'other')
  const items = semantic
    .map((layer, i) => {
      const progress = layerProgress(layer, state)
      const dotClass = progress === 'done' ? 'dot on' : progress === 'partial' ? 'dot half' : 'dot'
      const dotLabel =
        progress === 'done' ? 'reviewed' : progress === 'partial' ? 'in progress' : 'not started'
      const reviewed = filesReviewed(layer, state)
      const files = layer.files.length
      const meta = reviewed > 0 && reviewed < files ? `${reviewed} of ${files} files` : fileCount(files)
      const changes = ctx === null ? null : layerChanges(layer, ctx.files, ctx.patches)
      const stat = changes === null ? '' : ` · ${diffstatHtml(changes.total, changes.tests)}`
      const risk = layer.risk.length > 0 ? ` · ${layer.risk.map(r => esc(r.label)).join(' · ')}` : ''
      const id = layerAnchorId(layer.key)
      return (
        `<li><a href="#${esc(id)}"${current(id)}><span class="${dotClass}" style="--dc:${dotColor(i)}" role="img" aria-label="${dotLabel}"></span>` +
        `<span class="n">${i + 1}</span><span class="t">${esc(layer.title)}</span><span class="m">${meta}${stat}${risk}</span></a></li>`
      )
    })
    .join('')
  const points = openPoints(artifact.points, state).length
  const otherItem = other
    ? `<li class="other"><a href="#${esc(layerAnchorId(other.key))}"${current(layerAnchorId(other.key))}><span class="t">${esc(other.title)}</span><span class="m">${fileCount(other.files.length)}, ignored</span></a></li>`
    : ''
  const overview = `<li><a href="#overview"${current('overview')}><span class="t">Overview</span><span class="m">${points} open attention ${points === 1 ? 'point' : 'points'}</span></a></li>`
  const hasPoints = artifact.points.length > 0
  if (opts.points === true && hasPoints) {
    return `<ul class="tree">${overview}${railPointsHtml(artifact, state, current)}</ul>`
  }
  const heading =
    hasPoints && opts.switchable === true
      ? railViewSwitchHtml(false)
      : '<span class="lbl grp-lbl">Layers</span>'
  return `<ul class="tree">${overview}<li class="grp">${heading}<ul class="layers">${items}</ul></li>${otherItem}</ul>`
}

/**
 * `points` and `switchable` stay on the rail as attributes, so it is drawn again the same way.
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {{ activeId?: string, points?: boolean, switchable?: boolean }} [opts]
 * @returns {string}
 */
export function renderRail(artifact, state, opts = {}) {
  const attrs = `${opts.points === true ? ' data-points' : ''}${opts.switchable === true ? ' data-switchable' : ''}`
  return `<nav class="rail" aria-label="Review layers"${attrs}>${railInnerHtml(artifact, state, opts)}</nav>`
}

/**
 * Draws the rail again from the current state, keeping the item the scrollspy marked.
 * @param {ParentNode} root
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 */
export function refreshRail(root, artifact, state) {
  const rail = root.querySelector('nav.rail')
  if (!(rail instanceof HTMLElement)) {
    return false
  }
  const active = rail.querySelector('a[aria-current]')?.getAttribute('href')?.slice(1)
  rail.innerHTML = railInnerHtml(artifact, state, {
    ...(active === undefined ? {} : { activeId: active }),
    points: rail.hasAttribute('data-points'),
    switchable: rail.hasAttribute('data-switchable'),
  })
  return true
}
