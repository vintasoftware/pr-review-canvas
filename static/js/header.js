// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').RiskTag} RiskTag */
import { setDisabledReason } from './composer.js'
import { esc, timeAgo } from './dom.js'
import { refreshRail } from './layers.js'
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
  const progress = ready ? progressHtml(artifact, bundle.state) : ''
  const risk = ready ? riskLineHtml(artifact.risk) : ''
  return (
    '<header class="hdr">' +
    `<div class="hdr-bar"><div class="brand"><span class="brand-wordmark"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</span><span class="mono muted">${esc(opts.host)}</span></div>` +
    '<div class="hdr-actions" role="group" aria-label="Canvas actions">' +
    `<button class="cmd" type="button" id="regenerate" title="Generate a new canvas for this PR" aria-haspopup="dialog"${hasCanvas ? '' : ' disabled'}>regenerate</button>` +
    `<button class="cmd" type="button" id="export-zip" title="Download this canvas as a zip to share on GitHub"${hasCanvas ? '' : ' disabled'}>export zip</button>` +
    '<button class="cmd" type="button" id="refresh" title="Fetch the latest PR, comments, and shared canvas from GitHub">refresh</button>' +
    `<button class="cmd" type="button" id="settings" data-act="settings" aria-haspopup="dialog"${bundle.chat.enabled || bundle.chat.acpx ? ' title="Configure the AI chat agent, model, and limits"' : ' disabled title="acpx is not installed"'}>settings</button>` +
    '<button class="cmd" type="button" data-act="help" title="Show keyboard shortcuts and review help" aria-haspopup="dialog">help</button>' +
    `<button class="cmd" type="button" id="skin-toggle" title="Switch between Terminal and GitHub styling">${esc(skinLabel(opts.skin))}</button>` +
    `<button class="cmd" type="button" id="theme-toggle" title="Switch between Light, Dark, and Auto themes">${esc(themeLabel(opts.theme))}</button>` +
    '</div></div>' +
    '<div class="stripe" aria-hidden="true"></div>' +
    '<div class="hdr-title">' +
    `<div class="title"><h1>${number}${esc(pr.title)}</h1><a class="cmd" href="${esc(pr.url)}" target="_blank" rel="noopener noreferrer">github</a></div>` +
    `<p class="meta"><span>by <a href="https://github.com/${esc(pr.author)}" target="_blank" rel="noopener noreferrer">${esc(pr.author)}</a></span>` +
    `<span class="mono">${esc(pr.headRef)} &rarr; ${esc(pr.baseRef)}</span>${statePill(pr)}` +
    `<span class="diffstat"><span class="ok">+${pr.additions}</span> <span class="bad">&minus;${pr.deletions}</span></span>${agent}</p>` +
    `${largePrNoticeHtml(bundle)}${risk}${progress}</div></header>`
  )
}

/**
 * The thin line, its text, and the two sign-off commands. Approve stays disabled with the
 * reason until every layer that is not Other has been marked reviewed.
 * @param {import('./contract-types.js').ReviewArtifact} artifact
 * @param {import('./contract-types.js').PrState} state
 */
export function progressHtml(artifact, state) {
  const p = progressSummary(artifact, state)
  const blocked = approveBlockedReason(artifact, state)
  const approve =
    `<button class="cmd" type="button" id="approve" data-tooltip="Write and preview an approving review on GitHub" data-act="signoff" data-event="APPROVE" data-needs-post` +
    `${blocked === null ? ' title="Write and preview an approving review on GitHub"' : ` disabled data-disabled-reason="${esc(blocked)}" title="${esc(blocked)}"`}>approve on github</button>`
  return (
    `<div class="progress"><div class="pline" role="progressbar" aria-valuenow="${p.done}" aria-valuemin="0" aria-valuemax="${p.total}" aria-label="Layers reviewed"><span style="width:${p.percent}%"></span></div>` +
    `<span class="ptext">${p.done} of ${p.total} layers reviewed</span></div>` +
    `<div class="signoff">${approve}` +
    '<button class="cmd" type="button" id="request-changes" data-tooltip="Write and preview a review requesting changes on GitHub" title="Write and preview a review requesting changes on GitHub" data-act="signoff" data-event="REQUEST_CHANGES" data-needs-post>request changes</button>' +
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
  refreshRail(root, artifact, state)
  return p
}
