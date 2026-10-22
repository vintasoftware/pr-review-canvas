// @ts-check
// The one-point-at-a-time view's stops, layer by layer. Each layer opens with a stop of its own:
// its heading, its description, and its tests shown at once, leading on to its attention points.
// Each point's stop is the point's card, whole, then the file it is on, drawn with the one chunk
// that holds its lines and a mark on them where the point is. Every stop leads to the one before
// and after; the last leads to the layers, for the rest of the diff. Only that view draws the
// stops, and `one-layer.js` shows them one at a time. They come after the layers on the page: a
// point's code is the layer's drawn again, under the same ids, so a link to a line or a chunk
// lands in its layer, the first on the page.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */
/** @typedef {ReviewArtifact['layers'][number]} Layer */
/** @typedef {import('./point-steps.js').PointStep} PointStep */
import { askButtonHtml } from './ask.js'
import { esc } from './dom.js'
import { layerAnchorId, layerStepAnchorId, reviewedId, stepAnchorId } from './keys.js'
import { hunkIdForPoint, hunkLayerIndex, pathSet, renderFileCard, testMapHtml } from './layers.js'
import { renderMarkdown } from './markdown.js'
import { pointSteps } from './point-steps.js'
import { pointCardHtml, postedUrls } from './points.js'
import { layerProgress } from './progress.js'

export const POINT_STEPS_ID = 'point-steps'

/**
 * One stop of the view: a layer's opening, with the points that follow it, or a point, with its
 * number among all the points.
 * @typedef {{ kind: 'layer', id: string, layer: Layer, points: PointStep[] }
 *   | { kind: 'point', id: string, step: PointStep, number: number }} Stop
 */

/**
 * The stops in reading order: each layer that has points or tests opens with its stop, followed by
 * its points from the most severe. Points of no listed layer come last, with no opening.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<PointStep>} steps
 * @returns {Stop[]}
 */
export function stopsOf(artifact, steps) {
  /** @type {Stop[]} */
  const stops = []
  let number = 0
  /** @param {PointStep} step */
  const pointStop = step => {
    number += 1
    stops.push({ kind: 'point', id: stepAnchorId(step.point.id), step, number })
  }
  for (const layer of artifact.layers) {
    const points = steps.filter(step => step.layer?.id === layer.id)
    if (points.length === 0 && layer.tests.length === 0) {
      continue
    }
    stops.push({ kind: 'layer', id: layerStepAnchorId(layer.key), layer, points })
    points.forEach(pointStop)
  }
  steps.filter(step => step.layer === null).forEach(pointStop)
  return stops
}

/**
 * The position of a layer of the change, `2 of 5`, or '' for Other, which has none.
 * @param {ReviewArtifact} artifact
 * @param {Layer} layer
 */
function layerPosition(artifact, layer) {
  const semantic = artifact.layers.filter(l => l.kind !== 'other')
  return layer.kind === 'other' ? '' : `${semantic.indexOf(layer) + 1} of ${semantic.length}`
}

/**
 * The way on from a stop: back to the one before, and on to the next, whose label says what it is.
 * After the last stop come the layers, for the rest of the diff.
 * @param {ReadonlyArray<Stop>} stops
 * @param {number} index
 * @param {ReviewArtifact} artifact
 */
function stopNavHtml(stops, index, artifact) {
  const stop = stops[index]
  const previous = stops[index - 1]
  const next = stops[index + 1]
  const firstLayer = artifact.layers[0]
  const back =
    previous === undefined
      ? '<a href="#overview">&larr; overview</a>'
      : `<a href="#${esc(previous.id)}">&larr; ${previous.kind === 'layer' ? esc(previous.layer.title) : 'previous point'}</a>`
  let on = ''
  if (next === undefined) {
    on =
      firstLayer === undefined
        ? ''
        : `<a href="#${esc(layerAnchorId(firstLayer.key))}">the rest of the diff, by layer &rarr;</a>`
  } else if (stop?.kind === 'layer' && next.kind === 'point') {
    const count = stop.points.length
    on = `<a class="step-on" href="#${esc(next.id)}">go to its ${count} attention point${count === 1 ? '' : 's'} &rarr;</a>`
  } else {
    on = `<a href="#${esc(next.id)}">${next.kind === 'layer' ? `next layer: ${esc(next.layer.title)}` : 'next point'} &rarr;</a>`
  }
  return `<nav class="step-nav" aria-label="Attention points">${back}${on}</nav>`
}

/**
 * The way on from the overview in the one-point view: to its first stop, the first layer's opening
 * when the layer has one. Nothing for a canvas with no point, which has no stops.
 * @param {ReviewArtifact} artifact
 */
export function overviewWayOnHtml(artifact) {
  // The stops are drawn only for a canvas with points, so with none there is nowhere to lead.
  const steps = pointSteps(artifact, artifact.points)
  const first = steps.length === 0 ? undefined : stopsOf(artifact, steps)[0]
  if (first === undefined) {
    return ''
  }
  const position = first.kind === 'layer' ? layerPosition(artifact, first.layer) : ''
  const label =
    first.kind === 'point'
      ? 'the first attention point'
      : position === ''
        ? first.layer.title
        : `Layer ${position.split(' ')[0]}: ${first.layer.title}`
  return `<nav class="step-nav" aria-label="Attention points"><a class="step-on" href="#${esc(first.id)}">start with ${esc(label)} &rarr;</a></nav>`
}

/**
 * Where the switch between the views lands, for the place the reader is at: the layer a layer's
 * section, its opening stop, or one of its points' stops names, shown in the other view. Into the
 * one-point view that is the layer's opening stop, or '' for the view's first stop when the layer
 * has none or the place is no layer's; into a layer view, the layer's section, or the place as it is.
 * @param {ReviewArtifact} artifact
 * @param {import('./layer-views.js').LayerView} view the view switched to
 * @param {string} hash the place, as `#id`
 */
export function viewSwitchTarget(artifact, view, hash) {
  const point = artifact.points.find(p => hash === `#${stepAnchorId(p.id)}`)
  const layer = artifact.layers.find(
    candidate =>
      candidate.id === point?.layerId ||
      hash === `#${layerAnchorId(candidate.key)}` ||
      hash === `#${layerStepAnchorId(candidate.key)}`
  )
  if (view !== 'points') {
    return layer === undefined ? hash : `#${layerAnchorId(layer.key)}`
  }
  if (hash === '#overview') {
    return hash
  }
  const opening = layer === undefined ? undefined : layerStepAnchorId(layer.key)
  const stops = stopsOf(artifact, pointSteps(artifact, artifact.points))
  return stops.some(stop => stop.id === opening) ? `#${opening}` : ''
}

/**
 * A layer's opening stop, without its way on: the layer's heading with its reviewed mark and ask
 * command, its description, and its tests, shown at once.
 * @param {Extract<Stop, { kind: 'layer' }>} stop
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {ReadonlySet<string>} paths
 */
function layerStopHtml(stop, artifact, state, paths) {
  const { layer } = stop
  const position = layerPosition(artifact, layer)
  const reviewed = layerProgress(layer, state) === 'done'
  const controls =
    layer.kind === 'other'
      ? ''
      : `<div class="layer-ctl"><label class="chk"><input type="checkbox" data-reviewed-id="${esc(reviewedId(layer.key))}"${reviewed ? ' checked' : ''}> reviewed</label>` +
        `${askButtonHtml({ kind: 'layer', layerId: layer.id }, { label: 'ask about this layer' })}</div>`
  return (
    `<section class="point-step layer-step" id="${esc(stop.id)}" data-layer="${esc(layer.id)}" aria-label="${esc(layer.title)}">` +
    `<div class="panel-h layer-h"><h2>${position === '' ? '' : `<span class="lbl">Layer ${position}</span>`}${esc(layer.title)}</h2>${controls}</div>` +
    `<div class="body"><div class="rationale prose">${renderMarkdown(layer.rationale, { paths, diagrams: true })}</div></div>` +
    testMapHtml(layer, paths)
  )
}

/**
 * Every layer's opening stop and every attention point's stop, in the view's order. A point the
 * reader acted on keeps its stop, so the sequence stays the same while the reader works through
 * it. A canvas with no point has none.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<FileEntry>} files
 * @param {PrState} state
 * @param {ReadonlyArray<ReviewComment>} [comments] so a point that was posted says so
 * @returns {string}
 */
export function renderPointSteps(artifact, files, state, comments = []) {
  const steps = pointSteps(artifact, artifact.points)
  if (steps.length === 0) {
    return ''
  }
  const ctx = {
    hunkIndex: hunkLayerIndex(artifact),
    paths: pathSet(files),
    firstCardFor: new Set(),
    state,
    posted: postedUrls(state, comments),
  }
  const stops = stopsOf(artifact, steps)
  const html = stops.map((stop, index) => {
    const nav = stopNavHtml(stops, index, artifact)
    if (stop.kind === 'layer') {
      return `${layerStopHtml(stop, artifact, state, ctx.paths)}${nav}</section>`
    }
    const { point, layer } = stop.step
    const entry = files.find(f => f.path === point.path)
    const hunk = entry === undefined ? '' : hunkIdForPoint(point, entry)
    const layerFile = layer?.files.find(f => f.path === point.path)
    const code =
      layer === null || entry === undefined || hunk === ''
        ? '<p class="muted small">The code this point is about is not in the diff.</p>'
        : renderFileCard(
            { ...(layerFile ?? { path: point.path, isTest: false, annotations: [] }), hunks: [hunk] },
            entry,
            layer,
            ctx,
            { id: `${stop.id}-file`, open: true, onlyPoint: point.fingerprint }
          )
    const position = layer === null ? '' : layerPosition(artifact, layer)
    const where =
      layer === null
        ? ''
        : ` · <a href="#${esc(layerStepAnchorId(layer.key))}">${esc(position === '' ? layer.title : `Layer ${position.split(' ')[0]} · ${layer.title}`)}</a>`
    return (
      `<section class="point-step" id="${esc(stop.id)}" aria-label="Attention point ${stop.number} of ${steps.length}">` +
      `<p class="step-h"><span class="step-n">Point ${stop.number} of ${steps.length}</span>${where}</p>` +
      `<ol class="findings step-card">${pointCardHtml(point, ctx, { id: `${stop.id}-card` })}</ol>` +
      `<div class="files">${code}</div>${nav}</section>`
    )
  })
  return `<div class="point-steps" id="${POINT_STEPS_ID}">${html.join('')}</div>`
}
