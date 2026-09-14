// @ts-check
import { esc } from './dom.js'

/** @param {string} url @param {boolean} [filled] */
export function viewCommentHtml(url, filled = false) {
  return `<a class="cmd${filled ? ' fill' : ''}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">view comment</a>`
}

/** @param {HTMLElement} button @param {string} url */
export function replacePostButton(button, url) {
  const template = button.ownerDocument.createElement('template')
  template.innerHTML = viewCommentHtml(url, button.classList.contains('fill'))
  const link = template.content.firstElementChild
  if (link instanceof HTMLAnchorElement) {
    const focused = button.ownerDocument.activeElement === button
    button.replaceWith(link)
    if (focused) {
      link.focus()
    }
  }
}

/**
 * @param {import('./proposed-comment.js').ProposedComment} proposed
 * @param {ReadonlyArray<import('./contract-types.js').ReviewComment>} posted
 */
export function postedCommentUrl(proposed, posted) {
  return posted.find(
    c =>
      c.inReplyToId === undefined &&
      c.path === proposed.path &&
      c.line === proposed.line &&
      c.side === proposed.side &&
      (c.startLine ?? c.line) === (proposed.startLine ?? proposed.line) &&
      c.body === proposed.body
  )?.url
}
