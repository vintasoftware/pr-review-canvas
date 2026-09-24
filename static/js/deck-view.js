// @ts-check
// HTML for the self-review deck: a card, the stack behind it, the progress pips, the code drawer,
// the finish screen, and the help dialog. Every value from the deck goes through esc() or the
// sanitizing markdown renderer.
import hljs from 'hljs'
import { esc } from './dom.js'
import { langForPath } from './lang.js'
import { renderMarkdown } from './markdown.js'
import { DECK_KEY_HELP, pickNeedsFix, RECORD_LABELS, RECORD_ORDER } from './deck-state.js'

/** @typedef {import('./deck-state.js').DecisionCard} DecisionCard */
/** @typedef {import('./deck-state.js').Pick} Pick */
/** @typedef {import('./deck-state.js').CardSide} CardSide */
/**
 * @typedef {{ path: string, header: string, lines: string[], oldStart: number, newStart: number,
 *   lang?: string }} CardExcerpt
 */
/** @typedef {{ fixes: number, records: number, comments: number, skipped: number, open: number }} Summary */

const BUCKET_LABELS = /** @type {Record<string, string>} */ ({
  'trade-off': 'Trade-off',
  intent: 'Intent',
  shape: 'Shape',
  risk: 'Risk',
})

/**
 * Highlighted code, or escaped code when the language is unknown.
 * @param {string} code
 * @param {string | undefined} lang
 */
export function highlight(code, lang) {
  if (lang !== undefined && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  }
  return esc(code)
}

/** @param {string} text */
function inline(text) {
  return renderMarkdown(text)
}

/**
 * @param {DecisionCard} card
 * @param {CardSide} side
 */
function sideHtml(card, side) {
  const content = card[side]
  const letter = side.toUpperCase()
  const key = side
  const now = card.current === side ? '<span class="deck-now">in code now</span>' : ''
  const lang = content.snippet?.lang ?? langForPath(card.path)
  const snippet =
    content.snippet === undefined
      ? ''
      : `<pre class="deck-snippet deck-code"><code>${highlight(content.snippet.code.replace(/\n$/, ''), lang)}</code></pre>`
  const options = RECORD_ORDER.map(
    target =>
      `<option value="${target}"${target === content.record ? ' selected' : ''}>${esc(RECORD_LABELS[target])}</option>`
  ).join('')
  return `<section class="deck-side deck-side-${side}" data-side="${side}" aria-label="Side ${letter}: ${esc(content.label)}">
<header class="deck-side-h"><span class="deck-letter" aria-hidden="true">${letter}</span><h3>${esc(content.label)}</h3>${now}</header>
<div class="deck-consequence">${inline(content.consequence)}</div>
${snippet}
<div class="deck-why">
<p class="deck-why-text"><span class="deck-why-label">why</span> <span data-why-text>${esc(content.why)}</span></p>
<label class="deck-edit"><span class="sr-only">Justification for side ${letter}</span><textarea data-why="${side}" rows="2" maxlength="560">${esc(content.why)}</textarea></label>
<p class="deck-record"><span class="deck-record-chip" data-record-chip="${side}" data-record="${content.record}">${esc(RECORD_LABELS[content.record])}</span>
<label class="deck-edit"><span class="sr-only">Record side ${letter}'s justification</span><select data-record-select="${side}">${options}</select></label></p>
</div>
<button class="deck-pick cmd" type="button" data-pick="${side}"><kbd>${key}</kbd> pick ${letter}</button>
</section>`
}

/**
 * One decision card. `data-card` carries its key; the drag and the keys act on the top one.
 * @param {DecisionCard} card
 * @param {{ index: number, total: number }} position
 */
export function cardHtml(card, position) {
  const bucket = BUCKET_LABELS[card.bucket] ?? card.bucket
  const where = `${card.path}:${card.line}${card.side === 'old' ? ' (old)' : ''}`
  return `<article class="deck-card" data-card="${esc(card.key)}" data-bucket="${esc(card.bucket)}" tabindex="-1" aria-labelledby="deck-title-${esc(card.key)}">
<div class="deck-stamp deck-stamp-a" aria-hidden="true">A</div>
<div class="deck-stamp deck-stamp-b" aria-hidden="true">B</div>
<header class="deck-card-h">
<p class="deck-kicker"><span class="deck-bucket">${esc(bucket)}</span><span class="deck-topic">${esc(card.topic)}</span><span class="deck-count mono">${position.index + 1} / ${position.total}</span></p>
<h2 id="deck-title-${esc(card.key)}">${esc(card.title)}</h2>
<div class="deck-context">${inline(card.context)}</div>
</header>
<div class="deck-sides">${sideHtml(card, 'a')}<div class="deck-or" aria-hidden="true">or</div>${sideHtml(card, 'b')}</div>
<footer class="deck-card-f">
<button class="deck-anchor mono" type="button" data-act="drawer" aria-expanded="false"><kbd>o</kbd> ${esc(where)}</button>
<span class="deck-card-more"><button class="cmd" type="button" data-act="neither"><kbd>n</kbd> neither</button><button class="cmd" type="button" data-act="skip"><kbd>s</kbd> skip</button></span>
</footer>
<form class="deck-note" data-note hidden>
<label for="deck-note-${esc(card.key)}">Neither side fits. What do you want instead?</label>
<textarea id="deck-note-${esc(card.key)}" name="note" rows="2" maxlength="960" required></textarea>
<div class="deck-note-actions"><button class="cmd fill" type="submit">send to the fix list</button><button class="cmd" type="button" data-act="escape">cancel</button><span class="muted">Enter sends · Shift+Enter breaks the line</span></div>
</form>
</article>`
}

/**
 * The cards peeking behind the top one. Only their titles show; they are decoration.
 * @param {readonly DecisionCard[]} cards
 */
export function stackHtml(cards) {
  return cards
    .map(
      (card, i) =>
        `<div class="deck-ghost deck-ghost-${i + 1}" aria-hidden="true"><span>${esc(card.title)}</span></div>`
    )
    .reverse()
    .join('')
}

/**
 * One pip per card: answered ones say how, the top one is ringed.
 * @param {readonly DecisionCard[]} cards
 * @param {Readonly<Record<string, Pick>>} picks
 * @param {string | null} topKey
 */
export function pipsHtml(cards, picks, topKey) {
  const pips = cards.map(card => {
    const pick = picks[card.key]
    const state = pick === undefined ? 'open' : pick.choice
    const fix = pick !== undefined && pickNeedsFix(card, pick) ? ' data-fix' : ''
    const current = card.key === topKey ? ' aria-current="step"' : ''
    const label = pick === undefined ? 'open' : pick.choice === 'skip' ? 'skipped' : `picked ${pick.choice}`
    return `<li class="deck-pip" data-state="${state}"${fix}${current} title="${esc(`${card.title}: ${label}`)}"></li>`
  })
  return `<ol class="deck-pips" aria-label="Progress">${pips.join('')}</ol>`
}

/**
 * The code a card is anchored to, as its chunk of the diff.
 * @param {DecisionCard} card
 * @param {CardExcerpt | undefined} excerpt
 */
export function drawerHtml(card, excerpt) {
  if (excerpt === undefined) {
    return `<div class="deck-drawer-body"><p class="muted">The chunk for <code>${esc(card.path)}:${card.line}</code> is not in this clone's diff anymore.</p></div>`
  }
  const lang = excerpt.lang ?? langForPath(excerpt.path)
  let oldLine = excerpt.oldStart
  let newLine = excerpt.newStart
  const anchorSide = card.side ?? 'new'
  const rows = excerpt.lines.map(line => {
    const mark = line[0] ?? ' '
    const code = line.slice(1)
    const kind = mark === '+' ? 'add' : mark === '-' ? 'del' : 'ctx'
    const o = kind === 'add' ? '' : String(oldLine++)
    const n = kind === 'del' ? '' : String(newLine++)
    const here =
      (anchorSide === 'new' && n === String(card.line)) || (anchorSide === 'old' && o === String(card.line))
    return `<tr class="deck-diff-${kind}${here ? ' deck-diff-here' : ''}"><td class="ln">${o}</td><td class="ln">${n}</td><td class="mk">${esc(mark)}</td><td class="deck-diff-src"><code>${highlight(code, lang) || ' '}</code></td></tr>`
  })
  return `<div class="deck-drawer-body"><p class="deck-drawer-h mono">${esc(excerpt.path)} <span class="muted">${esc(excerpt.header)}</span></p>
<div class="deck-drawer-scroll"><table class="deck-diff deck-code"><tbody>${rows.join('')}</tbody></table></div></div>`
}

/**
 * @param {DecisionCard} card
 * @param {Pick} pick
 */
function pickLine(card, pick) {
  const picked =
    pick.choice === 'skip'
      ? 'skipped, left for reviewers'
      : pick.choice === 'neither'
        ? `neither: ${pick.note ?? ''}`
        : `${pick.choice.toUpperCase()}, ${card[pick.choice].label}`
  const fix = pickNeedsFix(card, pick)
    ? '<span class="deck-tag deck-tag-fix">fix</span>'
    : '<span class="deck-tag">kept</span>'
  const tag = pick.choice === 'skip' ? '<span class="deck-tag deck-tag-skip">open</span>' : fix
  return `<li>${tag} <strong>${esc(card.title)}</strong> <span class="muted">${esc(picked)}</span> <button class="cmd" type="button" data-reopen="${esc(card.key)}">change</button></li>`
}

/**
 * The screen after the last card: the tally, the fix list, and what to run next.
 * @param {{ review: string, cards: readonly DecisionCard[], picks: Readonly<Record<string, Pick>>,
 *   summary: Summary, fixes: { path: string, markdown: string } | null, settled: number }} data
 */
export function finishHtml(data) {
  const { summary, fixes } = data
  const empty = data.cards.length === 0
  const tally = [
    ['fixes', summary.fixes, 'to fix'],
    ['records', summary.records, 'to write down'],
    ['comments', summary.comments, 'PR comments queued'],
    ['skipped', summary.skipped, 'left for reviewers'],
  ]
    .map(
      ([cls, n, label]) =>
        `<li class="deck-tally-${cls}"><span class="deck-tally-n" data-count="${n}">${n}</span><span>${label}</span></li>`
    )
    .join('')
  const command = `/pr-self-review-fix ${data.review}`
  const next =
    summary.fixes + summary.records === 0
      ? `<p>Nothing to fix. Open the pull request when you are ready: settled decisions travel with it.</p>`
      : `<p>Hand the fix list to your coding agent. It asks you about anything unclear, applies the fixes, then deals a fresh deck for whatever they change.</p>
<p class="deck-run"><code>${esc(command)}</code> <button class="cmd fill" type="button" data-copy="${esc(command)}">copy</button></p>`
  const list =
    fixes === null
      ? ''
      : `<details class="deck-fixes" open><summary>Fix list</summary>
<p class="deck-fixes-path"><span class="mono">${esc(fixes.path)}</span><button class="cmd" type="button" data-copy="${esc(fixes.path)}">copy path</button></p>
<div class="deck-fixes-body">${renderMarkdown(fixes.markdown)}</div></details>`
  const picks = data.cards.flatMap(card => {
    const pick = data.picks[card.key]
    return pick === undefined ? [] : [pickLine(card, pick)]
  })
  const settled =
    data.settled === 0
      ? ''
      : `<p class="muted">${data.settled} decision${data.settled === 1 ? '' : 's'} settled in earlier decks carried over, not asked again.</p>`
  return `<section class="deck-finish" aria-labelledby="deck-finish-h">
<div class="deck-burst" aria-hidden="true">${'<i></i>'.repeat(18)}</div>
<h2 id="deck-finish-h">${empty ? 'Nothing needs your call' : 'Deck cleared'}</h2>
${empty ? '<p>No decision in this change is open to a reasonable second opinion. Nice.</p>' : `<ul class="deck-tally">${tally}</ul>`}
${settled}
${empty ? '' : next}
${list}
${picks.length === 0 ? '' : `<details class="deck-picks"><summary>Your picks</summary><ul class="plain">${picks.join('')}</ul></details>`}
</section>`
}

export const DECK_HELP_ID = 'deck-help'

export function deckHelpHtml() {
  const rows = DECK_KEY_HELP.map(
    r => `<tr><td class="mono">${esc(r.keys)}</td><td>${esc(r.what)}</td></tr>`
  ).join('')
  return (
    `<dialog id="${DECK_HELP_ID}" class="help" aria-labelledby="deck-help-h"><form method="dialog">` +
    '<h2 id="deck-help-h">Keyboard</h2>' +
    `<table class="keys"><tbody>${rows}</tbody></table>` +
    '<p class="muted">Or drag the card: left picks A, right picks B.</p>' +
    '<div class="dialog-actions"><button class="cmd" type="submit" value="close">close</button></div>' +
    '</form></dialog>'
  )
}
