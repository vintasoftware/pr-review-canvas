// @ts-check
// Small DOM helpers. Everything that builds HTML from data goes through esc().

/**
 * @param {unknown} value
 * @returns {string}
 */
export function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The `>` chevron before a card title is its collapse toggle. It points right while the card is
 * closed and turns down while it is open (CSS reads aria-expanded). The delegated click handler
 * in interactions.js reads `data-act` and toggles the card this button belongs to.
 * @param {string} label
 * @param {boolean} [expanded]
 * @param {{ act?: string }} [opts] `act` is omitted inside a <details>, which toggles itself
 */
export function chevronHtml(label, expanded = true, opts = {}) {
  const act = opts.act === undefined ? '' : ` data-act="${esc(opts.act)}"`
  return `<button class="chev" type="button"${act} aria-expanded="${expanded ? 'true' : 'false'}" aria-label="${esc(label)}">&gt;</button>`
}

/**
 * The <summary> of a collapsible <details> block: a chevron, then the title. The block relies on the
 * native <details> toggle, so a click anywhere on the summary opens or closes it. Pass `open` when
 * the <details> carries the `open` attribute so the chevron reports the same state.
 * @param {string} titleHtml already escaped
 * @param {string} label the chevron's accessible name
 * @param {{ open?: boolean }} [opts]
 */
export function detailsSummaryHtml(titleHtml, label, opts = {}) {
  return `<summary>${chevronHtml(label, opts.open === true)}${titleHtml}</summary>`
}

/**
 * Parses an HTML string into a fragment. Only for strings built with esc().
 * @param {string} html
 * @returns {DocumentFragment}
 */
export function fragment(html) {
  const t = document.createElement('template')
  t.innerHTML = html
  return t.content
}

/**
 * @template {Element} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T | null}
 */
export function qs(selector, root = document) {
  return /** @type {T | null} */ (root.querySelector(selector))
}

/**
 * Highlights an element for two seconds by toggling `.is-target`.
 * @param {Element} el
 * @param {number} [ms]
 */
export function flash(el, ms = 2000) {
  el.classList.add('is-target')
  setTimeout(() => el.classList.remove('is-target'), ms)
}

/**
 * scrollIntoView without throwing in environments that lack it.
 * @param {Element} el
 */
export function scrollIntoViewSafe(el) {
  el.dispatchEvent(new Event('reveal-code', { bubbles: true }))
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center' })
  }
}

/**
 * "3 min ago" style text for a timestamp.
 * @param {string} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function timeAgo(iso, now = new Date()) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) {
    return ''
  }
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (s < 60) {
    return 'just now'
  }
  const m = Math.round(s / 60)
  if (m < 60) {
    return `${m} min ago`
  }
  const hrs = Math.round(m / 60)
  if (hrs < 48) {
    return `${hrs} h ago`
  }
  return `${Math.round(hrs / 24)} d ago`
}

/**
 * Two-letter initials for the avatar square.
 * @param {string} login
 */
export function initials(login) {
  const parts = login
    .replace(/\[bot\]$/, '')
    .split(/[-_.\s]+/)
    .filter(Boolean)
  const a = parts[0]?.[0] ?? '?'
  const b = parts[1]?.[0] ?? parts[0]?.[1] ?? ''
  return (a + b).toUpperCase()
}

/**
 * Writes text to the clipboard. Throws when the page has no clipboard access (plain http on a
 * non-localhost origin, or an old browser), so the command shows the failure inline.
 * @param {string} text
 * @param {Clipboard | null} [clipboard] defaults to the page's; null means none
 */
export async function copyToClipboard(text, clipboard) {
  const target = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard
  if (!target || typeof target.writeText !== 'function') {
    throw new Error('clipboard is not available; copy the command by hand')
  }
  await target.writeText(text)
}

/** @param {{ author: string, avatarUrl?: string | undefined }} comment */
export function avatarHtml(comment) {
  const url = comment.avatarUrl
  if (url && /^https:\/\/avatars\.githubusercontent\.com\//i.test(url)) {
    return `<img class="av" src="${esc(url)}" alt="${esc(comment.author)} avatar" width="24" height="24" loading="lazy" referrerpolicy="no-referrer">`
  }
  return `<span class="av" aria-hidden="true">${esc(initials(comment.author))}</span>`
}
