// @ts-check
// The regenerate dialog: the skill command with --force and a copy command. The page keeps polling
// while it is open and swaps in the new canvas when one is indexed for the head.
/** @typedef {import('./contract-types.js').PrBundle} PrBundle */
import { esc } from './dom.js'

export const REGENERATE_DIALOG_ID = 'regenerate-dialog'

/**
 * @param {string} command
 * @returns {string}
 */
export function regenerateDialogHtml(command) {
  return (
    `<dialog id="${REGENERATE_DIALOG_ID}" class="regen" aria-labelledby="regen-h"><form method="dialog">` +
    '<h2 id="regen-h">Regenerate the canvas</h2>' +
    '<p class="hint">Run this in Claude Code or Codex from this repo. The current canvas stays until the new one is published; this page then updates on its own.</p>' +
    `<div class="cmdbox"><code>${esc(command)}</code><button class="cmd fill" type="button" data-copy="${esc(command)}">copy</button></div>` +
    '<div class="dialog-actions"><button class="cmd" type="submit" value="close">close</button></div>' +
    '</form></dialog>'
  )
}

/**
 * Creates the dialog under `root` on first use, updates its command, and opens it.
 * @param {HTMLElement} root
 * @param {string} command
 * @returns {HTMLDialogElement}
 */
export function openRegenerateDialog(root, command) {
  let dialog = root.querySelector(`#${REGENERATE_DIALOG_ID}`)
  if (!(dialog instanceof HTMLDialogElement)) {
    const t = document.createElement('template')
    t.innerHTML = regenerateDialogHtml(command)
    root.appendChild(t.content)
    dialog = root.querySelector(`#${REGENERATE_DIALOG_ID}`)
  }
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error('regenerate dialog did not render')
  }
  const code = dialog.querySelector('code')
  const copy = dialog.querySelector('[data-copy]')
  if (code) {
    code.textContent = command
  }
  copy?.setAttribute('data-copy', command)
  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
  return dialog
}

/**
 * True when `next` carries a canvas that differs from the one the page shows: another head sha,
 * or the same head regenerated (a newer generatedAt).
 * @param {PrBundle} current
 * @param {PrBundle} next
 */
export function canvasChanged(current, next) {
  if (next.status !== 'ready' || !next.artifact || !next.canvas) {
    return false
  }
  if (current.status !== 'ready' || !current.artifact || !current.canvas) {
    return true
  }
  return (
    next.canvas.headSha !== current.canvas.headSha ||
    next.artifact.generatedAt !== current.artifact.generatedAt
  )
}
