// @ts-check
// Rows a reviewer can hide: the canvas folds the model named, and the folds the diff renderer
// marked (import-only and whitespace-only changes, and moved blocks). Both open again when a
// deep link lands inside them. Every model fold is wired once, when the diff is drawn; the
// reader's level only decides which of them are active, so changing it never rebuilds the table
// and an open composer or an expanded fold survives. The renderer's own folds hide in every mode.
import { findRow } from './anchors.js'
import { foldsForLevel } from './fold-levels.js'

/** @typedef {import('./contract-types.js').CodeFold} CodeFold */
/** @typedef {import('./contract-types.js').FoldLevel} FoldLevel */

/** Rows that keep their code open at every level. */
const PINNED = '[data-decoration="point"], [data-decoration="thread"]'
/** Annotation band rows and the note row under them; only an aggressive fold may hide these. */
const ANNOTATED = '.ann, [data-decoration="note"]'

/**
 * One model fold on a drawn table. `rows` are fixed when the diff is drawn; `hiddenBefore` is how
 * each row looked before any fold touched it, so a fold the level turns off gives it back.
 * @typedef {{
 *   fold: CodeFold,
 *   rows: HTMLTableRowElement[],
 *   hiddenBefore: boolean[],
 *   summaries: Set<HTMLTableRowElement>,
 *   header: HTMLTableRowElement,
 *   toggle: HTMLButtonElement,
 *   active: boolean,
 *   expanded: boolean,
 * }} WiredFold
 */

/** The folds wired on each drawn diff. A redraw builds a new diff, so it starts a new list. */
const wiredFolds = /** @type {WeakMap<Element, WiredFold[]>} */ (new WeakMap())

/**
 * The drawn diff of a card, one table per hunk, or null before it draws.
 * @param {HTMLElement} card
 */
function drawnDiff(card) {
  return card.querySelector('.diff-wrap')
}

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
 * Finds the rows between both anchors. A range holding an attention point or a discussion stays
 * open at every level; a range holding an annotation stays open unless the fold is aggressive.
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
  let to = siblings.indexOf(last)

  if (to < from) {
    return []
  }

  const aggressive = fold.level === 'aggressive'

  // An annotation's note row sits under the last line it covers, so an aggressive fold that ends
  // on that line takes the note with it rather than leaving it stranded above open code.
  if (aggressive) {
    while (siblings[to + 1]?.matches('[data-decoration="note"]') === true) {
      to++
    }
  }

  const rows = siblings.slice(from, to + 1).filter(row => row instanceof HTMLTableRowElement)
  const trailing = siblings[to + 1]
  const blocked =
    rows.some(row => row.matches(PINNED)) ||
    (!aggressive && rows.some(row => row.matches(ANNOTATED))) ||
    trailing?.matches(aggressive ? PINNED : '[data-decoration]') === true

  if (blocked) {
    return []
  }

  const preceding = first.previousElementSibling
  if (preceding instanceof HTMLTableRowElement && coveredFoldSummary(preceding, rows)) {
    rows.unshift(preceding)
  }

  return rows
}

/**
 * What the toggle says. An aggressive fold that hides an annotation shows the annotation instead
 * of its own title, so the reader still reads the explanation of the code it replaces. The
 * validator lets such a fold cover one whole annotation at most, so there is one note to show.
 * @param {readonly HTMLTableRowElement[]} rows
 * @param {CodeFold} fold
 * @returns {string}
 */
function foldLabel(rows, fold) {
  const note = rows.find(row => row.matches('[data-decoration="note"]'))
  const text = note?.querySelector('.prose')?.textContent?.trim()
  return text === undefined || text === '' ? fold.title : text
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

  return { header, toggle }
}

/**
 * Draws one fold as the level and the reader left it. An inactive fold gives its rows back as
 * they were; an active one hides them behind its title until the reader expands it.
 * @param {WiredFold} wired
 */
function paintFold(wired) {
  wired.header.hidden = !wired.active
  wired.toggle.setAttribute('aria-expanded', String(wired.active && wired.expanded))
  for (const [index, row] of wired.rows.entries()) {
    if (wired.active) {
      row.hidden = !wired.expanded || wired.summaries.has(row)
      row.setAttribute('data-code-fold', '')
    } else {
      row.hidden = wired.hiddenBefore[index] === true
      row.removeAttribute('data-code-fold')
    }
  }
}

/**
 * Points a drawn card's folds at a level: the outermost folds that hide at it become active and
 * start folded, and the rest give their rows back. A fold that stays active keeps whatever the
 * reader did with it. A card with a thread keeps all of its code open, so none is active. Inactive
 * folds paint first, so a row shared with an active outer or inner fold ends up as the active
 * one says.
 * @param {HTMLElement} card
 * @param {FoldLevel} level
 * @param {boolean} threaded whether a thread sits in the card's chunks
 */
export function setCodeFoldLevel(card, level, threaded) {
  const diff = drawnDiff(card)
  const wired = diff === null ? [] : (wiredFolds.get(diff) ?? [])
  const active = new Set(
    threaded
      ? []
      : foldsForLevel(
          wired.map(w => w.fold),
          level
        )
  )

  for (const w of wired) {
    const now = active.has(w.fold)
    if (now && !w.active) {
      w.expanded = false
    }
    w.active = now
  }
  const inactive = wired.filter(w => !w.active)
  for (const w of [...inactive, ...wired.filter(fold => fold.active)]) {
    paintFold(w)
  }
}

/**
 * Wires every model fold of a freshly drawn diff, then applies the reader's level. The rows of
 * every fold are found before any title row goes in, so nested folds each see only diff rows.
 * Ranges with attention points stay open, and so do ranges with annotations unless the fold is
 * aggressive. A second call on the same diff does nothing.
 * @param {HTMLElement} card
 * @param {string} key
 * @param {readonly CodeFold[]} folds
 * @param {FoldLevel} level the reader's level
 * @param {boolean} threaded whether a thread sits in the card's chunks
 */
export function applyCodeFolds(card, key, folds, level, threaded) {
  const diff = drawnDiff(card)
  if (diff === null || wiredFolds.has(diff)) {
    return
  }

  const found = folds.map(fold => ({ fold, rows: foldRows(card, key, fold) }))
  /** @type {WiredFold[]} */
  const wired = []
  for (const { fold, rows } of found) {
    const first = rows[0]
    if (first === undefined) {
      continue
    }
    const { header, toggle } = createToggle(first, foldLabel(rows, fold))
    toggle.setAttribute(
      'aria-controls',
      rows
        .map(row => row.id)
        .filter(Boolean)
        .join(' ')
    )
    const w = {
      fold,
      rows,
      hiddenBefore: rows.map(row => row.hidden),
      summaries: new Set(rows.filter(row => coveredFoldSummary(row, rows))),
      header,
      toggle,
      active: false,
      expanded: false,
    }
    toggle.addEventListener('click', () => {
      w.expanded = !w.expanded
      paintFold(w)
    })
    const table = first.closest('table')
    table?.addEventListener('reveal-code', event => {
      const target = event.target
      if (
        w.active &&
        target instanceof Node &&
        (target === table || rows.some(row => row.contains(target)))
      ) {
        w.expanded = true
        paintFold(w)
      }
    })
    wired.push(w)
  }

  wiredFolds.set(diff, wired)
  setCodeFoldLevel(card, level, threaded)
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
