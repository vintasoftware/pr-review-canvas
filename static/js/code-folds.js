// @ts-check
// Rows a reviewer can hide: the canvas folds the model named, and the folds the diff renderer
// marked (import-only and whitespace-only changes, and moved blocks). Both open again when a
// deep link lands inside them.
import { findRow } from './anchors.js'

/** @typedef {import('./contract-types.js').CodeFold} CodeFold */

/**
 * @param {Element | null} summary
 * @param {readonly HTMLTableRowElement[]} rows
 */
function coveredFoldSummary(summary, rows) {
  if (!summary?.matches('.fold')) {
    return false
  }

  let next = summary.nextElementSibling
  while (next instanceof HTMLTableRowElement && next.matches('.folded')) {
    if (!rows.includes(next)) {
      return false
    }
    next = next.nextElementSibling
  }

  return true
}

/**
 * Finds the rows between both anchors. A decorated or overlapping range stays open.
 * @param {HTMLElement} card
 * @param {string} key
 * @param {CodeFold} fold
 * @returns {HTMLTableRowElement[]}
 */
function foldRows(card, key, fold) {
  const first = findRow(card, key, fold.side, fold.startLine)
  const last = findRow(card, key, fold.side, fold.endLine)

  if (first === null || last === null || first.parentElement === null) {
    return []
  }

  if (last.parentElement !== first.parentElement) {
    return []
  }

  const siblings = Array.from(first.parentElement.children)
  const from = siblings.indexOf(first)
  const to = siblings.indexOf(last)

  if (to < from) {
    return []
  }

  const rows = siblings.slice(from, to + 1).filter(row => row instanceof HTMLTableRowElement)
  const hasDiscussion = rows.some(row => row.matches('.ann, [data-decoration], [data-code-fold], .code-fold'))

  const hasThread = Boolean(first.closest('table')?.querySelector('[data-decoration="thread"]'))

  if (hasDiscussion || hasThread || last.nextElementSibling?.matches('[data-decoration]')) {
    return []
  }

  const preceding = first.previousElementSibling
  if (preceding instanceof HTMLTableRowElement && coveredFoldSummary(preceding, rows)) {
    rows.unshift(preceding)
  }

  return rows
}

/**
 * Inserts the fold's title above its first row.
 * @param {HTMLTableRowElement} first
 * @param {string} title
 */
function createToggle(first, title) {
  const header = document.createElement('tr')
  header.className = 'more code-fold'

  const cell = document.createElement('td')
  cell.colSpan = 4

  const toggle = document.createElement('button')
  toggle.className = 'cmd'
  toggle.type = 'button'
  toggle.textContent = title

  cell.appendChild(toggle)
  header.appendChild(cell)
  first.before(header)

  return toggle
}

/**
 * Keeps the original rows in the DOM so comments and deep links retain their anchors.
 * @param {HTMLTableRowElement} first
 * @param {HTMLTableRowElement[]} rows
 * @param {string} title
 */
function wireFold(first, rows, title) {
  const toggle = createToggle(first, title)
  const table = first.closest('table')
  const foldSummaries = new Set(rows.filter(row => coveredFoldSummary(row, rows)))
  toggle.setAttribute(
    'aria-controls',
    rows
      .map(row => row.id)
      .filter(Boolean)
      .join(' ')
  )

  const setExpanded = (/** @type {boolean} */ expanded) => {
    toggle.setAttribute('aria-expanded', String(expanded))

    for (const row of rows) {
      row.hidden = !expanded || foldSummaries.has(row)
      row.setAttribute('data-code-fold', '')
    }
  }

  toggle.addEventListener('click', () => setExpanded(toggle.getAttribute('aria-expanded') !== 'true'))

  table?.addEventListener('reveal-code', event => {
    const target = event.target
    if (target instanceof Node && (target === table || rows.some(row => row.contains(target)))) {
      setExpanded(true)
    }
  })

  setExpanded(false)
}

/**
 * Adds title-only folds; ranges with annotations, attention points, or discussions stay open.
 * @param {HTMLElement} card
 * @param {string} key
 * @param {readonly CodeFold[]} folds
 */
export function applyCodeFolds(card, key, folds) {
  for (const fold of folds) {
    const rows = foldRows(card, key, fold)
    const first = rows[0]

    if (first !== undefined) {
      wireFold(first, rows, fold.title)
    }
  }
}

/**
 * The `.fold` summary row that owns a folded row, or null when the row is not in a fold.
 * @param {Element} row
 * @returns {HTMLTableRowElement | null}
 */
function foldSummaryFor(row) {
  if (!row.matches('tr.folded')) {
    return null
  }
  let previous = row.previousElementSibling
  while (previous instanceof HTMLTableRowElement && previous.matches('.folded')) {
    previous = previous.previousElementSibling
  }
  return previous instanceof HTMLTableRowElement && previous.matches('.more.fold') ? previous : null
}

/**
 * Shows or hides the rows a summary row stands for, and relabels its button.
 * @param {HTMLTableRowElement} summary
 * @param {boolean} shown
 */
export function setFoldShown(summary, shown) {
  let next = summary.nextElementSibling
  while (next instanceof HTMLTableRowElement && next.matches('.folded')) {
    next.classList.toggle('shown', shown)
    next = next.nextElementSibling
  }
  const toggle = summary.querySelector('button[data-act="show-fold"]')
  if (toggle instanceof HTMLElement) {
    toggle.setAttribute('aria-expanded', String(shown))
    toggle.textContent = shown ? 'hide' : 'show'
  }
}

/**
 * Opens the folded rows around a deep-link target, so a line inside a fold can be reached.
 * @param {HTMLElement} card
 */
export function wireFoldReveal(card) {
  card.addEventListener('reveal-code', event => {
    const target = event.target
    const row = target instanceof Element ? target.closest('tr') : null
    const summary = row === null ? null : foldSummaryFor(row)
    if (summary !== null) {
      setFoldShown(summary, true)
    }
  })
}
