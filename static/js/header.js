// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').RiskTag} RiskTag */
import { setDisabledReason } from './composer.js'
import { esc, timeAgo } from './dom.js'
import { authorProfileUrl, currentHost, hostLabel } from './host.js'
import { refreshRail } from './layers.js'
import { pendingBarHtml, pendingCount, refreshPendingBar } from './pending.js'
import { progressSummary } from './progress.js'
import { approveBlockedReason } from './signoff.js'
import { skinLabel } from './skin.js'
import { themeLabel } from './theme.js'

/**
 * @param {ReadonlyArray<RiskTag>} risk
 * @returns {string} the `touches:` line, or '' when nothing is tagged
 */
export function riskLineHtml(risk) {
  if (risk.length === 0) {
    return ''
  }
  const pills = risk
    .map(r => {
      const title = r.source === 'model' && r.reason ? ` title="${esc(r.reason)}"` : ''
      return `<span class="pill risk ${r.source}"${title}>${esc(r.label)}</span>`
    })
    .join('<span aria-hidden="true">·</span>')
  return `<p class="touches"><span>touches:</span>${pills}</p>`
}

/**
 * One line saying the canvas was generated under the large-change-set caps, so a reader who finds
 * a file with no annotation knows why.
 * @param {PrBundle} bundle
 */
export function largePrNoticeHtml(bundle) {
  if (!bundle.largePr) {
    return ''
  }
  return (
    '<p class="notice large-pr" role="status">Large change set: the canvas keeps at most 6 annotations per file ' +
    'and 12 attention points, and diffs were not inlined for the generator.</p>'
  )
}

/**
 * The author, linked to their page on the forge. A local review's author is the name this clone
 * commits as, which is no forge login, so it stays plain text.
 * @param {string} author
 * @param {boolean} local
 * @returns {string}
 */
function authorHtml(author, local) {
  return local
    ? esc(author)
    : `<a href="${esc(authorProfileUrl(author))}" target="_blank" rel="noopener noreferrer">${esc(author)}</a>`
}

/** @param {PrBundle['pr']} pr */
export function statePill(pr) {
  const state = pr.state === 'open' && pr.draft ? 'draft' : pr.state
  return `<span class="pill ${esc(state)}">${esc(state)}</span>`
}

/**
 * @param {PrBundle} bundle
 * @param {{ host: string, theme: import('./theme.js').Theme, skin: import('./skin.js').Skin, now: Date }} opts
 * @returns {string}
 */
export function renderHeader(bundle, opts) {
  const { pr, artifact } = bundle
  const ready = bundle.status === 'ready' && artifact !== undefined
  // A stale canvas can be exported and regenerated too, so both commands stay live for it.
  const hasCanvas = artifact !== undefined && (bundle.status === 'ready' || bundle.status === 'stale')
  const agent = ready
    ? `<span class="pill agent">${esc(artifact.generator.agent)}${artifact.generator.model ? ` · ${esc(artifact.generator.model)}` : ''} · ${esc(artifact.generator.harness)}</span><span>generated ${esc(timeAgo(artifact.generatedAt, opts.now))}</span>`
    : ''
  const number = pr.number === null ? '' : `<span class="mono num">#${pr.number}</span>`
  // Work that is not pushed has no page on the forge, and nothing to refresh from it either.
  const local = bundle.local !== undefined
  const forgeLink =
    pr.url === ''
      ? ''
      : `<a class="cmd" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">${esc(currentHost().kind)}</a>`
  const refreshTitle = local
    ? 'Snapshot the working tree again and redraw'
    : `Fetch the latest PR, comments, and shared canvas from ${esc(hostLabel())}`
  const progress = ready ? progressHtml(artifact, bundle.state) : ''
  const risk = ready ? riskLineHtml(artifact.risk) : ''
  return (
    '<header class="hdr">' +
    `<div class="hdr-bar"><div class="brand"><span class="brand-wordmark"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</span><span class="mono muted">${esc(opts.host)}</span></div>` +
    '<div class="hdr-actions" role="group" aria-label="Canvas actions">' +
    `<button class="cmd" type="button" id="regenerate" title="Generate a new canvas for ${local ? 'this local work' : 'this PR'}" aria-haspopup="dialog"${hasCanvas ? '' : ' disabled'}>regenerate</button>` +
    `<button class="cmd" type="button" id="export-zip" title="Download this canvas as a zip to share on ${esc(hostLabel())}"${hasCanvas ? '' : ' disabled'}>export zip</button>` +
    `<button class="cmd" type="button" id="refresh" title="${refreshTitle}">refresh</button>` +
    `<button class="cmd" type="button" id="settings" data-act="settings" aria-haspopup="dialog"${bundle.chat.enabled || bundle.chat.acpx ? ' title="Configure the AI chat agent, model, and limits"' : ' disabled title="acpx is not installed"'}>settings</button>` +
    '<button class="cmd" type="button" data-act="help" title="Show keyboard shortcuts and review help" aria-haspopup="dialog">help</button>' +
    `<button class="cmd" type="button" id="skin-toggle" title="Switch between Terminal and GitHub styling">${esc(skinLabel(opts.skin))}</button>` +
    `<button class="cmd" type="button" id="theme-toggle" title="Switch between Light, Dark, and Auto themes">${esc(themeLabel(opts.theme))}</button>` +
    '</div></div>' +
    '<div class="stripe" aria-hidden="true"></div>' +
    '<div class="hdr-title">' +
    `<div class="title"><h1>${number}${esc(pr.title)}</h1>${forgeLink}</div>` +
    `<p class="meta"><span>by ${authorHtml(pr.author, local)}</span>` +
    `<span class="mono">${esc(pr.headRef)} &rarr; ${esc(pr.baseRef)}</span>${statePill(pr)}` +
    `<span class="diffstat"><span class="ok">+${pr.additions}</span> <span class="bad">&minus;${pr.deletions}</span></span>${agent}</p>` +
    `${largePrNoticeHtml(bundle)}${risk}${progress}</div></header>`
  )
}

/**
 * The thin line, its text, the pending-review bar, and the three sign-off commands. Approve stays
 * disabled with the reason until every layer that is not Other has been marked reviewed; a
 * comment-only review and a request for changes are always allowed, since neither claims the
 * change set was read in full.
 * @param {import('./contract-types.js').ReviewArtifact} artifact
 * @param {import('./contract-types.js').PrState} state
 */
export function progressHtml(artifact, state) {
  const p = progressSummary(artifact, state)
  const blocked = approveBlockedReason(artifact, state)
  const approveTitle = `Write and preview an approving review on ${esc(hostLabel())}`
  const approve =
    `<button class="cmd" type="button" id="approve" data-tooltip="${approveTitle}" data-act="signoff" data-event="APPROVE" data-needs-post` +
    `${blocked === null ? ` title="${approveTitle}"` : ` disabled data-disabled-reason="${esc(blocked)}" title="${esc(blocked)}"`}>approve on ${esc(currentHost().kind)}</button>`
  const commentTitle = `Write and preview a review with no verdict on ${esc(hostLabel())}`
  return (
    `<div class="progress"><div class="pline" role="progressbar" aria-valuenow="${p.done}" aria-valuemin="0" aria-valuemax="${p.total}" aria-label="Layers reviewed"><span style="width:${p.percent}%"></span></div>` +
    `<span class="ptext">${p.done} of ${p.total} layers reviewed</span></div>` +
    `<div class="pending-bar-host${pendingCount(state) > 0 ? ' has-pending' : ''}">${pendingBarHtml(pendingCount(state))}</div>` +
    `<div class="signoff">${approve}` +
    `<button class="cmd" type="button" id="request-changes" data-tooltip="Write and preview a review requesting changes on ${esc(hostLabel())}" title="Write and preview a review requesting changes on ${esc(hostLabel())}" data-act="signoff" data-event="REQUEST_CHANGES" data-needs-post>request changes</button>` +
    `<button class="cmd" type="button" id="comment-review" data-tooltip="${commentTitle}" title="${commentTitle}" data-act="signoff" data-event="COMMENT" data-needs-post>comment</button>` +
    '<span class="capability-note" role="status"></span></div>'
  )
}

/**
 * Draws the progress line, its text, and the approve command again from the current state, and
 * with them the rail. Called after every reviewed change.
 * @param {ParentNode} root
 * @param {import('./contract-types.js').ReviewArtifact} artifact
 * @param {import('./contract-types.js').PrState} state
 */
export function refreshProgress(root, artifact, state) {
  const p = progressSummary(artifact, state)
  const line = root.querySelector('.pline')
  const fill = line?.querySelector('span')
  if (line !== null) {
    line.setAttribute('aria-valuenow', String(p.done))
    line.setAttribute('aria-valuemax', String(p.total))
  }
  if (fill instanceof HTMLElement) {
    fill.style.width = `${p.percent}%`
  }
  const text = root.querySelector('.ptext')
  if (text !== null) {
    text.textContent = `${p.done} of ${p.total} layers reviewed`
  }
  setDisabledReason(root.querySelector('#approve'), approveBlockedReason(artifact, state))
  refreshPendingBar(root, state)
  refreshRail(root, artifact, state)
  return p
}
