// @ts-check
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
/** @typedef {import('./contract-types.js').RiskTag} RiskTag */
import { setDisabledReason } from './composer.js'
import { esc, timeAgo } from './dom.js'
import { generationMode } from './generate.js'
import { authorProfileUrl, currentHost, hostLabel } from './host.js'
import { canvasHiddenLines, getFoldLevel, refreshRail } from './layers.js'
import { pendingBarHtml, pendingCount } from './pending.js'
import { progressSummary } from './progress.js'
import { foldLevelControlHtml } from './reading-level.js'
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
 * The one generate command in the header, named for what it does on this screen. With an agent,
 * the page generates the first canvas, updates an outdated one, or writes the current one again.
 * Without one, it shows the skill command, which needs a canvas to regenerate. While a job runs,
 * `generate.js` puts the job on this button instead.
 * @param {PrBundle} bundle
 * @param {boolean} hasCanvas
 * @returns {{ label: string, title: string, disabled: boolean }}
 */
export function generateCommand(bundle, hasCanvas) {
  if (!bundle.chat.enabled) {
    const what = bundle.local !== undefined ? 'this local work' : 'this PR'
    return { label: 'regenerate', title: `Generate a new canvas for ${what}`, disabled: !hasCanvas }
  }
  const { label, title } = generationMode(bundle)
  return { label, title, disabled: false }
}

/**
 * The project's name, from its base path on the shared server: `/r/acme/widgets~fix/` names
 * `acme/widgets~fix`. Null for a page served at the root.
 * @param {string} home
 * @returns {string | null}
 */
export function projectNameOf(home) {
  const match = /^\/r\/(.+)\/$/.exec(home)
  return match?.[1] === undefined ? null : decodeURIComponent(match[1])
}

/**
 * Next to the wordmark: a link to the project's home page, named for the project, or the host the
 * page is served from when it has no project path.
 * @param {{ host: string, home?: string | undefined }} opts
 * @returns {string}
 */
function projectLinkHtml(opts) {
  const name = opts.home === undefined ? null : projectNameOf(opts.home)
  return name === null || opts.home === undefined
    ? `<span class="mono muted">${esc(opts.host)}</span>`
    : `<a class="mono muted" href="${esc(opts.home)}" title="This project's home page">${esc(name)}</a>`
}

/** The wordmark, which leads to the list of every project the server serves. */
const BRAND_HTML =
  '<a class="brand-wordmark" href="/" title="All projects"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</a>'

/** @typedef {{ host: string, home?: string | undefined, theme: import('./theme.js').Theme, skin: import('./skin.js').Skin }} BarOptions */

/**
 * The bar every page starts with, as the server draws it on its own pages too: the wordmark, the
 * project link, the page's own commands, and the skin and theme commands last.
 * @param {BarOptions} opts
 * @param {string} commands
 * @returns {string}
 */
function headerBarHtml(opts, commands) {
  return (
    `<div class="hdr-bar"><div class="brand">${BRAND_HTML}${projectLinkHtml(opts)}</div>` +
    '<div class="hdr-actions" role="group" aria-label="Page actions">' +
    commands +
    `<button class="cmd" type="button" id="skin-toggle" title="Switch between Terminal, GitHub, and Olive styling">${esc(skinLabel(opts.skin))}</button>` +
    `<button class="cmd" type="button" id="theme-toggle" title="Switch between Light, Dark, and Auto themes">${esc(themeLabel(opts.theme))}</button>` +
    '</div></div>'
  )
}

/**
 * The header of a page that could not load its review: the bar with no commands of its own, so
 * the reader can still leave for another review or project, or change the look.
 * @param {BarOptions} opts
 * @returns {string}
 */
export function bareHeaderHtml(opts) {
  return `<header class="hdr">${headerBarHtml(opts, '')}<div class="stripe" aria-hidden="true"></div></header>`
}

/**
 * @param {PrBundle} bundle
 * @param {{ host: string, theme: import('./theme.js').Theme, skin: import('./skin.js').Skin, now: Date, home?: string | undefined }} opts
 *   The wordmark links to the project list; `home`, the project's home page, gets a link of its own.
 * @returns {string}
 */
export function renderHeader(bundle, opts) {
  const { pr, artifact } = bundle
  const ready = bundle.status === 'ready' && artifact !== undefined
  // A stale canvas can be exported and regenerated too, so both commands stay live for it.
  const hasCanvas = artifact !== undefined && (bundle.status === 'ready' || bundle.status === 'stale')
  const generate = generateCommand(bundle, hasCanvas)
  const agent = ready
    ? `<span class="pill agent" title="The agent, model, and harness that generated this canvas">canvas by ${esc(artifact.generator.agent)}${artifact.generator.model ? ` · ${esc(artifact.generator.model)}` : ''} · ${esc(artifact.generator.harness)}</span><span>generated ${esc(timeAgo(artifact.generatedAt, opts.now))}</span>`
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
  const progress = ready ? progressHtml(artifact, bundle.state, pr.headSha) : ''
  const level = getFoldLevel()
  const reading = ready
    ? foldLevelControlHtml(
        level,
        canvasHiddenLines(
          {
            artifact,
            files: bundle.files,
            comments: bundle.comments.reviewComments,
            state: bundle.state,
            headSha: pr.headSha,
          },
          level
        )
      )
    : ''
  const risk = ready ? riskLineHtml(artifact.risk) : ''
  return (
    '<header class="hdr">' +
    headerBarHtml(
      opts,
      `<button class="cmd" type="button" id="regenerate" title="${esc(generate.title)}" aria-haspopup="dialog"${generate.disabled ? ' disabled' : ''}>${generate.label}</button>` +
        `<button class="cmd" type="button" id="export-zip" title="Download this canvas as a zip to share on ${esc(hostLabel())}"${hasCanvas ? '' : ' disabled'}>export zip</button>` +
        `<button class="cmd" type="button" id="refresh" title="${refreshTitle}">refresh</button>` +
        '<button class="cmd" type="button" id="settings" data-act="settings" aria-haspopup="dialog" title="Configure the default reading level, how layers show, and the AI Chat agent, model, and limits">settings</button>' +
        '<button class="cmd" type="button" data-act="help" title="Show keyboard shortcuts and review help" aria-haspopup="dialog">help</button>'
    ) +
    '<div class="stripe" aria-hidden="true"></div>' +
    '<div class="hdr-title">' +
    `<div class="title"><h1>${number}${esc(pr.title)}</h1>${forgeLink}</div>` +
    `<p class="meta"><span>by ${authorHtml(pr.author, local)}</span>` +
    `<span class="mono">${esc(pr.headRef)} &rarr; ${esc(pr.baseRef)}</span>${statePill(pr)}` +
    `<span class="diffstat"><span class="ok">+${pr.additions}</span> <span class="bad">&minus;${pr.deletions}</span></span>${agent}</p>` +
    `${largePrNoticeHtml(bundle)}${risk}${reading}${progress}</div></header>`
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
export function progressHtml(artifact, state, headSha = artifact.pr.headSha) {
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
    `<div class="pending-bar-host${pendingCount(state) > 0 ? ' has-pending' : ''}">${pendingBarHtml(
      pendingCount(state),
      state.pending.filter(draft => draft.headSha !== headSha)
    )}</div>` +
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
  refreshRail(root, artifact, state)
  return p
}
