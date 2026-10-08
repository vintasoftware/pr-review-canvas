// @ts-check
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').PrState} PrState */
import { askButtonHtml } from './ask.js'
import { sendCommandsHtml, viewCommentHtml } from './comment-link.js'
import { esc } from './dom.js'
import { hostLabel } from './host.js'
import { pendingCommentHtml, pendingForPoint, pendingRange } from './pending.js'
import { layerAnchorId, pointAnchorId } from './keys.js'
import { renderMarkdown } from './markdown.js'
import {
  audiencePillHtml,
  reopenButtonHtml,
  selfReviewNoteHtml,
  settleButtonHtml,
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
 * Where a point stands for this reader. Every point starts `open`. `queued` waits in the pending
 * review, `posted` reached the forge (on its own or with a submitted review), `resolved` is the
 * author's answer for every reader, and `dismissed` is this reader's own mark. When more than one
 * applies, the one that says most wins: an answer for everyone, then what the forge holds, then
 * what waits to go there, then the reader's private mark.
 * @typedef {'open' | 'queued' | 'posted' | 'resolved' | 'dismissed'} PointStatus
 */

/**
 * @param {Point} p
 * @param {PrState | null | undefined} state
 * @returns {PointStatus}
 */
export function pointStatus(p, state) {
  const fp = p.fingerprint
  if (settlementOf(p) !== undefined) {
    return 'resolved'
  }
  if (
    state?.posted.some(e => e.pointFingerprint === fp) === true ||
    (state?.submitted ?? []).some(d => d.pointFingerprint === fp)
  ) {
    return 'posted'
  }
  if (pendingForPoint(state, fp).length > 0) {
    return 'queued'
  }
  if (state?.dismissed[fp] !== undefined) {
    return 'dismissed'
  }
  return 'open'
}

/** What each status but `open` is called, on its pill and in the overview's count. */
export const STATUS_LABELS = /** @type {const} */ ({
  queued: 'in your review',
  posted: 'posted',
  resolved: 'resolved',
  dismissed: 'dismissed',
})

/**
 * The points still on the reader's list: nothing has been done with them yet.
 * @param {ReadonlyArray<Point>} points
 * @param {PrState | null | undefined} state
 */
export function openPoints(points, state) {
  return points.filter(p => pointStatus(p, state) === 'open')
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
 * Whether a point's comment names the canvas it came from. Off when `sharing.mentionCanvas` is
 * off; `app.js` sets it once per render, before the cards that read it are built.
 */
let mentionCanvas = true

/** @param {boolean} on */
export function setMentionCanvas(on) {
  mentionCanvas = on
}

/**
 * The point as a GitHub comment: the title, the body, and where it is anchored.
 * @param {Point} p
 */
export function pointToMarkdown(p) {
  const source = mentionCanvas ? ' · from the pr-review canvas' : ''
  return `**${p.title}**\n\n${p.body}\n\n_${pointLocation(p)} · ${p.kind} · ${p.level}${source}_`
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
 * The commands a point carries, by where it stands. An open point offers every way to act on it:
 * `copy` puts the markdown on the clipboard, `post to github` posts it at the anchor, `add to
 * review` holds it as a draft instead, `resolve` lets the author answer it for every reviewer, and
 * `dismiss` takes it off this reader's list. A point already acted on keeps `copy` and `ask`, and
 * offers the way back from what was done to it: its draft carries its own edit and delete,
 * `reopen` takes back a resolution, and `restore` a dismissal.
 * @param {Point} p
 * @param {{ status?: PointStatus, postedUrl?: string | undefined }} [opts]
 * @returns {string}
 */
export function pointCommandsHtml(p, opts = {}) {
  const status = opts.status ?? 'open'
  const fp = esc(p.fingerprint)
  const settle = settleButtonHtml(p)
  const ask = askButtonHtml(pointContext(p))
  const commentUrl = settlementOf(p)?.commentUrl
  /** @type {Record<PointStatus, string>} */
  const byStatus = {
    open:
      sendCommandsHtml({ kind: 'point', id: p.id }) +
      ask +
      settle +
      `<button class="cmd" type="button" data-act="point-dismiss" data-fingerprint="${fp}">dismiss</button>`,
    queued: ask + settle,
    posted: (opts.postedUrl === undefined ? '' : viewCommentHtml(opts.postedUrl)) + ask + settle,
    resolved: (commentUrl === undefined ? '' : viewCommentHtml(commentUrl)) + ask + reopenButtonHtml(p),
    dismissed:
      ask +
      `<button class="cmd" type="button" data-act="point-restore" data-fingerprint="${fp}">restore</button>`,
  }
  return (
    `<span class="tbtns">` +
    `<button class="cmd" type="button" data-copy="${esc(pointToMarkdown(p))}" title="Copy as Markdown">copy</button>` +
    `${byStatus[status]}</span>`
  )
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

/** @typedef {{ paths: ReadonlySet<string>, state?: PrState, posted?: ReadonlyMap<string, string>, now?: Date }} PointContext */

/**
 * The parts of a point that say where it stands, for every status but `open`: the pill next to the
 * title, the one line that stands for the point while it is collapsed, and what was done with it,
 * shown once the reader expands it.
 * @param {Point} p
 * @param {Exclude<PointStatus, 'open'>} status
 * @param {PointContext} ctx
 * @param {{ card: boolean }} opts
 * @returns {{ pill: string, summary: string, outcome: string }}
 */
function statusPartsHtml(p, status, ctx, opts) {
  const pill =
    status === 'queued'
      ? `<span class="pill pending queued">${STATUS_LABELS.queued}</span>`
      : `<span class="pill status ${status}">${STATUS_LABELS[status]}</span>`
  const line = /** @param {string} text */ text => `<p class="p-summary muted">${text}</p>`
  const host = esc(hostLabel())
  switch (status) {
    case 'queued': {
      const drafts = pendingForPoint(ctx.state, p.fingerprint)
      const only = drafts.length === 1 ? drafts[0] : undefined
      // A draft on another line than the point's (a comment AI Chat proposed about it) says where.
      const elsewhere = only !== undefined && (only.path !== p.path || only.line !== p.line)
      const what =
        only === undefined
          ? `${drafts.length} drafts wait in your review`
          : `Waits in your review${elsewhere ? ` at ${esc(pendingRange(only))}` : ''}`
      const now = ctx.now ?? new Date()
      return {
        pill,
        summary: line(`${what} · not on ${host} yet`),
        outcome: opts.card
          ? `<div class="p-outcome"><h4 class="lbl">${drafts.length === 1 ? 'Your draft' : 'Your drafts'}</h4>` +
            drafts
              .map(
                d =>
                  `<p class="p-draft-where muted small">${esc(pendingRange(d))} · ${d.proposalFingerprint === undefined ? 'the point’s text' : 'proposed by AI Chat'}</p>` +
                  pendingCommentHtml(d, now)
              )
              .join('') +
            '</div>'
          : '',
      }
    }
    case 'posted': {
      const url = postedFor(p, ctx)
      return {
        pill,
        summary: line(
          url === undefined
            ? `Sent to ${host} with your review`
            : `Posted to ${host} · <a href="${esc(url)}" target="_blank" rel="noopener noreferrer">view comment</a>`
        ),
        outcome: '',
      }
    }
    case 'resolved': {
      const reason = settlementOf(p)?.reason ?? ''
      return {
        pill,
        summary: line(`Resolved by the author: ${esc(reason.split('\n')[0] ?? '')}`),
        outcome:
          '<div class="p-outcome"><h4 class="lbl">Author’s reason</h4>' +
          `<div class="prose settled-reason">${renderMarkdown(reason, { paths: ctx.paths })}</div></div>`,
      }
    }
    case 'dismissed':
      return { pill, summary: line('You dismissed this point; other readers still see it'), outcome: '' }
  }
}

/**
 * What decides how a point is drawn, short of the clock. A point is drawn again only when this
 * changes, so a reason being written under it or a command mid-request is left alone otherwise.
 * @param {Point} p
 * @param {PointStatus} status
 * @param {PointContext} ctx
 */
function pointSignature(p, status, ctx) {
  const settlement = settlementOf(p)
  return JSON.stringify([
    status,
    postedFor(p, ctx) ?? null,
    pendingForPoint(ctx.state, p.fingerprint).map(d => [d.id, d.body]),
    settlement?.reason ?? null,
    settlement?.commentUrl ?? null,
    settleButtonHtml(p) !== '',
    reopenButtonHtml(p) !== '',
  ])
}

/**
 * The attributes and the inside of a point, shared by its card and its row in the diff. A point
 * that was acted on is drawn collapsed to its title and one line, with a toggle that shows the
 * rest; an open point is always drawn whole.
 * @param {Point} p
 * @param {PointContext} ctx
 * @param {{ card: boolean }} opts `card` adds the link to the point's line and a queued point's draft:
 *   a row sits on that line, with the draft's own row right under it
 */
function pointPartsHtml(p, ctx, opts) {
  const status = pointStatus(p, ctx.state)
  const parts =
    status === 'open' ? { pill: '', summary: '', outcome: '' } : statusPartsHtml(p, status, ctx, opts)
  const toggle =
    status === 'open'
      ? ''
      : `<button class="cmd p-toggle" type="button" data-act="point-expand" aria-expanded="false" aria-label="Show the point: ${esc(p.title)}">show</button>`
  const loc = opts.card ? `<a class="loc" href="${esc(pointLink(p))}">${esc(pointLocation(p))}</a>` : ''
  return {
    attrs:
      `data-point="${esc(p.id)}" data-fingerprint="${esc(p.fingerprint)}" data-status="${status}" ` +
      `data-sig="${esc(pointSignature(p, status, ctx))}"`,
    handled: status === 'open' ? '' : ' is-handled',
    title: `<span class="p-title">${esc(p.title)}</span><span class="pill kind">${esc(p.kind)}</span>${audiencePillHtml(p)}${parts.pill}${loc}${toggle}`,
    rest:
      parts.summary +
      `<div class="prose">${renderMarkdown(p.body, { paths: ctx.paths })}</div>` +
      parts.outcome +
      pointCommandsHtml(p, { status, postedUrl: postedFor(p, ctx) }),
  }
}

/**
 * One attention point card, shown in the layer that owns the point.
 * @param {Point} p
 * @param {PointContext} ctx
 */
export function pointCardHtml(p, ctx) {
  const { attrs, handled, title, rest } = pointPartsHtml(p, ctx, { card: true })
  return (
    `<li class="finding${handled}" id="${esc(pointAnchorId(p.id))}" ${attrs}>${squareHtml(p)}<div>` +
    `<div class="f-title">${title}</div>${rest}</div></li>`
  )
}

/**
 * The inline row under a diff line.
 * @param {Point} p
 * @param {PointContext} ctx
 */
export function pointRowHtml(p, ctx) {
  const { attrs, handled, title, rest } = pointPartsHtml(p, ctx, { card: false })
  return (
    `<tr class="ifind ${p.level}${handled}" ${attrs}><td class="code x" colspan="4">` +
    `<div class="f-title">${squareHtml(p)}${title}</div>${rest}</td></tr>`
  )
}

/**
 * The overview's line that counts the points by where they stand, with the switch that takes the
 * ones already acted on off the page. Nothing is drawn for a canvas without points.
 * @param {ReadonlyArray<Point>} points
 * @param {PrState | null | undefined} state
 * @param {boolean} [hiding] whether the points acted on are hidden now
 */
export function pointStatusesHtml(points, state, hiding = false) {
  if (points.length === 0) {
    return '<p class="point-statuses" hidden></p>'
  }
  /** @type {Record<PointStatus, number>} */
  const counts = { open: 0, queued: 0, posted: 0, resolved: 0, dismissed: 0 }
  for (const p of points) {
    counts[pointStatus(p, state)] += 1
  }
  const handled = points.length - counts.open
  const parts = [`<b>${counts.open} open</b>`]
  for (const status of /** @type {const} */ (['queued', 'posted', 'resolved', 'dismissed'])) {
    if (counts[status] > 0) {
      parts.push(`${counts[status]} ${STATUS_LABELS[status]}`)
    }
  }
  const toggle =
    handled === 0
      ? ''
      : ` <button class="cmd" type="button" data-act="toggle-handled" aria-pressed="${hiding}">${hiding ? 'show' : 'hide'} the ${handled} acted on</button>`
  return `<p class="point-statuses muted">Attention points: ${parts.join(' · ')}${toggle}</p>`
}

/**
 * Whether the page hides the points already acted on, read from the overview's switch.
 * @param {ParentNode} root
 */
export function hidingHandled(root) {
  return root.querySelector('[data-act="toggle-handled"]')?.getAttribute('aria-pressed') === 'true'
}

/**
 * Draws every point again where it changed, wherever it is on the page, and rebuilds the counts,
 * the overview's status line, and the author's note. A point keeps the reader's expanded view
 * while its status holds, and collapses when it changes. Calling it again with the same state
 * changes nothing.
 * @param {ParentNode} root
 * @param {ReadonlyArray<Point>} points
 * @param {PrState} state
 * @param {{ paths: ReadonlySet<string>, layers?: ReadonlyArray<Layer>, posted?: ReadonlyMap<string, string> }} ctx
 */
export function applyPointStates(root, points, state, ctx) {
  const byId = new Map(points.map(p => [p.id, p]))
  for (const el of Array.from(root.querySelectorAll('[data-point][data-status]'))) {
    const point = byId.get(el.getAttribute('data-point') ?? '')
    if (point !== undefined) {
      refreshPoint(el, point, { state, ...ctx })
    }
  }
  const open = openPoints(points, state)
  for (const counter of Array.from(root.querySelectorAll('.point-count'))) {
    const layerId = counter.closest('[data-layer]')?.getAttribute('data-layer')
    counter.textContent = String(open.filter(p => p.layerId === layerId).length)
  }
  replaceWithHtml(root.querySelector('.point-statuses'), host =>
    pointStatusesHtml(points, state, hidingHandled(host))
  )
  replaceWithHtml(root.querySelector('.sevsum'), () => sevsumHtml(open, ctx.layers ?? []))
  replaceWithHtml(root.querySelector('.self-review-note'), () => selfReviewNoteHtml(points))
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
 * Draws one point again in place when what it shows changed: it joined the review or left it,
 * reached the forge, was resolved, reopened, dismissed or restored, or its draft was edited. The
 * element stays the same one, so the focus ring on it stays too.
 * @param {Element} el the card or row that carries `data-point`
 * @param {Point} p
 * @param {PointContext & { state: PrState }} ctx
 * @returns {boolean} true when the point was drawn again
 */
export function refreshPoint(el, p, ctx) {
  // The signature is compared before anything is drawn: most state changes leave most points as
  // they are, and drawing one renders its markdown.
  if (pointSignature(p, pointStatus(p, ctx.state), ctx) === el.getAttribute('data-sig')) {
    return false
  }
  const row = el.tagName === 'TR'
  const template = document.createElement('template')
  template.innerHTML = row ? `<table><tbody>${pointRowHtml(p, ctx)}</tbody></table>` : pointCardHtml(p, ctx)
  const next = row ? template.content.querySelector('tr') : template.content.firstElementChild
  if (next === null) {
    return false
  }
  const expanded =
    next.getAttribute('data-status') === el.getAttribute('data-status') && el.hasAttribute('data-expanded')
  const focused = el !== el.ownerDocument.activeElement && el.contains(el.ownerDocument.activeElement)
  for (const name of ['class', 'data-status', 'data-sig']) {
    el.setAttribute(name, next.getAttribute(name) ?? '')
  }
  el.replaceChildren(...Array.from(next.childNodes))
  setPointExpanded(el, expanded)
  // The command the reader used is gone; the focus goes to what now stands for the point.
  const target = focused ? el.querySelector('[data-act="point-expand"], .tbtns button') : null
  if (target instanceof HTMLElement) {
    target.focus()
  }
  return true
}

/**
 * Shows or hides the rest of a point that was acted on. An open point is always shown whole.
 * @param {Element} el the card or row that carries `data-point`
 * @param {boolean} [expanded] omitted flips it
 */
export function setPointExpanded(el, expanded = !el.hasAttribute('data-expanded')) {
  const on = expanded && el.classList.contains('is-handled')
  el.toggleAttribute('data-expanded', on)
  const toggle = el.querySelector('[data-act="point-expand"]')
  if (toggle !== null) {
    const title = el.querySelector('.p-title')?.textContent ?? ''
    toggle.setAttribute('aria-expanded', String(on))
    toggle.setAttribute('aria-label', `${on ? 'Hide' : 'Show'} the point: ${title}`)
    toggle.textContent = on ? 'hide' : 'show'
  }
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
