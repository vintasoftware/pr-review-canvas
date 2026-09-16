// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').IssueComment} IssueComment */

import { commentHtml } from './diff-decorations.js'
import { viewCommentHtml } from './comment-link.js'
import { detailsSummaryHtml, esc, avatarHtml, timeAgo } from './dom.js'
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
    `<div class="cmt">${avatarHtml(c)}` +
    `<span class="who"><b>${esc(c.author)}</b> <span class="muted">${esc(timeAgo(c.createdAt, now))}</span> ${viewCommentHtml(c.url)}</span>` +
    `<div class="prose">${renderMarkdown(c.body, { github: true })}</div></div>`
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
  const reviews = bundle.comments.reviews ?? []
  const active = artifact ? artifact.points.filter(p => bundle.state.dismissed[p.fingerprint] === undefined) : []
  const summary = artifact ? summaryHtml(artifact.summary, ctx.paths) : ''
  const description = bundle.pr.body.trim()
    ? `<details class="pr-desc">${detailsSummaryHtml('<span>PR description (from GitHub)</span>', 'Toggle PR description')}<div class="body prose">${renderMarkdown(bundle.pr.body, { paths: ctx.paths, github: true })}</div></details>`
    : '<div class="pr-desc body muted">No PR description.</div>'
  return (
    '<section class="panel" id="overview" aria-labelledby="ov-h">' +
    `<div class="panel-h"><h2 id="ov-h">Overview</h2>${artifact ? sevsumHtml(active, artifact.layers) : ''}</div>` +
    `<div class="body">${summary}</div>` +
    description +
    conversationHtml(bundle.comments.issueComments, ctx.now) +
    (reviews.length ? `<details class="review-history">${detailsSummaryHtml(`<span>Review history · ${reviews.length}</span>`, 'Toggle review history')}${reviews.map(review => `<div class="body review-entry"><span class="pill">${esc(review.state.toLowerCase().replaceAll('_', ' '))}</span>${issueCommentHtml(review, ctx.now)}</div>`).join('')}</details>` : '') +
    (bundle.comments.reviewComments.length ? `<details class="body all-review-comments">${detailsSummaryHtml(`<span>All review comments · ${bundle.comments.reviewComments.length}</span>`, 'Toggle all review comments')}${bundle.comments.reviewComments.map(c => `<div><p class="muted small">${esc(c.path)}${c.line ? `:${c.line}` : ''}${c.outdated ? ' · outdated' : ''}${c.resolved ? ' · resolved' : ''}</p>${commentHtml(c, ctx.now)}</div>`).join('')}</details>` : '') +
    (artifact
      ? dismissedListHtml(artifact.points, bundle.state, {
          paths: ctx.paths,
          posted: postedUrls(bundle.state, bundle.comments.reviewComments),
        })
      : '') +
    '</section>'
  )
}
