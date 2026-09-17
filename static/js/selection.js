// @ts-check
// Picking lines in a diff. The reducer is pure: click selects, clicking the same single line
// again deselects, shift-click extends, dragging extends and commits when the pointer is
// released, Esc clears. The DOM side only marks the rows and shows the toolbar.
/** @typedef {import('./contract-types.js').Side} Side */
/** @typedef {{ key: string, path: string, side: Side, line: number }} LineRef */
/**
 * @typedef {{ key: string, path: string, side: Side, anchor: number, start: number, end: number, dragging: boolean }} Selection
 */
/**
 * @typedef {{ type: 'click', target: LineRef }
 *   | { type: 'shift-click', target: LineRef }
 *   | { type: 'drag-start', target: LineRef }
 *   | { type: 'drag-over', target: LineRef }
 *   | { type: 'commit' }
 *   | { type: 'clear' }} SelectionAction
 */

import { findRow } from './anchors.js'
import { askButtonHtml } from './ask.js'
import { esc } from './dom.js'

/**
 * @param {Selection | null} selection
 * @param {LineRef} target
 */
function sameSide(selection, target) {
  return selection !== null && selection.key === target.key && selection.side === target.side
}

/**
 * @param {LineRef} target
 * @param {boolean} dragging
 * @returns {Selection}
 */
function single(target, dragging) {
  return {
    key: target.key,
    path: target.path,
    side: target.side,
    anchor: target.line,
    start: target.line,
    end: target.line,
    dragging,
  }
}

/**
 * @param {Selection} selection
 * @param {number} line
 * @param {boolean} dragging
 * @returns {Selection}
 */
function extend(selection, line, dragging) {
  return {
    ...selection,
    start: Math.min(selection.anchor, line),
    end: Math.max(selection.anchor, line),
    dragging,
  }
}

/**
 * @param {Selection | null} selection
 * @param {SelectionAction} action
 * @returns {Selection | null}
 */
export function selectionReducer(selection, action) {
  switch (action.type) {
    case 'click':
      if (
        sameSide(selection, action.target) &&
        selection?.start === action.target.line &&
        selection.end === action.target.line
      ) {
        return null
      }
      return single(action.target, false)
    case 'shift-click':
      return selection !== null && sameSide(selection, action.target)
        ? extend(selection, action.target.line, false)
        : single(action.target, false)
    case 'drag-start':
      return single(action.target, true)
    case 'drag-over':
      return selection?.dragging === true && sameSide(selection, action.target)
        ? extend(selection, action.target.line, true)
        : selection
    case 'commit':
      return selection === null ? null : { ...selection, dragging: false }
    case 'clear':
      return null
  }
}

/** @param {Selection} selection */
export function selectionLabel(selection) {
  return selection.start === selection.end
    ? `${selection.path} line ${selection.start}`
    : `${selection.path} lines ${selection.start}–${selection.end}`
}

/**
 * The little bar under a selection: comment on those lines, or ask the chat about them.
 * @param {Selection} selection
 */
export function selectionToolbarHtml(selection) {
  const label = selectionLabel(selection)
  return (
    `<tr class="sel-bar" data-decoration="selection"><td class="ln" colspan="3"></td><td class="code x">` +
    `<span class="lbl">${esc(label)}</span>` +
    '<span class="tbtns"><button class="cmd" type="button" data-act="comment-selection" data-needs-post>comment</button>' +
    askButtonHtml({
      kind: 'lines',
      path: selection.path,
      side: selection.side,
      start: selection.start,
      end: selection.end,
    }) +
    '</span></td></tr>'
  )
}

/**
 * Marks the selected rows and puts the toolbar under the last one. Removes the marks of the
 * previous selection first, so calling it again with any selection leaves one set of marks.
 * @param {ParentNode} root
 * @param {Selection | null} selection
 * @returns {HTMLTableRowElement | null} the row the toolbar was added after
 */
export function markSelection(root, selection) {
  for (const row of Array.from(root.querySelectorAll('tr.is-selected'))) {
    row.classList.remove('is-selected')
  }
  for (const bar of Array.from(root.querySelectorAll('tr.sel-bar'))) {
    bar.remove()
  }
  if (selection === null) {
    return null
  }
  /** @type {HTMLTableRowElement | null} */
  let last = null
  for (let line = selection.start; line <= selection.end; line++) {
    const row = findRow(root, selection.key, selection.side, line)
    if (row) {
      row.classList.add('is-selected')
      last = row
    }
  }
  if (last === null || selection.dragging) {
    return last
  }
  const template = document.createElement('template')
  template.innerHTML = `<table><tbody>${selectionToolbarHtml(selection)}</tbody></table>`
  const bar = template.content.querySelector('tr')
  if (bar !== null) {
    last.insertAdjacentElement('afterend', bar)
  }
  return last
}

/**
 * The line a pointer event landed on, read from the row it came from. Null when the event did
 * not start on a line number cell of a diff row.
 * @param {Event} event
 * @param {(key: string) => string | undefined} pathForKey
 * @returns {LineRef | null}
 */
export function lineRefFromEvent(event, pathForKey) {
  const target = event.target instanceof Element ? event.target.closest('td.ln') : null
  if (target === null) {
    return null
  }
  const row = target.closest('tr')
  const table = row?.closest('table.diff')
  const key = table?.getAttribute('data-key')
  if (!(row && key) || row.classList.contains('chunk') || row.classList.contains('more')) {
    return null
  }
  // The column decides the side: the left one is the old file, the right one the new file.
  // A deleted line exists only on the left, so it is always the old side.
  const cells = Array.from(row.querySelectorAll('td.ln'))
  const oldText = cells[0]?.textContent?.trim() ?? ''
  const newText = cells[1]?.textContent?.trim() ?? ''
  const clickedOld = cells.indexOf(target) === 0 && oldText !== ''
  const side = row.classList.contains('del') || clickedOld ? 'old' : 'new'
  const line = Number(side === 'old' ? oldText : newText)
  const path = pathForKey(key)
  if (!Number.isInteger(line) || line <= 0 || path === undefined) {
    return null
  }
  return { key, path, side, line }
}
