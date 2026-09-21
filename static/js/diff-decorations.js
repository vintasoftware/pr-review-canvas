// @ts-check
// Rows added on top of a rendered diff: annotation bands, inline attention points, GitHub
// threads. applyDecorations is idempotent: it removes what it added before re-adding.
/** @typedef {import('./contract-types.js').Annotation} Annotation */
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */
/** @typedef {import('./threads.js').Thread} Thread */
import { findRow, nearestRow } from './anchors.js'
import { viewCommentHtml } from './comment-link.js'
import { esc, fragment, avatarHtml, timeAgo } from './dom.js'
import { renderMarkdown } from './markdown.js'
import { pendingRowHtml } from './pending.js'
import { pointRowHtml } from './points.js'

const DECORATION = 'data-decoration'

/**
 * Rows from `start` to `end` on `side` get the annotation band edge; the note sits under the last one.
 * @param {HTMLElement} card the file card (or any ancestor of the tables)
 * @param {string} key
 * @param {Annotation} a
 * @returns {boolean} false when no row of the range is on the page
 */
export function insertNoteRow(card, key, a) {
  /** @type {HTMLTableRowElement | null} */
  let last = null
  for (let line = a.startLine; line <= a.endLine; line++) {
    const row = findRow(card, key, a.side, line)
    if (row) {
      row.classList.add('ann')
      last = row
    }
  }
  let approx = false
  if (last === null) {
    const near = nearestRow(card, key, a.side, a.endLine)
    if (near === null) {
      return false
    }
    last = near.row
    approx = true
  }
  const range = a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}–${a.endLine}`
  const html =
    `<tr class="annot ann${approx ? ' is-approx' : ''}" ${DECORATION}="note"><td class="code x" colspan="4">` +
    `<span class="lbl">Annotation · ${esc(range)}${a.side === 'old' ? ' (old)' : ''}</span>` +
    `<div class="prose">${renderMarkdown(a.text)}</div></td></tr>`
  last.insertAdjacentElement('afterend', firstRow(html))
  return true
}

/**
 * @param {HTMLElement} card
 * @param {string} key
 * @param {Point} p
 * @param {{ paths: ReadonlySet<string>, state?: import('./contract-types.js').PrState, posted?: ReadonlyMap<string, string> }} ctx
 * @returns {boolean}
 */
export function insertPointRow(card, key, p, ctx) {
  const side = p.side ?? 'new'
  const line = p.endLine ?? p.line
  const near = nearestRow(card, key, side, line)
  if (near === null) {
    return false
  }
  const row = firstRow(pointRowHtml(p, ctx))
  row.setAttribute(DECORATION, 'point')
  if (near.approx) {
    row.classList.add('is-approx')
  }
  near.row.insertAdjacentElement('afterend', row)
  return true
}

/**
 * @param {ReviewComment} c
 * @param {Date} now
 */
export function commentHtml(c, now) {
  return (
    `<div class="cmt">${avatarHtml(c)}` +
    `<span class="who"><b>${esc(c.author)}</b> <span class="muted">${esc(timeAgo(c.createdAt, now))}</span> ${viewCommentHtml(c.url)}</span>` +
    `<div class="prose">${renderMarkdown(c.body, { github: true })}</div></div>`
  )
}

/**
 * A thread row carries both views: the comments, and the one muted line a resolved or hidden
 * thread collapses to. Showing one and hiding the other is then a local toggle with no data.
 * @param {Thread} t
 * @param {{ now: Date, hidden?: boolean }} opts
 * @returns {string}
 */
export function threadRowHtml(t, opts) {
  const rootId = t.root.id
  const hidden = opts.hidden === true
  const collapsed = t.resolved || hidden
  const label = t.resolved ? '1 resolved thread' : '1 hidden thread'
  const comments = [t.root, ...t.replies].map(c => commentHtml(c, opts.now)).join('')
  // A resolved thread folds away on the page only; an open one is hidden in the local state.
  const hide = t.resolved
    ? `<button class="cmd" type="button" data-act="thread-collapse" data-thread="${rootId}">collapse</button>`
    : `<button class="cmd" type="button" data-act="thread-hide" data-thread="${rootId}">hide</button>`
  return (
    `<tr class="thread${t.resolved ? ' resolved' : ''}${hidden ? ' hidden-thread' : ''}" data-thread="${rootId}">` +
    '<td class="code x" colspan="4">' +
    `<div class="thread-full"${collapsed ? ' hidden' : ''}>${comments}` +
    `<span class="tbtns"><button class="cmd" type="button" data-act="thread-reply" data-thread="${rootId}" data-needs-post>reply</button>${hide}</span></div>` +
    `<div class="thread-collapsed"${collapsed ? '' : ' hidden'}>${label} · ` +
    `<button class="cmd" type="button" data-act="thread-show" data-thread="${rootId}">show</button></div>` +
    '</td></tr>'
  )
}

/**
 * Swaps the two views of a thread row.
 * @param {Element} row
 * @param {boolean} collapsed
 */
export function setThreadCollapsed(row, collapsed) {
  row.querySelector('.thread-full')?.toggleAttribute('hidden', collapsed)
  row.querySelector('.thread-collapsed')?.toggleAttribute('hidden', !collapsed)
  row.classList.toggle('hidden-thread', collapsed && !row.classList.contains('resolved'))
}

/**
 * @param {HTMLElement} card
 * @param {string} key
 * @param {Thread} t
 * @param {{ now: Date, hidden?: boolean }} opts
 * @returns {boolean}
 */
export function insertThreadRow(card, key, t, opts) {
  if (t.line === null) {
    return false
  }
  const near = nearestRow(card, key, t.side, t.line)
  if (near === null) {
    return false
  }
  const row = firstRow(threadRowHtml(t, opts))
  row.setAttribute(DECORATION, 'thread')
  if (near.approx) {
    row.classList.add('is-approx')
  }
  near.row.insertAdjacentElement('afterend', row)
  return true
}

/**
 * The drafts of one file, drawn under the lines they comment on. A draft whose line is not on the
 * page (a fold, or a file drawn short) goes under the nearest row, like every other decoration.
 * @param {HTMLElement} card
 * @param {string} key
 * @param {ReadonlyArray<import('./contract-types.js').PendingComment>} drafts
 * @param {Date} now
 * @returns {{ placed: number, missed: number }}
 */
export function insertPendingRows(card, key, drafts, now) {
  let placed = 0
  let missed = 0
  // One row per line, so two drafts on the same line sit together in the order they were written.
  const byLine = new Map()
  for (const p of drafts) {
    const at = `${p.side}:${p.line}`
    byLine.set(at, [...(byLine.get(at) ?? []), p])
  }
  for (const group of [...byLine.values()].reverse()) {
    const first = group[0]
    const near = nearestRow(card, key, first.side, first.line)
    if (near === null) {
      missed += group.length
      continue
    }
    const row = firstRow(pendingRowHtml(group, now))
    row.setAttribute(DECORATION, 'pending')
    if (near.approx) {
      row.classList.add('is-approx')
    }
    near.row.insertAdjacentElement('afterend', row)
    placed += group.length
  }
  return { placed, missed }
}

/**
 * @param {string} html
 * @returns {HTMLTableRowElement}
 */
function firstRow(html) {
  const tbody = document.createElement('tbody')
  tbody.append(fragment(html))
  const row = tbody.firstElementChild
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error('decoration html must start with <tr>')
  }
  return row
}

/**
 * Removes every decoration row and annotation band, then adds them back from the data.
 * Order under one line: annotation, then attention points, then threads (each insert goes
 * right after the anchor row, so they are added in reverse).
 * @param {HTMLElement} card
 * @param {string} key
 * @param {{ annotations: ReadonlyArray<Annotation>, points: ReadonlyArray<Point>, threads: ReadonlyArray<Thread>, pending?: ReadonlyArray<import('./contract-types.js').PendingComment>, paths: ReadonlySet<string>, now: Date, state?: import('./contract-types.js').PrState, posted?: ReadonlyMap<string, string>, hiddenThreads?: ReadonlySet<number> }} data
 * @returns {{ placed: number, missed: number }}
 */
export function applyDecorations(card, key, data) {
  for (const row of Array.from(card.querySelectorAll(`tr[${DECORATION}]`))) {
    row.remove()
  }
  for (const row of Array.from(card.querySelectorAll('tr.ann'))) {
    row.classList.remove('ann')
  }
  let placed = 0
  let missed = 0
  const count = /** @param {boolean} ok */ ok => {
    if (ok) {
      placed++
    } else {
      missed++
    }
  }
  // Drafts are added before the threads, so under one line they end up after them: the comment
  // that is already on the forge reads first, the one still being written reads last.
  const drafts = insertPendingRows(card, key, data.pending ?? [], data.now)
  placed += drafts.placed
  missed += drafts.missed
  for (const t of [...data.threads].reverse()) {
    count(
      insertThreadRow(card, key, t, { now: data.now, hidden: data.hiddenThreads?.has(t.root.id) ?? false })
    )
  }
  for (const p of [...data.points].reverse()) {
    count(
      insertPointRow(card, key, p, {
        paths: data.paths,
        ...(data.state === undefined ? {} : { state: data.state }),
        ...(data.posted === undefined ? {} : { posted: data.posted }),
      })
    )
  }
  for (const a of [...data.annotations].reverse()) {
    count(insertNoteRow(card, key, a))
  }
  return { placed, missed }
}
