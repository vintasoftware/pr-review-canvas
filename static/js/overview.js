// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').IssueComment} IssueComment */

import { viewCommentHtml } from './comment-link.js'
import { detailsSummaryHtml, esc, initials, timeAgo } from './dom.js'
import { renderMarkdown } from './markdown.js'
import { dismissedListHtml, postedUrls, sevsumHtml } from './points.js'

/**
 * "What changes": the PR-wide summary as one prose block.
 * @param {string} summary
 * @param {ReadonlySet<string>} paths
 */
export function summaryHtml(summary, paths) {
  return `<div class="summary prose">${renderMarkdown(summary, { paths, diagrams: true })}</div>`
}

/**
 * @param {IssueComment} c
 * @param {Date} now
 */
export function issueCommentHtml(c, now) {
  return (
    `<div class="cmt"><span class="av" aria-hidden="true">${esc(initials(c.author))}</span>` +
    `<span class="who"><b>${esc(c.author)}</b> <span class="muted">${esc(timeAgo(c.createdAt, now))}</span> ${viewCommentHtml(c.url)}</span>` +
    `<div class="prose">${renderMarkdown(c.body)}</div></div>`
  )
}

/**
 * PR-level comments; bot comments (`[bot]` authors) collapse into one details block.
 * @param {ReadonlyArray<IssueComment>} comments
 * @param {Date} now
 */
export function conversationHtml(comments, now) {
  const humans = comments.filter(c => !c.author.endsWith('[bot]'))
  const bots = comments.filter(c => c.author.endsWith('[bot]'))
  const humanHtml =
    humans.length === 0
      ? '<p class="muted">No PR-level comments yet.</p>'
      : humans.map(c => issueCommentHtml(c, now)).join('')
  const botHtml =
    bots.length === 0
      ? ''
      : `<details class="bots">${detailsSummaryHtml(`<span class="muted small">${bots.length} bot ${bots.length === 1 ? 'comment' : 'comments'}</span>`, 'Toggle bot comments')}${bots
          .map(c => issueCommentHtml(c, now))
          .join('')}</details>`
  return (
    `<h3 class="lbl sub">Conversation · ${comments.length}</h3><div class="body conversation">${humanHtml}${botHtml}` +
    '<div class="pr-composer-host"></div>' +
    '<p><button class="cmd" type="button" data-act="pr-comment" data-needs-post>comment</button></p></div>'
  )
}

/**
 * @param {PrBundle} bundle
 * @param {{ paths: ReadonlySet<string>, now: Date }} ctx
 * @returns {string}
 */
export function renderOverview(bundle, ctx) {
  const artifact = bundle.artifact
  const active = artifact ? artifact.points.filter(p => bundle.state.dismissed[p.fingerprint] === undefined) : []
  const summary = artifact ? summaryHtml(artifact.summary, ctx.paths) : ''
  const description = bundle.pr.body.trim()
    ? `<details class="pr-desc">${detailsSummaryHtml('<span>PR description (from GitHub)</span>', 'Toggle PR description')}<div class="body prose">${renderMarkdown(bundle.pr.body, { paths: ctx.paths })}</div></details>`
    : '<div class="pr-desc body muted">No PR description.</div>'
  return (
    '<section class="panel" id="overview" aria-labelledby="ov-h">' +
    `<div class="panel-h"><h2 id="ov-h">Overview</h2>${artifact ? sevsumHtml(active, artifact.layers) : ''}</div>` +
    `<div class="body">${summary}</div>` +
    description +
    conversationHtml(bundle.comments.issueComments, ctx.now) +
    (artifact
      ? dismissedListHtml(artifact.points, bundle.state, {
          paths: ctx.paths,
          posted: postedUrls(bundle.state, bundle.comments.reviewComments),
        })
      : '') +
    '</section>'
  )
}
