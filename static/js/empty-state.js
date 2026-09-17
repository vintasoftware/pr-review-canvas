// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
import { esc } from './dom.js'

export const DROP_ZONE_ID = 'zip'

/**
 * What the drop zone shows. `over` is a file dragged across it, `busy` an upload in flight, and
 * `error` the last failure, which stays until the next attempt.
 * @typedef {{ phase: 'idle' | 'over' | 'busy', progress: number, error: string | null }} DropState
 */

/** @type {DropState} */
export const INITIAL_DROP_STATE = { phase: 'idle', progress: 0, error: null }

/**
 * @typedef {{ type: 'enter' } | { type: 'leave' } | { type: 'start' } | { type: 'progress', fraction: number }
 *   | { type: 'done' } | { type: 'fail', message: string }} DropEvent
 */

/**
 * @param {DropState} state
 * @param {DropEvent} event
 * @returns {DropState}
 */
export function dropReducer(state, event) {
  switch (event.type) {
    case 'enter':
      return state.phase === 'busy' ? state : { ...state, phase: 'over' }
    case 'leave':
      return state.phase === 'busy' ? state : { ...state, phase: 'idle' }
    case 'start':
      return { phase: 'busy', progress: 0, error: null }
    case 'progress':
      return state.phase === 'busy' ? { ...state, progress: Math.min(Math.max(event.fraction, 0), 1) } : state
    case 'done':
      return { phase: 'idle', progress: 1, error: null }
    case 'fail':
      return { phase: 'idle', progress: 0, error: event.message }
  }
}

/**
 * A looser form of the export name grammar `parseCanvasZipName` (src/canvas/name.ts) holds for the
 * server: enough to catch the wrong file before it is uploaded, never a second copy of the check.
 */
const CANVAS_NAME_RE = /^(?:pr-([1-9]\d*)|ref)-.+-canvas\.zip$/i

/**
 * The file the user picked has to be a canvas zip for this pull request. The name is only a first
 * check; the server reads the zip itself and answers CANVAS_INVALID or CANVAS_PR_MISMATCH when it
 * is not one. A canvas exported before the PR existed is named `ref-` and names no PR.
 * @param {string} filename
 * @param {number} prNumber the PR the page is on
 * @returns {string | null} the problem, or null when the name is fine
 */
export function validateCanvasFilename(filename, prNumber) {
  if (!filename.toLowerCase().endsWith('.zip')) {
    return 'that is not a zip file'
  }
  const match = CANVAS_NAME_RE.exec(filename)
  if (!match) {
    return 'that zip is not a review canvas export'
  }
  const named = match[1] === undefined ? undefined : Number(match[1])
  if (named !== undefined && named !== prNumber) {
    return `that canvas was exported for PR #${named}, not #${prNumber}`
  }
  return null
}

/**
 * The refusals no retry can clear: the zip is a canvas, of the wrong thing. Anything else the
 * discovery reports is a download that failed, which the link and the drop zone can still rescue.
 * @type {Record<string, string>}
 */
const SHARED_CANVAS_REFUSALS = {
  'pr-mismatch': 'it was exported for another pull request',
  'name-mismatch': 'it was exported from another repository',
}

/**
 * @param {PrBundle} bundle
 * @returns {string}
 */
export function sharedCanvasCalloutHtml(bundle) {
  const shared = bundle.sharedCanvas
  if (!shared) {
    return ''
  }
  const name = `<span class="path">${esc(shared.name)}</span>`
  if (shared.downloadable) {
    return `<div class="callout" role="status">A canvas is attached to this PR (${name}) &mdash; importing&hellip;</div>`
  }
  const refused = SHARED_CANVAS_REFUSALS[shared.reason ?? '']
  const problem = refused ?? `could not be downloaded (${esc(shared.reason ?? 'unknown')})`
  const next =
    refused === undefined
      ? `<a href="${esc(shared.url)}" target="_blank" rel="noopener noreferrer">Download it</a> and drop it here. `
      : 'Ask its author for a canvas of this pull request, or generate one. '
  return (
    `<div class="callout warn" role="status">A canvas is attached to this PR (${name}) but ${problem}. ` +
    next +
    '<button class="cmd" type="button" id="fetch-shared">fetch again</button></div>'
  )
}

/**
 * @param {PrBundle} bundle
 * @returns {string}
 */
function skillCommandHtml(bundle) {
  return (
    '<p class="hint">Run this in Claude Code or Codex from this repo. The page updates when the canvas is published.</p>' +
    `<div class="cmdbox"><code>${esc(bundle.skillCommand)}</code><button class="cmd fill" type="button" data-copy="${esc(bundle.skillCommand)}">copy</button></div>`
  )
}

/** @returns {string} */
function dropZoneHtml() {
  return (
    '<p class="hint">or import a canvas a teammate attached to the PR</p>' +
    `<label class="drop" for="${DROP_ZONE_ID}">Drop a canvas zip here or <span class="link">choose file</span>` +
    `<input class="sr" id="${DROP_ZONE_ID}" type="file" accept=".zip"></label>` +
    '<p class="drop-status" role="status" aria-live="polite"></p>'
  )
}

/**
 * The `missing` screen: the skill command with its copy command, the drop zone, the callout.
 * @param {PrBundle} bundle
 * @returns {string}
 */
export function renderEmptyState(bundle) {
  return (
    '<section class="panel empty" id="empty-state" aria-labelledby="es-h">' +
    '<div class="panel-h"><h2 id="es-h">No review canvas for this PR yet</h2></div>' +
    '<div class="body center">' +
    skillCommandHtml(bundle) +
    dropZoneHtml() +
    sharedCanvasCalloutHtml(bundle) +
    '</div></section>'
  )
}

/**
 * How far the canvas is from the head, in words.
 * @param {NonNullable<PrBundle['stale']>} stale
 * @returns {string}
 */
export function staleSummary(stale) {
  const canvas = stale.canvasHeadSha.slice(0, 7)
  const head = stale.currentHeadSha.slice(0, 7)
  if (stale.relation === 'unrelated') {
    return `The canvas is for ${canvas}, which is not in this branch any more; the head is ${head}.`
  }
  const behind = stale.commitsBehind ?? 0
  return `The canvas is for ${canvas}, ${behind} commit${behind === 1 ? '' : 's'} behind the head ${head}.`
}

/**
 * The bar that stays on screen while a stale canvas is shown, so the reader is never misled about
 * which commit the diffs come from.
 * @param {NonNullable<PrBundle['stale']>} stale
 * @returns {string}
 */
export function staleBarHtml(stale) {
  return (
    `<div class="stale-bar" role="status"><strong>Canvas is outdated.</strong> You are reading an older commit. ${esc(staleSummary(stale))} ` +
    '<button class="cmd" type="button" id="stale-generate" aria-haspopup="dialog">generate for current head</button></div>'
  )
}

/**
 * The note above a canvas that was generated for an earlier commit: the commits since (merges from
 * the base branch, as a rule) left the diff as it was.
 * @param {string} canvasHeadSha the commit the canvas was generated for
 * @param {string} headSha the pull request head
 * @param {number} n the commits between them
 * @returns {string}
 */
export function unchangedDiffBarHtml(canvasHeadSha, headSha, n) {
  const canvas = canvasHeadSha.slice(0, 7)
  const head = headSha.slice(0, 7)
  return (
    `<div class="stale-bar same-diff-bar" role="status"><strong>Canvas still applies.</strong> ` +
    `${esc(`It was generated for ${canvas}; the ${n} commit${n === 1 ? '' : 's'} since left the diff unchanged, so it describes the head ${head} too.`)} ` +
    '<button class="cmd" type="button" id="stale-generate" aria-haspopup="dialog">regenerate anyway</button></div>'
  )
}

/**
 * The `stale` screen: the same card as the empty state, plus the two ways forward.
 * @param {PrBundle} bundle
 * @returns {string}
 */
export function renderStaleState(bundle) {
  const stale = bundle.stale
  return (
    '<section class="panel empty" id="empty-state" aria-labelledby="es-h">' +
    '<div class="panel-h"><h2 id="es-h">Canvas is outdated</h2></div>' +
    '<div class="body center">' +
    `<p class="hint">${stale ? esc(staleSummary(stale)) : ''}</p>` +
    '<div class="cmdbox"><button class="cmd fill" type="button" id="view-stale">view stale canvas</button>' +
    '<button class="cmd" type="button" id="stale-generate" aria-haspopup="dialog">generate for current head</button></div>' +
    skillCommandHtml(bundle) +
    dropZoneHtml() +
    sharedCanvasCalloutHtml(bundle) +
    '</div></section>'
  )
}
