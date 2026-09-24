// @ts-check
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').PrState} PrState */
import { askButtonHtml } from './ask.js'
import { viewCommentHtml } from './comment-link.js'
import { esc } from './dom.js'
import { pendingForPoint } from './pending.js'
import { postToLabel } from './host.js'
import { layerAnchorId, pointAnchorId } from './keys.js'
import { renderMarkdown } from './markdown.js'
import {
  audiencePillHtml,
  isSelfReview,
  selfReviewNoteHtml,
  settleButtonHtml,
  settledListHtml,
  settlementOf,
} from './self-review.js'

export const LEVELS = /** @type {const} */ (['decide', 'check', 'fyi'])

/**
 * @param {ReadonlyArray<Point>} points
 * @returns {Record<'decide' | 'check' | 'fyi', Point[]>}
 */
export function pointsByLevel(points) {
  /** @type {Record<'decide' | 'check' | 'fyi', Point[]>} */
  const out = { decide: [], check: [], fyi: [] }
  for (const p of points) {
    out[p.level].push(p)
  }
  return out
}

/**
 * Whether the point is off the reader's list: they dismissed it, or the author settled it.
 * @param {Point} p
 * @param {PrState | undefined} state
 */
export function isSetAside(p, state) {
  return state?.dismissed[p.fingerprint] !== undefined || settlementOf(p) !== undefined
}

/**
 * The points still on the reader's list.
 * @param {ReadonlyArray<Point>} points
 * @param {PrState} state
 */
export function openPoints(points, state) {
  return points.filter(p => !isSetAside(p, state))
}

/**
 * The `#line:` link for a point's anchor.
 * @param {Point} p
 */
export function pointLink(p) {
  const range = p.endLine !== undefined && p.endLine !== p.line ? `${p.line}-${p.endLine}` : `${p.line}`
  return `#line:${p.path}:${range}${p.side === 'old' ? ':old' : ''}`
}

/** @param {Point} p */
export function pointLocation(p) {
  const range = p.endLine !== undefined && p.endLine !== p.line ? `${p.line}-${p.endLine}` : `${p.line}`
  return `${p.path}:${range}`
}

/**
 * @param {Point} p
 */
export function squareHtml(p) {
  return `<span class="sq ${p.level}" role="img" aria-label="${p.level}" title="${p.level}"></span>`
}

/**
 * The point as a GitHub comment: the title, the body, and where it is anchored.
 * @param {Point} p
 */
export function pointToMarkdown(p) {
  return `**${p.title}**\n\n${p.body}\n\n_${pointLocation(p)} · ${p.kind} · ${p.level} · from the pr-review canvas_`
}

/**
 * What the chat is asked about when a point's `[ ask ]` is used: the point itself. The server
 * resolves the fingerprint against the canvas and sends the agent the point's text along with
 * the lines it sits on, so the agent sees what the reader is reacting to.
 * @param {Point} p
 * @returns {import('./chat-context.js').ChatContext}
 */
export function pointContext(p) {
  return { kind: 'point', fingerprint: p.fingerprint }
}

/**
 * What a point offers for getting its text onto the forge: the link to the comment it was posted
 * as, the note that it is waiting in the review, or the two ways to send it. Unlike the box on a
 * diff line, a point keeps both ways while a review is open: its text is written in advance, so
 * firing one off on its own is a use of its own, not a comment jumping the queue.
 * @param {Point} p
 * @param {{ postedUrl?: string | undefined, queued?: boolean }} opts
 */
function pointSendHtml(p, opts) {
  if (opts.postedUrl !== undefined) {
    return viewCommentHtml(opts.postedUrl)
  }
  if (opts.queued === true) {
    return '<span class="pill pending queued">in your review</span>'
  }
  return (
    `<button class="cmd" type="button" data-act="point-post" data-point="${esc(p.id)}" data-needs-post>${postToLabel()}</button>` +
    `<button class="cmd" type="button" data-act="point-queue" data-point="${esc(p.id)}">add to review</button>`
  )
}

/**
 * The commands every point carries. `copy` puts the markdown on the clipboard, `post to github`
 * opens nothing and posts it at the anchor, `add to review` holds it as a draft instead, `settle`
 * lets the author answer it for every reviewer, and `dismiss` takes it off this reader's page.
 * @param {Point} p
 * @param {{ dismissed?: boolean, postedUrl?: string | undefined, queued?: boolean }} [opts]
 * @returns {string}
 */
export function pointCommandsHtml(p, opts = {}) {
  const fp = esc(p.fingerprint)
  const toggle = opts.dismissed
    ? `<button class="cmd" type="button" data-act="point-restore" data-fingerprint="${fp}">restore</button>`
    : `<button class="cmd" type="button" data-act="point-dismiss" data-fingerprint="${fp}">dismiss</button>`
  const settle = settleButtonHtml(p)
  return (
    `<span class="tbtns" data-queued="${opts.queued === true ? '1' : '0'}" data-settleable="${settle === '' ? '0' : '1'}">` +
    `<button class="cmd" type="button" data-copy="${esc(pointToMarkdown(p))}">copy</button>` +
    pointSendHtml(p, opts) +
    askButtonHtml(pointContext(p)) +
    settle +
    toggle +
    '</span>'
  )
}

/**
 * Whether this point is waiting in the review, read from the state the renderer was given.
 * @param {Point} p
 * @param {{ state?: PrState }} ctx
 */
export function queuedFor(p, ctx) {
  return pendingForPoint(ctx.state, p.fingerprint) !== undefined
}

/**
 * The comment this point was posted as, when it was.
 * @param {Point} p
 * @param {{ posted?: ReadonlyMap<string, string> }} ctx
 */
export function postedFor(p, ctx) {
  return ctx.posted?.get(p.fingerprint)
}

/**
 * Where each point's posted comment lives, read from the state and the comments the page holds.
 * @param {import('./contract-types.js').PrState} state
 * @param {ReadonlyArray<{ id: number, url: string }>} comments
 * @returns {Map<string, string>} point fingerprint → comment url
 */
export function postedUrls(state, comments) {
  const urls = new Map(comments.map(c => [c.id, c.url]))
  /** @type {Map<string, string>} */
  const out = new Map()
  for (const entry of state.posted) {
    const url = urls.get(entry.commentId)
    if (entry.pointFingerprint !== undefined && url !== undefined) {
      out.set(entry.pointFingerprint, url)
    }
  }
  return out
}

/**
 * One attention point card, shown in the layer that owns the point.
 * @param {Point} p
 * @param {{ paths: ReadonlySet<string>, state?: PrState, posted?: ReadonlyMap<string, string> }} ctx
 */
export function pointCardHtml(p, ctx) {
  const posted = postedFor(p, ctx)
  return (
    `<li class="finding" id="${esc(pointAnchorId(p.id))}" data-point="${esc(p.id)}" data-fingerprint="${esc(p.fingerprint)}"${isSetAside(p, ctx.state) ? ' hidden' : ''}>${squareHtml(p)}<div>` +
    `<div class="f-title"><span>${esc(p.title)}</span><span class="pill kind">${esc(p.kind)}</span>${audiencePillHtml(p)}` +
    `<a class="loc" href="${esc(pointLink(p))}">${esc(pointLocation(p))}</a></div>` +
    `<div class="prose">${renderMarkdown(p.body, { paths: ctx.paths })}</div>` +
    `${pointCommandsHtml(p, { postedUrl: posted, queued: queuedFor(p, ctx) })}</div></li>`
  )
}

/**
 * The muted line under the overview that holds the points the reader set aside.
 * @param {ReadonlyArray<Point>} points
 * @param {PrState} state
 * @param {{ paths: ReadonlySet<string>, posted?: ReadonlyMap<string, string> }} ctx
 * @param {boolean} [expanded]
 */
export function dismissedListHtml(points, state, ctx, expanded = false) {
  // A point the author settled is listed with its reason instead.
  const dismissed = points.filter(
    p => state.dismissed[p.fingerprint] !== undefined && settlementOf(p) === undefined
  )
  if (dismissed.length === 0) {
    return '<div class="dismissed-list" hidden></div>'
  }
  const rows = dismissed
    .map(p => {
      const posted = postedFor(p, ctx)
      return (
        `<li class="finding" data-point="${esc(p.id)}" data-fingerprint="${esc(p.fingerprint)}">${squareHtml(p)}<div>` +
        `<div class="f-title"><span>${esc(p.title)}</span><span class="pill kind">${esc(p.kind)}</span>${audiencePillHtml(p)}` +
        `<a class="loc" href="${esc(pointLink(p))}">${esc(pointLocation(p))}</a></div>` +
        `<div class="prose">${renderMarkdown(p.body, { paths: ctx.paths })}</div>` +
        `${pointCommandsHtml(p, { dismissed: true, postedUrl: posted, queued: queuedFor(p, { state }) })}</div></li>`
      )
    })
    .join('')
  return (
    '<div class="dismissed-list">' +
    `<p class="muted dismissed-line">${dismissed.length} dismissed <button class="cmd" type="button" data-act="show-dismissed" aria-expanded="${expanded}">${expanded ? 'hide' : 'show'}</button></p>` +
    `<ol class="findings dismissed"${expanded ? '' : ' hidden'}>${rows}</ol></div>`
  )
}

/**
 * Shows the points still on the reader's list and hides the ones they dismissed or the author
 * settled, wherever they are on the page, and rebuilds the counts and the two lists of set-aside
 * points. Calling it again with the same state changes nothing.
 * @param {ParentNode} root
 * @param {ReadonlyArray<Point>} points
 * @param {PrState} state
 * @param {{ paths: ReadonlySet<string>, layers?: ReadonlyArray<Layer>, posted?: ReadonlyMap<string, string> }} ctx
 */
export function applyPointStates(root, points, state, ctx) {
  const byId = new Map(points.map(p => [p.id, p]))
  for (const el of Array.from(root.querySelectorAll('[data-point]'))) {
    const point = byId.get(el.getAttribute('data-point') ?? '')
    if (point === undefined || el.closest('.dismissed-list') !== null) {
      continue
    }
    el.toggleAttribute('hidden', isSetAside(point, state))
    refreshPointCommands(el, point, {
      dismissed: state.dismissed[point.fingerprint] !== undefined,
      state,
      ...ctx,
    })
  }
  const open = openPoints(points, state)
  for (const counter of Array.from(root.querySelectorAll('.point-count'))) {
    const layerId = counter.closest('[data-layer]')?.getAttribute('data-layer')
    counter.textContent = String(open.filter(p => p.layerId === layerId).length)
  }
  const expandedIn = /** @param {Element} host @param {string} act */ (host, act) =>
    host.querySelector(`[data-act="${act}"]`)?.getAttribute('aria-expanded') === 'true'
  replaceWithHtml(root.querySelector('.dismissed-list'), host =>
    dismissedListHtml(points, state, ctx, expandedIn(host, 'show-dismissed'))
  )
  replaceWithHtml(root.querySelector('.settled-list'), host =>
    settledListHtml(points, ctx, expandedIn(host, 'show-settled'))
  )
  replaceWithHtml(root.querySelector('.sevsum'), () => sevsumHtml(open, ctx.layers ?? []))
  replaceWithHtml(root.querySelector('.self-review-note'), () => selfReviewNoteHtml(open))
}

/**
 * Replaces `host` with the element `html` builds from it; nothing happens when the page has no host.
 * @param {Element | null} host
 * @param {(host: Element) => string} html
 */
function replaceWithHtml(host, html) {
  if (host === null) {
    return
  }
  const template = document.createElement('template')
  template.innerHTML = html(host)
  const next = template.content.firstElementChild
  if (next !== null) {
    host.replaceWith(next)
  }
}

/**
 * Draws a point's commands again when it has just joined the review or just left it, or when the
 * author reopened it and it can be settled again, wherever the point is on the page. Nothing else
 * is touched: a command that is mid-request keeps its state, because neither posting nor
 * dismissing changes whether the point is waiting in the review.
 * @param {Element} el the element that carries `data-point`
 * @param {Point} p
 * @param {{ dismissed: boolean, state: PrState, posted?: ReadonlyMap<string, string> }} ctx
 * @returns {boolean} true when the commands were drawn again
 */
export function refreshPointCommands(el, p, ctx) {
  const tbtns = el.querySelector('.tbtns')
  const queued = queuedFor(p, ctx)
  const settleable = isSelfReview() && settlementOf(p) === undefined
  if (
    tbtns === null ||
    ((tbtns.getAttribute('data-queued') === '1') === queued &&
      (tbtns.getAttribute('data-settleable') === '1') === settleable)
  ) {
    return false
  }
  const template = document.createElement('template')
  template.innerHTML = pointCommandsHtml(p, {
    dismissed: ctx.dismissed,
    queued,
    ...(postedFor(p, ctx) === undefined ? {} : { postedUrl: postedFor(p, ctx) }),
  })
  const next = template.content.firstElementChild
  if (next === null) {
    return false
  }
  tbtns.replaceWith(next)
  return true
}

/**
 * The inline row under a diff line.
 * @param {Point} p
 * @param {{ paths: ReadonlySet<string>, state?: PrState, posted?: ReadonlyMap<string, string> }} ctx
 */
export function pointRowHtml(p, ctx) {
  const posted = postedFor(p, ctx)
  return (
    `<tr class="ifind ${p.level}" data-point="${esc(p.id)}" data-fingerprint="${esc(p.fingerprint)}"${isSetAside(p, ctx.state) ? ' hidden' : ''}><td class="code x" colspan="4">` +
    `<div class="f-title">${squareHtml(p)}<span>${esc(p.title)}</span><span class="pill kind">${esc(p.kind)}</span>${audiencePillHtml(p)}</div>` +
    `<div class="prose">${renderMarkdown(p.body, { paths: ctx.paths })}</div>` +
    `${pointCommandsHtml(p, { postedUrl: posted, queued: queuedFor(p, ctx) })}</td></tr>`
  )
}

/**
 * The three squares with counts in the overview header. Each count links to the first layer that
 * has a point of that level, so the overview only counts and the layers hold the cards.
 * @param {ReadonlyArray<Point>} points
 * @param {ReadonlyArray<Layer>} [layers] artifact order; omitted when there is nothing to link to
 */
export function sevsumHtml(points, layers = []) {
  const by = pointsByLevel(points)
  const cell = /** @param {'decide' | 'check' | 'fyi'} level */ level => {
    const n = by[level].length
    const square = `<span class="sq ${level}" role="img" aria-label="${n} ${level}" title="${n} ${level}"></span>${n}`
    const target = layers.find(l => by[level].some(p => p.layerId === l.id))
    return target ? `<a href="#${esc(layerAnchorId(target.key))}">${square}</a>` : `<span>${square}</span>`
  }
  return (
    `<span class="sevsum" tabindex="0" role="group" aria-label="Attention points by level">${cell('decide')}${cell('check')}${cell('fyi')}` +
    '<span class="legend" aria-hidden="true"><span><span class="sq decide"></span>decide</span><span><span class="sq check"></span>check</span><span><span class="sq fyi"></span>fyi</span></span></span>'
  )
}
