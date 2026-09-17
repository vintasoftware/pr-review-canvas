// @ts-check
// Ids and lookups for diff rows. The id builders live in keys.js (shared with the server);
// this module adds the DOM side: finding a row, the nearest visible row, and jumping to a link.
import { flash, scrollIntoViewSafe } from './dom.js'
import { buildLineId, fileAnchorId, sanitizeKey } from './keys.js'
import { linkTargetId, parseLink } from './links.js'

export {
  buildLineId,
  fileAnchorId,
  hunkAnchorId,
  hunkId,
  layerAnchorId,
  parseHunkId,
  parseLineId,
  pointAnchorId,
  sanitizeKey,
} from './keys.js'

/** @param {string} path */
export function keyFromPath(path) {
  return sanitizeKey(path)
}

/**
 * The row for a line, searched inside `root` (a file card or the document).
 * @param {ParentNode} root
 * @param {string} key
 * @param {'new' | 'old'} side
 * @param {number} line
 * @returns {HTMLTableRowElement | null}
 */
export function findRow(root, key, side, line) {
  const el = root.querySelector(`#${cssEscape(buildLineId(key, side, line))}`)
  if (el instanceof HTMLTableRowElement) {
    return el
  }
  if (side === 'old') {
    // Context rows carry the new-side id and the old line as data; deleted rows have the old-side id.
    const ctx = root.querySelector(`table[data-key="${cssEscape(key)}"] tr[data-old="${line}"]`)
    if (ctx instanceof HTMLTableRowElement) {
      return ctx
    }
  }
  return null
}

/**
 * The closest visible row at or before `line` on `side`, for anchors that fall on a folded-away
 * line or in a gap between rows. Null when the table has no earlier row.
 * @param {ParentNode} root
 * @param {string} key
 * @param {'new' | 'old'} side
 * @param {number} line
 * @param {number} [maxDistance]
 * @returns {{ row: HTMLTableRowElement, approx: boolean } | null}
 */
export function nearestRow(root, key, side, line, maxDistance = 40) {
  for (let d = 0; d <= maxDistance; d++) {
    for (const candidate of d === 0 ? [line] : [line - d, line + d]) {
      if (candidate < 1) {
        continue
      }
      const row = findRow(root, key, side, candidate)
      if (row && isRowVisible(row)) {
        return { row, approx: d !== 0 }
      }
    }
  }
  return null
}

/**
 * Can an anchor land on this row? A row the diff folded away (noise, or a block that only moved)
 * is skipped, so the anchor lands nearby and reads `near line`. A row inside a canvas code fold
 * carries `data-code-fold` and stays reachable: that fold opens when the anchor reveals it.
 * @param {HTMLTableRowElement} row
 * @returns {boolean}
 */
function isRowVisible(row) {
  if (row.hasAttribute('data-code-fold')) {
    return true
  }
  return !row.classList.contains('folded') || row.classList.contains('shown')
}

/**
 * Scrolls to the element a canvas link points at and highlights it. Returns false when the
 * link does not parse or its target is not on the page.
 * @param {string} href
 * @param {ParentNode} [root]
 * @returns {boolean}
 */
export function jumpTo(href, root = document) {
  const link = parseLink(href)
  if (!link) {
    return false
  }
  const id = linkTargetId(link, keyFromPath)
  if (link.kind !== 'layer') {
    drawCardOf(root, link.path)
  }
  const el = root.querySelector(`#${cssEscape(id)}`)
  if (!(el instanceof HTMLElement)) {
    return false
  }
  const card = el.closest('.file')
  const body = card?.querySelector('.file-body')
  if (body instanceof HTMLElement && body.hidden) {
    body.hidden = false
  }
  scrollIntoViewSafe(el)
  flash(el)
  return true
}

/**
 * Draws the diff of a file card that is waiting to be seen, so a link into it has a row to land
 * on. The card draws itself (`pr-file` in layers.js); this only asks it to do so now.
 * @param {ParentNode} root
 * @param {string} path
 */
export function drawCardOf(root, path) {
  const card = root.querySelector(`#${cssEscape(fileAnchorId(keyFromPath(path)))}`)?.closest('pr-file')
  const draw = /** @type {{ renderNow?: (force?: boolean) => boolean }} */ (card)?.renderNow
  if (typeof draw === 'function' && card !== null && card !== undefined) {
    // Force, so a card holding a huge patch behind `[ show diff ]` still has the row to land on.
    draw.call(card, true)
  }
}

/**
 * CSS.escape with a fallback for environments without it.
 * @param {string} id
 */
export function cssEscape(id) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id)
  }
  return id.replace(/([^a-zA-Z0-9_-])/g, '\\$1')
}
