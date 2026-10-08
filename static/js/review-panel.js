// @ts-check
// The review tab: every comment waiting in the pending review, in one list, before any of it is
// submitted. Each draft says where it sits and where it came from, links to its line, and carries
// the same edit and delete it has on the diff.
/** @typedef {import('./contract-types.js').PendingComment} PendingComment */
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').PrState} PrState */
import { esc } from './dom.js'
import { hostLabel } from './host.js'
import { draftsByCommit, pendingCommentHtml, pendingComments, pendingLabel, pendingRange } from './pending.js'
import { renderMarkdown } from './markdown.js'

export const REVIEW_PANEL_ID = 'review-panel'

/**
 * The `#line:` link to the lines a draft comments on.
 * @param {PendingComment} p
 */
function draftLink(p) {
  const range = p.startLine !== undefined && p.startLine !== p.line ? `${p.startLine}-${p.line}` : `${p.line}`
  return `#line:${p.path}:${range}${p.side === 'old' ? ':old' : ''}`
}

/**
 * What keys a draft's row, and what it shows that can change: its text and its commit.
 * @param {PendingComment} p
 */
function draftAttrs(p) {
  return `data-pending-id="${esc(p.id)}" data-sig="${esc(JSON.stringify([p.body, p.headSha]))}"`
}

/**
 * Where a draft came from: an attention point, a comment AI Chat proposed, or the reader's own.
 * @param {PendingComment} p
 * @param {ReadonlyArray<Point>} points
 */
function draftOrigin(p, points) {
  const chat = p.proposalFingerprint !== undefined
  if (p.pointFingerprint !== undefined) {
    const point = points.find(q => q.fingerprint === p.pointFingerprint)
    const about = point === undefined ? 'an attention point' : `the point “${esc(point.title)}”`
    return chat ? `proposed by AI Chat about ${about}` : `from ${about}`
  }
  return chat ? 'proposed by AI Chat' : 'your comment'
}

/**
 * Everything the review tab holds, drawn from the state.
 * @param {PrState | null | undefined} state
 * @param {{ headSha?: string | undefined, points: ReadonlyArray<Point>, now: Date }} ctx
 */
export function reviewPanelHtml(state, ctx) {
  const all = pendingComments(state)
  const { current, earlier } = draftsByCommit(state, ctx.headSha)
  if (all.length === 0) {
    return (
      '<p class="muted review-empty">Nothing waits in your review. Use <b>add to review</b> on an attention ' +
      'point, or comment on a line, to start one.</p>'
    )
  }
  const host = esc(hostLabel())
  const byPath = new Map(/** @type {Array<[string, PendingComment[]]>} */ ([]))
  for (const draft of current) {
    byPath.set(draft.path, [...(byPath.get(draft.path) ?? []), draft])
  }
  const files = [...byPath]
    .map(
      ([path, drafts]) =>
        `<h3 class="lbl review-path">${esc(path)}</h3><ol class="review-drafts">` +
        drafts
          .map(
            p =>
              `<li class="review-draft" ${draftAttrs(p)}>` +
              `<p class="review-where"><a class="loc" href="${esc(draftLink(p))}">${esc(pendingRange(p))}</a>` +
              ` <span class="muted">· ${draftOrigin(p, ctx.points)}</span></p>` +
              pendingCommentHtml(p, ctx.now) +
              '</li>'
          )
          .join('') +
        '</ol>'
    )
    .join('')
  const old =
    earlier.length === 0
      ? ''
      : '<h3 class="lbl review-path">Written on earlier commits</h3>' +
        '<p class="muted small">These can be submitted only if the diff is unchanged. Otherwise copy the text, delete the draft, and comment on the current code.</p>' +
        '<ol class="review-drafts">' +
        earlier
          .map(
            p =>
              `<li class="review-draft earlier" ${draftAttrs(p)}>` +
              `<p class="review-where">${esc(pendingRange(p))} <span class="muted">· commit ${esc(p.headSha.slice(0, 7))} · ${draftOrigin(p, ctx.points)}</span></p>` +
              `<div class="prose">${renderMarkdown(p.body, { github: true })}</div>` +
              '<span class="tbtns">' +
              `<button class="cmd" type="button" data-copy="${esc(p.body)}">copy</button>` +
              `<button class="cmd" type="button" data-act="pending-delete" data-pending-id="${esc(p.id)}">delete</button></span></li>`
          )
          .join('') +
        '</ol>'
  return (
    `<div class="review-head"><p><b>${esc(pendingLabel(all.length))}</b>. Nothing is on ${host} until you submit.</p>` +
    '<span class="tbtns">' +
    '<button class="cmd fill" type="button" data-act="pending-finish" data-needs-post>finish your review</button>' +
    '<button class="cmd" type="button" data-act="pending-discard">discard</button></span></div>' +
    files +
    old
  )
}

/**
 * Draws the review tab again when the drafts changed, and the counts on its tab and launcher. A
 * draft whose text and commit did not change keeps its row, so an edit being written in it
 * survives a change to any other draft.
 * @param {ParentNode} root
 * @param {PrState} state
 * @param {{ headSha?: string | undefined, points: ReadonlyArray<Point> }} ctx
 */
export function refreshReviewPanel(root, state, ctx) {
  const drafts = pendingComments(state)
  for (const count of Array.from(root.querySelectorAll('.review-count'))) {
    count.textContent = String(drafts.length)
    count.toggleAttribute('data-empty', drafts.length === 0)
  }
  const launcher = root.querySelector('.review-launcher')
  if (launcher !== null) {
    launcher.textContent = drafts.length === 0 ? 'Your review' : `Your review · ${drafts.length}`
    // With AI Chat off, the launcher stands in for the review only while there is one.
    launcher.toggleAttribute('data-empty', drafts.length === 0)
  }
  const panel = root.querySelector(`#${REVIEW_PANEL_ID}`)
  if (panel === null) {
    return
  }
  const signature = JSON.stringify([ctx.headSha ?? null, drafts.map(d => [d.id, d.body, d.headSha])])
  if (panel.getAttribute('data-drafts') === signature) {
    return
  }
  const template = document.createElement('template')
  template.innerHTML = reviewPanelHtml(state, { ...ctx, now: new Date() })
  const drawn = new Map(
    Array.from(panel.querySelectorAll('li.review-draft')).map(li => [li.getAttribute('data-pending-id'), li])
  )
  for (const row of Array.from(template.content.querySelectorAll('li.review-draft'))) {
    const old = drawn.get(row.getAttribute('data-pending-id'))
    if (old !== undefined && old.getAttribute('data-sig') === row.getAttribute('data-sig')) {
      row.replaceWith(old)
    }
  }
  panel.replaceChildren(template.content)
  panel.setAttribute('data-drafts', signature)
}
