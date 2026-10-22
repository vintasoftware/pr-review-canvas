// @ts-check
// How an attention point's level reads: as an icon on the page, and as text in a posted comment
// or AI Chat's context. The server reads the text from here too, so the two never drift apart.
/** @typedef {import('./contract-types.js').Point} Point */
import { esc } from './dom.js'

export const LEVELS = /** @type {const} */ (['decide', 'check', 'fyi'])

/**
 * Each level's shape, on a 16-unit grid: a diamond for a decision (the flowchart's), a checked box
 * for something to verify, and GitHub's info circle for context. The shape says the level in every
 * palette, so the `pointColors` setting only changes the fill.
 */
const LEVEL_PATHS = {
  decide: 'M8 1.25 14.75 8 8 14.75 1.25 8Z',
  check:
    'M2.75 1h10.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Zm0 1.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25Zm8.53 3.78-4 4a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 0 1 1.06-1.06l1.47 1.47 3.47-3.47a.75.75 0 0 1 1.06 1.06Z',
  fyi: 'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
}

/**
 * The icon of a level. `label` names it for screen readers and the tooltip; null hides it from
 * them, for an icon whose text already stands next to it.
 * @param {'decide' | 'check' | 'fyi'} level
 * @param {string | null} [label]
 */
export function levelIconHtml(level, label = level) {
  const named =
    label === null ? 'aria-hidden="true"' : `role="img" aria-label="${esc(label)}" title="${esc(label)}"`
  return `<span class="lv ${level}" ${named}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="${LEVEL_PATHS[level]}"/></svg></span>`
}

/**
 * The level as words, with a `decide` point's impact, as in `decide (high impact)`.
 * @param {Pick<Point, 'level' | 'impact'>} p
 */
export function pointLevelText(p) {
  return p.impact === undefined ? p.level : `${p.level} (${p.impact} impact)`
}

/**
 * The kind as the page names it. A `decision` point is any choice the change makes, at any level,
 * so it reads as a design choice rather than as something to decide; the stored kind stays.
 * @param {Pick<Point, 'kind'>} p
 */
export function pointKindText(p) {
  return p.kind === 'decision' ? 'design choice' : p.kind
}
