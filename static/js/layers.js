// @ts-check
// The rail, the layer sections, and the file cards. A layer section holds the judgment text
// (rationale, decisions, check by hand), its test map, its attention point cards, and its files.
// A file card shows only the hunks of its layer; the diff is rendered lazily by <pr-file> from
// the shared render context.
/** @typedef {import('./contract-types.js').FileEntry} FileEntry */
/** @typedef {import('./contract-types.js').Layer} Layer */
/** @typedef {import('./contract-types.js').LayerFile} LayerFile */
/** @typedef {import('./contract-types.js').Point} Point */
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./contract-types.js').ReviewComment} ReviewComment */
/** @typedef {import('./threads.js').Thread} Thread */
import { askButtonHtml } from './ask.js'
import { applyCodeFolds, setCodeFoldLevel, wireFoldReveal } from './code-folds.js'
import { runCommand } from './commands.js'
import { diagramPlaceholderHtml } from './diagram.js'
import { applyDecorations } from './diff-decorations.js'
import { renderDiff } from './diff-renderer.js'
import { chevronHtml, detailsSummaryHtml, esc } from './dom.js'
import { collapsesAt, DEFAULT_FOLD_LEVEL, hiddenLines } from './fold-levels.js'
import { hunkForLine } from './hunks.js'
import { fileAnchorId, layerAnchorId, reviewedId, sanitizeKey } from './keys.js'
import { renderMarkdown } from './markdown.js'
import { pointCardHtml, postedUrls } from './points.js'
import { filesReviewed, layerProgress } from './progress.js'
import { foldCountText } from './reading-level.js'
import { anchorKey, buildThreads } from './threads.js'

/**
 * @typedef {{
 *   artifact: ReviewArtifact,
 *   files: ReadonlyArray<FileEntry>,
 *   patches: Record<string, string> | null,
 *   comments: ReadonlyArray<ReviewComment>,
 *   state: PrState,
 *   now: Date,
 * }} RenderContext
 */

/**
 * How much code the reader hides. Page state: a review opens at the level saved in the settings
 * file, light until the reader picks another, and the control or the `f` key changes it for this
 * page only, so the file holds a default rather than the last thing the reader did.
 * @type {import('./contract-types.js').FoldLevel}
 */
let foldLevel = DEFAULT_FOLD_LEVEL

export function getFoldLevel() {
  return foldLevel
}

/** @type {RenderContext | null} */
let renderContext = null

/** @param {RenderContext | null} ctx */
export function setRenderContext(ctx) {
  renderContext = ctx
}

/** @type {((card: HTMLElement) => void) | null} */
let cardRenderedHook = null

/**
 * Runs after a file card draws its diff, so whatever a card needs after it exists is applied to
 * the cards that are drawn later too.
 * @param {((card: HTMLElement) => void) | null} fn
 */
export function setCardRenderedHook(fn) {
  cardRenderedHook = fn
}

export function getRenderContext() {
  return renderContext
}

/**
 * Keeps the context in step with the local state, so a card drawn later shows the threads the
 * reader hid and the points they dismissed.
 * @param {PrState} state
 */
export function updateRenderState(state) {
  if (renderContext !== null) {
    renderContext = { ...renderContext, state }
  }
}

/** @param {ReadonlyArray<FileEntry>} files */
export function pathSet(files) {
  return new Set(files.map(f => f.path))
}

/**
 * Layer title per hunk id, so a file card can say "2 more chunks in layer 4".
 * @param {ReviewArtifact} artifact
 * @returns {Map<string, { layer: Layer, index: number }>}
 */
export function hunkLayerIndex(artifact) {
  /** @type {Map<string, { layer: Layer, index: number }>} */
  const out = new Map()
  artifact.layers.forEach((layer, index) => {
    for (const f of layer.files) {
      for (const id of f.hunks) {
        out.set(id, { layer, index })
      }
    }
  })
  return out
}

/**
 * Stripe color for a layer position (cycles through the six bands).
 * @param {number} index
 */
export function dotColor(index) {
  return `var(--s${(index % 6) + 1})`
}

/**
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {{ activeId?: string }} [opts]
 * @returns {string}
 */
export function railInnerHtml(artifact, state, opts = {}) {
  const active = opts.activeId ?? 'overview'
  const current = /** @param {string} id */ id => (id === active ? ' aria-current="location"' : '')
  const semantic = artifact.layers.filter(l => l.kind !== 'other')
  const other = artifact.layers.find(l => l.kind === 'other')
  const items = semantic
    .map((layer, i) => {
      const progress = layerProgress(layer, state)
      const dotClass = progress === 'done' ? 'dot on' : progress === 'partial' ? 'dot half' : 'dot'
      const dotLabel =
        progress === 'done' ? 'reviewed' : progress === 'partial' ? 'in progress' : 'not started'
      const reviewed = filesReviewed(layer, state)
      const files = layer.files.length
      const meta = reviewed > 0 && reviewed < files ? `${reviewed} of ${files} files` : fileCount(files)
      const risk = layer.risk.length > 0 ? ` · ${layer.risk.map(r => esc(r.label)).join(' · ')}` : ''
      const id = layerAnchorId(layer.key)
      return (
        `<li><a href="#${esc(id)}"${current(id)}><span class="${dotClass}" style="--dc:${dotColor(i)}" role="img" aria-label="${dotLabel}"></span>` +
        `<span class="n">${i + 1}</span><span class="t">${esc(layer.title)}</span><span class="m">${meta}${risk}</span></a></li>`
      )
    })
    .join('')
  const points = artifact.points.filter(p => state.dismissed[p.fingerprint] === undefined).length
  const otherItem = other
    ? `<li class="other"><a href="#${esc(layerAnchorId(other.key))}"${current(layerAnchorId(other.key))}><span class="t">${esc(other.title)}</span><span class="m">${fileCount(other.files.length)}, ignored</span></a></li>`
    : ''
  return (
    '<ul class="tree">' +
    `<li><a href="#overview"${current('overview')}><span class="t">Overview</span><span class="m">${points} attention ${points === 1 ? 'point' : 'points'}</span></a></li>` +
    `<li class="grp"><span class="lbl grp-lbl">Layers</span><ul class="layers">${items}</ul></li>${otherItem}</ul>`
  )
}

/**
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @param {{ activeId?: string }} [opts]
 * @returns {string}
 */
export function renderRail(artifact, state, opts = {}) {
  return `<nav class="rail" aria-label="Review layers">${railInnerHtml(artifact, state, opts)}</nav>`
}

/**
 * Draws the rail again from the current state, keeping the item the scrollspy marked.
 * @param {ParentNode} root
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 */
export function refreshRail(root, artifact, state) {
  const rail = root.querySelector('nav.rail')
  if (!(rail instanceof HTMLElement)) {
    return false
  }
  const active = rail.querySelector('a[aria-current]')?.getAttribute('href')?.slice(1)
  rail.innerHTML = railInnerHtml(artifact, state, active === undefined ? {} : { activeId: active })
  return true
}

/**
 * "1 file" / "3 files".
 * @param {number} n
 */
export function fileCount(n) {
  return `${n} ${n === 1 ? 'file' : 'files'}`
}

/**
 * @param {Layer} layer
 * @param {ReadonlySet<string>} paths
 */
export function testMapHtml(layer, paths) {
  if (layer.tests.length === 0) {
    return ''
  }
  const rows = layer.tests
    .map(t => {
      const where = t.testPath ? `<a class="loc" href="#file:${esc(t.testPath)}">${esc(t.testPath)}</a>` : ''
      const note = t.note ? `<div class="muted small">${renderMarkdown(t.note, { paths })}</div>` : ''
      return `<tr><td>${esc(t.behavior)}${note}</td><td class="st ${t.status}">${esc(t.status)}</td><td>${where}</td></tr>`
    })
    .join('')
  return `<h3 class="lbl sub">Tests</h3><table class="testmap"><thead><tr><th scope="col">Behavior</th><th scope="col">Status</th><th scope="col">Test</th></tr></thead><tbody>${rows}</tbody></table>`
}

/**
 * The layer's diagram, as a placeholder `diagram.js` draws once the page has mermaid.
 * @param {Layer} layer
 */
export function layerDiagramHtml(layer) {
  return layer.diagram === undefined ? '' : diagramPlaceholderHtml(layer.diagram.mermaid, layer.diagram.links)
}

/**
 * "Decisions and trade-offs" and "Check by hand" as labelled prose; each is omitted when absent.
 * @param {Layer} layer
 * @param {ReadonlySet<string>} paths
 */
export function judgmentHtml(layer, paths) {
  const block = /** @param {string} cls @param {string} label @param {string | undefined} text */ (
    cls,
    label,
    text
  ) =>
    text === undefined
      ? ''
      : `<div class="judgment ${cls}"><h3 class="lbl">${label}</h3><div class="prose">${renderMarkdown(text, { paths })}</div></div>`
  return (
    block('decisions', 'Decisions and trade-offs', layer.decisions) +
    block('check-by-hand', 'Check by hand', layer.checkByHand)
  )
}

/**
 * The attention point cards of one layer, in artifact order.
 * @param {Layer} layer
 * @param {ReadonlyArray<Point>} points
 * @param {ReadonlySet<string>} paths
 * @param {PrState} state
 * @param {ReadonlyMap<string, string>} [posted] point fingerprint → the url it was posted as
 */
export function layerPointsHtml(layer, points, paths, state, posted) {
  const own = points.filter(p => p.layerId === layer.id)
  if (own.length === 0) {
    return ''
  }
  const active = own.filter(p => state.dismissed[p.fingerprint] === undefined).length
  const cards = own.map(p =>
    pointCardHtml(p, posted === undefined ? { paths, state } : { paths, state, posted })
  )
  return `<h3 class="lbl sub">Attention points · <span class="point-count">${active}</span></h3><ol class="findings">${cards.join('')}</ol>`
}

/**
 * Whether a card stays open whatever its `collapsed` level says: a discussion or an attention
 * point on the file is what the reviewer came to see.
 * @param {LayerFile} lf
 * @param {string} layerId
 * @param {ReviewArtifact} artifact
 * @param {ReadonlySet<string> | undefined} commentPaths paths with a review comment
 * @returns {boolean}
 */
export function cardKeepsOpen(lf, layerId, artifact, commentPaths) {
  return (
    commentPaths?.has(lf.path) === true ||
    artifact.points.some(p => p.path === lf.path && p.layerId === layerId)
  )
}

/**
 * @typedef {{
 *   artifact: ReviewArtifact,
 *   files: ReadonlyArray<FileEntry>,
 *   comments: ReadonlyArray<ReviewComment>,
 * }} CountContext
 * @typedef {import('./reading-level.js').HiddenCounts} HiddenCounts
 */

/**
 * What the discussion keeps open in one card: a comment or an attention point stops it
 * collapsing, and a thread in its chunks stops every fold. The card's folds and its counter both
 * read this one answer, from the comments on the page now, so they cannot disagree.
 * @param {LayerFile} lf
 * @param {string} layerId
 * @param {CountContext} ctx
 * @param {ReadonlySet<string>} commentPaths paths with a review comment
 * @returns {import('./fold-levels.js').Discussion}
 */
function cardDiscussion(lf, layerId, ctx, commentPaths) {
  const entry = ctx.files.find(f => f.path === lf.path)
  return {
    keepsOpen: cardKeepsOpen(lf, layerId, ctx.artifact, commentPaths),
    threaded: entry !== undefined && threadsForHunks(ctx.comments, entry, new Set(lf.hunks)).length > 0,
  }
}

/** @param {CountContext} ctx */
function commentPathsOf(ctx) {
  return new Set(ctx.comments.map(comment => comment.path))
}

/**
 * How many diff lines a level hides in one layer, against what the layer shows in all. Counted
 * from the model, so a card that has not drawn its diff yet still counts, and with the card's own
 * discussion rule.
 * @param {Layer} layer
 * @param {CountContext} ctx
 * @param {import('./contract-types.js').FoldLevel} level
 * @returns {HiddenCounts}
 */
export function layerHiddenLines(layer, ctx, level) {
  const commentPaths = commentPathsOf(ctx)
  let total = 0
  let hidden = 0
  for (const lf of layer.files) {
    const entry = ctx.files.find(f => f.path === lf.path)
    const counts = hiddenLines(lf, entry?.hunks ?? [], level, cardDiscussion(lf, layer.id, ctx, commentPaths))
    total += counts.total
    hidden += counts.hidden
  }
  return { total, hidden }
}

/**
 * The same over every layer, for the hint under the control and the sign-off note.
 * @param {CountContext} ctx
 * @param {import('./contract-types.js').FoldLevel} level
 * @returns {HiddenCounts}
 */
export function canvasHiddenLines(ctx, level) {
  return ctx.artifact.layers.reduce(
    (sum, layer) => {
      const counts = layerHiddenLines(layer, ctx, level)
      return { total: sum.total + counts.total, hidden: sum.hidden + counts.hidden }
    },
    { total: 0, hidden: 0 }
  )
}

/**
 * The card a command belongs to, and the part of it that collapses.
 * @param {Element} el
 * @returns {{ card: HTMLElement, body: HTMLElement, chevron: Element | null } | null}
 */
export function cardOf(el) {
  const card = el.closest('article.file, section.layer')
  const body = card?.querySelector(':scope > .file-body, :scope > .layer-body')
  if (!(card instanceof HTMLElement && body instanceof HTMLElement)) {
    return null
  }
  return { card, body, chevron: card.querySelector(':scope > .file-h > .chev, :scope > .layer-h > .chev') }
}

/**
 * Opens or collapses one card. Nothing else on the card changes, so clicking the chevron never
 * touches the reviewed box and the other way round.
 * @param {Element} el an element inside the card
 * @param {boolean} [collapsed] the state to set; the opposite of the current one when omitted
 */
export function setCardCollapsed(el, collapsed) {
  const parts = cardOf(el)
  if (parts === null) {
    return null
  }
  const next = collapsed ?? !parts.body.hidden
  parts.body.toggleAttribute('hidden', next)
  parts.chevron?.setAttribute('aria-expanded', next ? 'false' : 'true')
  return next
}

/**
 * @param {LayerFile} lf
 * @param {FileEntry | undefined} entry
 * @param {Layer} layer
 * @param {{ hunkIndex: Map<string, { layer: Layer, index: number }>, paths: ReadonlySet<string>, firstCardFor: Set<string>, state?: PrState, keepOpen?: boolean }} ctx
 * @returns {string}
 */
export function renderFileCard(lf, entry, layer, ctx) {
  const key = entry?.key ?? sanitizeKey(lf.path)
  const cardReviewedId = reviewedId(layer.key, lf.path)
  const cardReviewed = ctx.state?.reviewed[cardReviewedId] === true
  const collapsed = cardReviewed || (collapsesAt(lf, foldLevel) && ctx.keepOpen !== true)
  const isFirst = !ctx.firstCardFor.has(key)
  ctx.firstCardFor.add(key)
  const id = isFirst ? fileAnchorId(key) : `${fileAnchorId(key)}-${layer.key}`
  const pills = entry
    ? `<span class="pill add">+${entry.additions}</span><span class="pill del">&minus;${entry.deletions}</span>`
    : ''
  const status =
    entry && entry.status !== 'modified' ? `<span class="status">${esc(entry.status)}</span>` : ''
  const path =
    entry?.oldPath !== undefined
      ? `<span class="old">${esc(entry.oldPath)} &rarr; </span>${esc(lf.path)}`
      : esc(lf.path)
  const testTag = lf.isTest ? ' <span class="pill test-tag">test</span>' : ''
  const note = lf.note
    ? `<div class="note"><span class="lbl">Reviewer note</span><div class="prose">${renderMarkdown(lf.note, { paths: ctx.paths })}</div></div>`
    : ''
  const elsewhere = elsewhereHtml(lf, entry, layer, ctx.hunkIndex)
  return (
    `<pr-file><article class="file${lf.isTest ? ' test' : ''}${cardReviewed ? ' is-reviewed' : ''}" id="${esc(id)}" data-key="${esc(key)}" data-path="${esc(lf.path)}" data-layer="${esc(layer.id)}" aria-labelledby="${esc(id)}-h">` +
    `<div class="file-h">${chevronHtml('Collapse file', !collapsed, { act: 'toggle-card' })}<h3 id="${esc(id)}-h" class="path">${path}${testTag}</h3>${status}${pills}` +
    `<label class="chk"><input type="checkbox" data-reviewed-id="${esc(cardReviewedId)}"${cardReviewed ? ' checked' : ''}> reviewed</label>` +
    `<span class="tbtns">${askButtonHtml({ kind: 'file', path: lf.path })}</span></div>` +
    `<div class="file-body"${collapsed ? ' hidden' : ''}>${note}<div class="diff-host" data-key="${esc(key)}" data-hunks="${esc(lf.hunks.join(','))}"><div class="loading">Loading diff…</div></div>${elsewhere}</div></article></pr-file>`
  )
}

/**
 * "2 more chunks in layer 4 · title" when a file's other hunks live in other layers.
 * @param {LayerFile} lf
 * @param {FileEntry | undefined} entry
 * @param {Layer} layer
 * @param {Map<string, { layer: Layer, index: number }>} hunkIndex
 */
export function elsewhereHtml(lf, entry, layer, hunkIndex) {
  if (!entry) {
    return ''
  }
  /** @type {Map<string, { n: number, layer: Layer, index: number }>} */
  const others = new Map()
  for (const h of entry.hunks) {
    if (lf.hunks.includes(h.id)) {
      continue
    }
    const where = hunkIndex.get(h.id)
    if (!where || where.layer.id === layer.id) {
      continue
    }
    const cur = others.get(where.layer.id) ?? { n: 0, layer: where.layer, index: where.index }
    cur.n++
    others.set(where.layer.id, cur)
  }
  if (others.size === 0) {
    return ''
  }
  const parts = [...others.values()].map(
    o =>
      `${o.n} more ${o.n === 1 ? 'chunk' : 'chunks'} in <a href="#${esc(layerAnchorId(o.layer.key))}">${o.layer.kind === 'other' ? esc(o.layer.title) : `layer ${o.index + 1} · ${esc(o.layer.title)}`}</a>`
  )
  return `<div class="more-hunks">${parts.join(' · ')}</div>`
}

/**
 * @param {Layer} layer
 * @param {number} index 0-based position among all layers
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<FileEntry>} files
 * @param {PrState} state
 * @param {{ hunkIndex: Map<string, { layer: Layer, index: number }>, paths: ReadonlySet<string>, firstCardFor: Set<string>, state?: PrState, posted?: ReadonlyMap<string, string>, comments: ReadonlyArray<ReviewComment> }} ctx
 * @returns {string}
 */
export function renderLayerSection(layer, index, artifact, files, state, ctx) {
  const byPath = new Map(files.map(f => [f.path, f]))
  const commentPaths = new Set(ctx.comments.map(comment => comment.path))
  const cards = layer.files
    .map(lf =>
      renderFileCard(lf, byPath.get(lf.path), layer, {
        ...ctx,
        keepOpen: cardKeepsOpen(lf, layer.id, artifact, commentPaths),
      })
    )
    .join('')
  const id = layerAnchorId(layer.key)
  if (layer.kind === 'other') {
    return (
      `<pr-layer><section class="panel" id="${esc(id)}" aria-labelledby="${esc(id)}-h"><details>${detailsSummaryHtml(`<h2 id="${esc(id)}-h">${esc(layer.title)} <span class="muted">&mdash; ${fileCount(layer.files.length)}, ignored</span></h2>`, 'Toggle other changes')}` +
      `<div class="body"><div class="rationale prose">${renderMarkdown(layer.rationale, { paths: ctx.paths, diagrams: true })}</div>${layerDiagramHtml(layer)}</div>${cards}</details></section></pr-layer>`
    )
  }
  const semanticIndex = artifact.layers.filter(l => l.kind !== 'other').findIndex(l => l.id === layer.id)
  const total = artifact.layers.filter(l => l.kind !== 'other').length
  const risks =
    layer.risk.length > 0
      ? `<span class="risks">${layer.risk
          .map(
            r =>
              `<span class="pill risk ${r.source}"${r.reason ? ` title="${esc(r.reason)}"` : ''}>${esc(r.label)}</span>`
          )
          .join('')}</span>`
      : ''
  const reviewed = layerProgress(layer, state) === 'done'
  const layerReviewedId = reviewedId(layer.key)
  return (
    `<pr-layer><section class="layer${reviewed ? ' is-reviewed' : ''}" id="${esc(id)}" data-layer="${esc(layer.id)}" aria-labelledby="${esc(id)}-h" style="--dc:${dotColor(index)}">` +
    `<div class="panel-h layer-h">${chevronHtml('Collapse layer', !reviewed, { act: 'toggle-card' })}<h2 id="${esc(id)}-h"><span class="lbl">Layer ${semanticIndex + 1} of ${total}</span>${esc(layer.title)}${risks}</h2>` +
    `<div class="layer-ctl"><label class="chk"><input type="checkbox" data-reviewed-id="${esc(layerReviewedId)}"${reviewed ? ' checked' : ''}> reviewed</label>` +
    `${askButtonHtml({ kind: 'layer', layerId: layer.id }, { label: 'ask about this layer' })}</div></div>` +
    `<div class="layer-body"${reviewed ? ' hidden' : ''}>` +
    `<div class="body"><div class="rationale prose">${renderMarkdown(layer.rationale, { paths: ctx.paths, diagrams: true })}</div>${layerDiagramHtml(layer)}${judgmentHtml(layer, ctx.paths)}</div>` +
    testMapHtml(layer, ctx.paths) +
    layerPointsHtml(layer, artifact.points, ctx.paths, state, ctx.posted) +
    `<h3 class="lbl sub">Files · ${layer.files.length}<span class="fold-count" data-layer="${esc(layer.id)}">${esc(foldCountText(layerHiddenLines(layer, { artifact, files, comments: ctx.comments }, foldLevel)))}</span></h3><div class="files">${cards}</div>` +
    `<div class="layer-end"><button class="cmd" type="button" data-act="mark-layer" data-reviewed-id="${esc(layerReviewedId)}">mark layer as reviewed</button></div>` +
    '</div></section></pr-layer>'
  )
}

/**
 * Every layer section in order.
 * @param {ReviewArtifact} artifact
 * @param {ReadonlyArray<FileEntry>} files
 * @param {PrState} state
 * @param {ReadonlyArray<ReviewComment>} [comments] so a point that was posted says so
 */
export function renderLayers(artifact, files, state, comments = []) {
  const ctx = {
    hunkIndex: hunkLayerIndex(artifact),
    paths: pathSet(files),
    firstCardFor: new Set(),
    state,
    posted: postedUrls(state, comments),
    comments,
  }
  return artifact.layers.map((layer, i) => renderLayerSection(layer, i, artifact, files, state, ctx)).join('')
}

/** Above this many patch lines a file card waits for a click before it draws its diff. */
export const DEFERRED_DIFF_LINES = 2000

/**
 * @param {string} patch
 * @returns {number}
 */
export function patchLineCount(patch) {
  return patch === '' ? 0 : patch.split('\n').length
}

/**
 * Renders the diff of one card from the render context and applies its decorations. A patch of
 * more than DEFERRED_DIFF_LINES lines draws a `[ show diff ]` command instead, so one huge file
 * does not stall the page; `force` draws it anyway.
 * @param {HTMLElement} card the <article class="file">
 * @param {RenderContext} ctx
 * @param {{ force?: boolean }} [opts]
 * @returns {{ rendered: boolean, deferred: boolean, placed: number, missed: number }}
 */
export function hydrateFileCard(card, ctx, opts = {}) {
  const host = card.querySelector('.diff-host')
  const key = card.getAttribute('data-key')
  const layerId = card.getAttribute('data-layer')
  if (!(host instanceof HTMLElement) || key === null || layerId === null) {
    return { rendered: false, deferred: false, placed: 0, missed: 0 }
  }
  const entry = ctx.files.find(f => f.key === key)
  const patch = ctx.patches?.[key]
  if (!entry || patch === undefined) {
    host.innerHTML =
      '<div class="unavailable">Diff not available locally. Fetch the PR head and reload.</div>'
    return { rendered: false, deferred: false, placed: 0, missed: 0 }
  }
  const lines = patchLineCount(patch)
  if (opts.force !== true && lines > DEFERRED_DIFF_LINES) {
    const panel = document.createElement('div')
    panel.className = 'deferred'
    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = `${lines} diff lines, above the ${DEFERRED_DIFF_LINES}-line limit for drawing a file on sight.`
    const show = document.createElement('button')
    show.className = 'cmd fill'
    show.type = 'button'
    show.setAttribute('data-act', 'show-diff')
    show.textContent = 'show diff'
    show.addEventListener('click', () => {
      void runCommand(
        show,
        async () => {
          hydrateFileCard(card, ctx, { force: true })
          // The host element now holds a drawn diff, so a later link into it leaves it alone.
          const fileHost = card.closest('pr-file')
          if (fileHost instanceof PrFileElement) {
            fileHost.rendered = true
            fileHost.deferred = false
          }
        },
        { pendingLabel: 'drawing…' }
      )
    })
    panel.append(hint, show)
    host.replaceChildren(panel)
    return { rendered: false, deferred: true, placed: 0, missed: 0 }
  }
  const hunkIds = new Set((host.getAttribute('data-hunks') ?? '').split(',').filter(Boolean))
  host.innerHTML = renderDiff({ key: entry.key, path: entry.path, lang: entry.lang }, patch, { hunkIds })
  const layer = ctx.artifact.layers.find(l => l.id === layerId)
  const lf = layer?.files.find(f => f.path === entry.path)
  const annotations = lf?.annotations ?? []
  const points = ctx.artifact.points.filter(
    p => p.path === entry.path && hunkIds.has(hunkIdForPoint(p, entry))
  )
  const threads = threadsForHunks(ctx.comments, entry, hunkIds)
  const { placed, missed } = applyDecorations(card, key, {
    annotations,
    points,
    threads,
    paths: pathSet(ctx.files),
    now: ctx.now,
    state: ctx.state,
    posted: postedUrls(ctx.state, ctx.comments),
    hiddenThreads: new Set(Object.keys(ctx.state.hiddenThreads).map(Number)),
  })
  const threaded = lf !== undefined && cardDiscussion(lf, layerId, ctx, commentPathsOf(ctx)).threaded
  applyCodeFolds(card, key, lf?.folds ?? [], foldLevel, threaded)
  wireFoldReveal(card)
  cardRenderedHook?.(card)
  return { rendered: true, deferred: false, placed, missed }
}

/**
 * The hunk id that contains a point's line on its side, or '' when outside every hunk.
 * @param {Point} p
 * @param {FileEntry} entry
 */
export function hunkIdForPoint(p, entry) {
  return hunkForLine(entry.hunks, p.side ?? 'new', p.line)?.id ?? ''
}

/**
 * Threads anchored on lines of the given hunks.
 * @param {ReadonlyArray<ReviewComment>} comments
 * @param {FileEntry} entry
 * @param {ReadonlySet<string>} hunkIds
 * @returns {Thread[]}
 */
export function threadsForHunks(comments, entry, hunkIds) {
  const { byAnchor } = buildThreads(comments.filter(c => c.path === entry.path))
  /** @type {Thread[]} */
  const out = []
  for (const h of entry.hunks) {
    if (!hunkIds.has(h.id)) {
      continue
    }
    for (const side of /** @type {const} */ (['new', 'old'])) {
      const start = side === 'new' ? h.newStart : h.oldStart
      const count = side === 'new' ? h.newLines : h.oldLines
      for (let line = start; line <= start + Math.max(count, 1) - 1; line++) {
        out.push(...(byAnchor.get(anchorKey(entry.path, side, line)) ?? []))
      }
    }
  }
  return out
}

/**
 * Light-DOM element: renders its diff once, when it first becomes visible (at once without
 * IntersectionObserver). The render context must be set before the element connects.
 */
export class PrFileElement extends HTMLElement {
  rendered = false
  /** The card shows the `[ show diff ]` command because its patch is over the line limit. */
  deferred = false
  /** @type {IntersectionObserver | null} */
  observer = null

  /**
   * Draws the diff now instead of waiting to be seen. A link into a card the reader has not
   * scrolled to calls this with `force`, so the row it points at exists before the jump even
   * when the card is holding a huge patch back.
   * @param {boolean} [force]
   * @returns {boolean} true when this call drew it
   */
  renderNow(force = false) {
    const card = this.querySelector('article.file')
    const ctx = getRenderContext()
    if (!(card instanceof HTMLElement) || ctx === null) {
      return false
    }
    const redraws = force && this.deferred
    if (this.rendered && redraws === false) {
      return false
    }
    this.stopObserving()
    const result = hydrateFileCard(card, ctx, force ? { force: true } : {})
    this.rendered = true
    this.deferred = result.deferred
    return true
  }

  connectedCallback() {
    if (this.rendered || !(this.querySelector('article.file') instanceof HTMLElement)) {
      return
    }
    if (typeof IntersectionObserver === 'undefined') {
      this.renderNow()
      return
    }
    // Moving the element re-runs this callback; the watcher of the previous run is dropped first.
    this.stopObserving()
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        this.stopObserving()
        this.renderNow()
      }
    })
    this.observer = io
    io.observe(this)
  }

  disconnectedCallback() {
    this.stopObserving()
  }

  stopObserving() {
    this.observer?.disconnect()
    this.observer = null
  }
}

export class PrLayerElement extends HTMLElement {}

/** Registers the custom elements once. */
export function defineLayerElements() {
  if (!customElements.get('pr-file')) {
    customElements.define('pr-file', PrFileElement)
  }
  if (!customElements.get('pr-layer')) {
    customElements.define('pr-layer', PrLayerElement)
  }
}

/**
 * Hydrates every card under root now. Tests use it to render a whole page in one call.
 * @param {ParentNode} root
 * @param {RenderContext} ctx
 */
export function hydrateAll(root, ctx) {
  let rendered = 0
  for (const card of Array.from(root.querySelectorAll('article.file'))) {
    if (card instanceof HTMLElement && hydrateFileCard(card, ctx).rendered) {
      rendered++
    }
  }
  return rendered
}

/**
 * The layer file a card was rendered from, or undefined when the artifact no longer has it.
 * @param {HTMLElement} card
 * @param {ReviewArtifact} artifact
 * @returns {LayerFile | undefined}
 */
function layerFileOf(card, artifact) {
  const layerId = card.getAttribute('data-layer')
  const path = card.getAttribute('data-path')
  return artifact.layers.find(l => l.id === layerId)?.files.find(f => f.path === path)
}

/**
 * Switches how much code the page hides. A card the reader opened or closed by hand follows the
 * new level too: changing the level is a request to change exactly that. The folds and counters
 * then follow as refreshFolds says.
 * @param {ParentNode} root
 * @param {import('./contract-types.js').FoldLevel} level
 */
export function setFoldLevel(root, level) {
  foldLevel = level
  const ctx = renderContext
  if (ctx === null) {
    return
  }

  const commentPaths = commentPathsOf(ctx)
  for (const card of Array.from(root.querySelectorAll('article.file'))) {
    const lf = card instanceof HTMLElement ? layerFileOf(card, ctx.artifact) : undefined
    if (card instanceof HTMLElement && lf !== undefined) {
      setCardCollapsed(
        card,
        card.classList.contains('is-reviewed') ||
          (collapsesAt(lf, level) &&
            !cardKeepsOpen(lf, card.getAttribute('data-layer') ?? '', ctx.artifact, commentPaths))
      )
    }
  }
  refreshFolds(root)
}

/**
 * Points every drawn card's folds, and every layer's counter, at the level and at the comments
 * on the page now. Each card switches which of its wired folds are active without rebuilding its
 * diff, so an open composer or a thread keeps its place; a card with a thread folds nothing. A
 * card waiting to be drawn picks both up when it draws. Called when the level changes and when a
 * comment is posted, and leaves alone which cards the reader opened.
 * @param {ParentNode} root
 */
export function refreshFolds(root) {
  const ctx = renderContext
  if (ctx === null) {
    return
  }

  for (const counter of Array.from(root.querySelectorAll('.fold-count'))) {
    const layer = ctx.artifact.layers.find(l => l.id === counter.getAttribute('data-layer'))
    if (layer !== undefined) {
      counter.textContent = foldCountText(layerHiddenLines(layer, ctx, foldLevel))
    }
  }

  const commentPaths = commentPathsOf(ctx)
  for (const card of Array.from(root.querySelectorAll('article.file'))) {
    const lf = card instanceof HTMLElement ? layerFileOf(card, ctx.artifact) : undefined
    if (card instanceof HTMLElement) {
      const layerId = card.getAttribute('data-layer') ?? ''
      const threaded = lf !== undefined && cardDiscussion(lf, layerId, ctx, commentPaths).threaded
      setCodeFoldLevel(card, foldLevel, threaded)
    }
  }
}
