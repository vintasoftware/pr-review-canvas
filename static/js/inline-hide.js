// @ts-check
// The switch that hides the inline items so the reader can read the code first. The rows stay in
// the page; a CSS rule keyed on <html> hides them. The server validates settings.yml against the
// value lists here.

export const INLINE_KINDS = /** @type {const} */ (['points', 'comments', 'pending', 'annotations'])
/** @typedef {(typeof INLINE_KINDS)[number]} InlineKind */

export const DEFAULT_INLINE_KINDS = /** @type {InlineKind[]} */ ([...INLINE_KINDS])

/** What going to a hidden item does: show only that item, or turn hiding off. */
export const HIDDEN_ITEM_CLICKS = /** @type {const} */ (['reveal', 'show-all'])
/** @typedef {(typeof HIDDEN_ITEM_CLICKS)[number]} HiddenItemClick */

export const DEFAULT_HIDDEN_ITEM_CLICK = /** @type {HiddenItemClick} */ ('reveal')

export const INLINE_KIND_LABELS = /** @type {Readonly<Record<InlineKind, string>>} */ ({
  points: 'attention points',
  comments: 'review comments, earlier and carried',
  pending: 'your pending drafts',
  annotations: 'annotations',
})

export const HIDDEN_ITEM_CLICK_LABELS = /** @type {Readonly<Record<HiddenItemClick, string>>} */ ({
  reveal: 'show only that item',
  'show-all': 'turn hiding off',
})

/** The row class of each kind, as diff-decorations.js and points.js draw them. */
const ROW_SELECTORS = /** @type {Readonly<Record<InlineKind, string>>} */ ({
  points: 'tr.ifind',
  comments: 'tr.thread',
  pending: 'tr.pending-row',
  annotations: 'tr.annot',
})

/**
 * The row an item link goes to. The caller escapes the id: the server imports this module, so
 * it cannot import anchors.js.
 * @param {'points' | 'pending'} kind
 * @param {string} escapedId
 */
export function itemRowSelector(kind, escapedId) {
  const attr = kind === 'points' ? 'data-point' : 'data-pending-id'
  return `${ROW_SELECTORS[kind]}[${attr}="${escapedId}"]`
}

/** On <html>: the kinds hidden. Absent while the switch is off. */
export const HIDE_ATTR = 'data-hide-inline'
/** On one row: the reader went to it, so it shows while the rest stay hidden. */
export const SHOWN_ATTR = 'data-inline-shown'
export const INLINE_TOGGLE_ID = 'inline-toggle'

/**
 * @param {unknown} value
 * @returns {value is InlineKind}
 */
export function isInlineKind(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (INLINE_KINDS).includes(value)
}

/**
 * @param {unknown} value
 * @returns {value is HiddenItemClick}
 */
export function isHiddenItemClick(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (HIDDEN_ITEM_CLICKS).includes(value)
}

/**
 * The switch, under the names the settings file gives it.
 * @typedef {Pick<import('./contract-types.js').Settings, 'hideInline' | 'hideInlineKinds' | 'hiddenItemClick'>} InlineHide
 */

/**
 * @param {Element} row
 * @param {Element} html the page's <html>
 */
export function isHiddenRow(row, html) {
  const hidden = (html.getAttribute(HIDE_ATTR) ?? '').split(' ')
  return (
    !row.hasAttribute(SHOWN_ATTR) &&
    INLINE_KINDS.some(kind => hidden.includes(kind) && row.matches(ROW_SELECTORS[kind]))
  )
}

/** @param {Element} row */
export function showRow(row) {
  row.setAttribute(SHOWN_ATTR, '')
}

/**
 * @param {ReadonlyArray<InlineKind>} kinds
 * @param {Partial<Record<InlineKind, string>>} words
 */
function listOf(kinds, words) {
  const named = INLINE_KINDS.filter(k => kinds.includes(k) && words[k] !== undefined).map(k => words[k])
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
}

/**
 * What is hidden, and where each kind can still be found.
 * @param {InlineHide} hide
 */
export function inlineHideHint(hide) {
  const kinds = hide.hideInlineKinds
  if (!hide.hideInline) {
    return ''
  }
  const where = []
  if (kinds.includes('points')) where.push('points are still in the layer summary and on ]')
  if (kinds.includes('pending')) where.push('drafts in the review panel')
  const inlineOnly = listOf(kinds, { comments: 'comments', annotations: 'annotations' })
  if (inlineOnly !== '') where.push(`${inlineOnly} come back when you show them`)
  const hidden = listOf(kinds, {
    points: 'points',
    comments: 'comments',
    pending: 'drafts',
    annotations: 'annotations',
  })
  return `${hidden} hidden from the diff · ${where.join('; ')}`
}

/** @param {InlineHide} hide */
export function inlineHideControlHtml(hide) {
  return (
    '<div class="inline-hide">' +
    `<button class="cmd" type="button" id="${INLINE_TOGGLE_ID}" data-act="toggle-inline" aria-pressed="${hide.hideInline}" ` +
    'title="Read the code first: hide the inline attention points, comments, drafts, and annotations. Press i to switch; settings choose what it hides.">' +
    `${hide.hideInline ? 'show' : 'hide'} inline items</button>` +
    `<span class="inline-hint muted" role="status">${inlineHideHint(hide)}</span></div>`
  )
}

/**
 * Rows are in page order, so the search stops at the first row below the screen.
 * @param {ParentNode} root
 * @param {number} viewHeight
 * @returns {HTMLElement | null}
 */
export function codeRowAtMiddle(root, viewHeight) {
  const middle = viewHeight / 2
  /** @type {HTMLElement | null} */
  let best = null
  let bestDistance = Infinity
  for (const row of Array.from(root.querySelectorAll('tr[id^="L-"]'))) {
    const rect = row.getBoundingClientRect()
    if (rect.height === 0 || rect.bottom <= 0) {
      continue
    }
    if (rect.top > viewHeight) {
      break
    }
    const distance = Math.abs((rect.top + rect.bottom) / 2 - middle)
    if (distance < bestDistance) {
      best = /** @type {HTMLElement} */ (row)
      bestDistance = distance
    }
  }
  return best
}

/**
 * Runs `change`, then scrolls so the code row in the middle of the screen is where it was.
 * @param {ParentNode} root
 * @param {() => void} change
 * @param {Window} [view]
 */
export function keepReadingPosition(root, change, view = window) {
  const anchor = codeRowAtMiddle(root, view.innerHeight)
  const before = anchor?.getBoundingClientRect().top ?? null
  change()
  if (anchor === null || before === null) {
    return
  }
  const delta = anchor.getBoundingClientRect().top - before
  if (delta !== 0) {
    view.scrollBy(0, delta)
  }
}

/** @type {InlineHide} */
let current = {
  hideInline: false,
  hideInlineKinds: DEFAULT_INLINE_KINDS,
  hiddenItemClick: DEFAULT_HIDDEN_ITEM_CLICK,
}

export function getInlineHide() {
  return current
}

/**
 * The only way the switch changes. It does nothing when what shows stays the same, so an unrelated
 * settings save keeps the rows the reader went to.
 * @param {InlineHide} next
 * @param {HTMLElement} page the review page; its document's <html> carries the rule
 * @param {Window} [view]
 */
export function setInlineHide(next, page, view = window) {
  const was = current
  current = {
    hideInline: next.hideInline,
    hideInlineKinds: INLINE_KINDS.filter(k => next.hideInlineKinds.includes(k)),
    hiddenItemClick: next.hiddenItemClick,
  }
  const hidden = current.hideInline ? current.hideInlineKinds.join(' ') : ''
  const html = page.ownerDocument.documentElement
  if (hidden === (html.getAttribute(HIDE_ATTR) ?? '') && current.hideInline === was.hideInline) {
    return
  }
  keepReadingPosition(
    page,
    () => {
      for (const row of Array.from(page.querySelectorAll(`[${SHOWN_ATTR}]`))) {
        row.removeAttribute(SHOWN_ATTR)
      }
      if (hidden === '') {
        html.removeAttribute(HIDE_ATTR)
      } else {
        html.setAttribute(HIDE_ATTR, hidden)
      }
    },
    view
  )
  const button = page.querySelector(`#${INLINE_TOGGLE_ID}`)
  if (button !== null) {
    button.setAttribute('aria-pressed', String(current.hideInline))
    button.textContent = `${current.hideInline ? 'show' : 'hide'} inline items`
  }
  const hint = page.querySelector('.inline-hide .inline-hint')
  if (hint !== null) {
    hint.textContent = inlineHideHint(current)
  }
}
