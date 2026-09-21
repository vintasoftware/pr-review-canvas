// @ts-check
// The inline comment box. One markup for all three places it appears: on a diff line, under a
// thread as a reply, and in the overview for a PR-level comment.
/** @typedef {import('./contract-types.js').Side} Side */
/** @typedef {import('./contract-types.js').PostCommentInput} PostCommentInput */
import { cssEscape } from './anchors.js'
import { renderMarkdown } from './markdown.js'
import { esc } from './dom.js'
import { noPostingTitle, postToLabel } from './host.js'

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: 'inline' | 'reply' | 'issue',
 *   path?: string,
 *   line?: number,
 *   side?: Side,
 *   startLine?: number,
 *   inReplyToId?: number,
 *   pointFingerprint?: string,
 *   body?: string,
 *   pendingActive?: boolean,
 *   pendingId?: string,
 * }} ComposerOptions
 */

/** @param {ComposerOptions} opts */
function dataAttributes(opts) {
  const pairs = [
    ['data-kind', opts.kind],
    ['data-path', opts.path],
    ['data-line', opts.line],
    ['data-side', opts.side],
    ['data-start-line', opts.startLine],
    ['data-in-reply-to', opts.inReplyToId],
    ['data-fingerprint', opts.pointFingerprint],
    ['data-pending-id', opts.pendingId],
  ]
  return pairs
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ` ${String(name)}="${esc(value)}"`)
    .join('')
}

/**
 * The commands under the box. A comment on a diff line can go two ways, the way it can on the
 * forge's own page: into the review being written, or straight out on its own. Which one leads
 * depends on whether a review is already open, so the usual next step is the first command.
 *
 * A draft being edited has neither: it is already in the review, so it is only saved.
 * @param {ComposerOptions} opts
 */
function commandsHtml(opts) {
  const cancel = '<button class="cmd" type="button" data-act="composer-cancel">cancel</button>'
  if (opts.pendingId !== undefined) {
    return `<button class="cmd fill" type="button" data-act="pending-save">save</button>${cancel}`
  }
  if (opts.kind !== 'inline') {
    return `<button class="cmd fill" type="button" data-act="composer-post" data-needs-post>${postToLabel()}</button>${cancel}`
  }
  const queueLabel = opts.pendingActive === true ? 'add review comment' : 'start a review'
  return (
    `<button class="cmd fill" type="button" data-act="composer-queue">${queueLabel}</button>` +
    `<button class="cmd" type="button" data-act="composer-post" data-needs-post>${postToLabel()}</button>` +
    cancel
  )
}

/**
 * The box itself. The textarea carries the draft; the commands act on the nearest
 * `.composer-box` ancestor.
 * @param {ComposerOptions} opts
 */
export function composerHtml(opts) {
  return (
    `<div class="composer-box" id="${esc(opts.id)}"${dataAttributes(opts)}>` +
    `<label class="sr" for="${esc(opts.id)}-t">${esc(opts.label)}</label>` +
    previewControlsHtml() +
    `<textarea id="${esc(opts.id)}-t" rows="3" placeholder="${esc(opts.label)}">${esc(opts.body ?? '')}</textarea>` +
    `<div class="composer-actions">${commandsHtml(opts)}</div></div>`
  )
}

/**
 * The same box as a diff row, so it can sit under the line it comments on.
 * @param {ComposerOptions} opts
 */
export function composerRowHtml(opts) {
  return (
    `<tr class="composer" data-decoration="composer">` +
    `<td class="code x" colspan="4">${composerHtml(opts)}</td></tr>`
  )
}

/** The pending item shown while GitHub answers, replaced by the comment it returns. */
export function pendingCommentHtml() {
  return '<div class="cmt pending" data-pending="1"><span class="who muted">posting…</span></div>'
}

/**
 * The body a composer holds, trimmed. Empty means there is nothing to post.
 * @param {Element} box
 */
export function composerBody(box) {
  const textarea = box.querySelector('textarea')
  return textarea instanceof HTMLTextAreaElement ? textarea.value.trim() : ''
}

/**
 * What this composer would add to the pending review, or null when it is empty or is not a
 * comment on a diff line. Only inline comments can wait: a reply and a PR-level comment have
 * no place in a forge review's comment list.
 * @param {Element} box
 * @returns {Omit<import('./contract-types.js').AddPendingInput, 'headSha'> | null}
 */
export function composerPendingInput(box) {
  const input = composerInput(box)
  return input === null || input.kind !== 'inline' ? null : stripKind(input)
}

/** @param {Extract<PostCommentInput, { kind: 'inline' }>} input */
function stripKind(input) {
  const { kind: _kind, ...rest } = input
  return rest
}

/**
 * The request that posts what this composer holds.
 * @param {Element} box
 * @returns {PostCommentInput | null} null when the box is empty or misses its target
 */
export function composerInput(box) {
  const body = composerBody(box)
  if (body === '') {
    return null
  }
  const kind = box.getAttribute('data-kind')
  if (kind === 'issue') {
    return { kind: 'issue', body }
  }
  if (kind === 'reply') {
    const inReplyToId = Number(box.getAttribute('data-in-reply-to'))
    return Number.isInteger(inReplyToId) && inReplyToId > 0 ? { kind: 'reply', inReplyToId, body } : null
  }
  const path = box.getAttribute('data-path')
  const line = Number(box.getAttribute('data-line'))
  const side = box.getAttribute('data-side') === 'old' ? 'old' : 'new'
  if (path === null || !Number.isInteger(line) || line <= 0) {
    return null
  }
  /** @type {PostCommentInput} */
  const input = { kind: 'inline', path, line, side, body }
  const startLine = Number(box.getAttribute('data-start-line'))
  if (Number.isInteger(startLine) && startLine > 0 && startLine !== line) {
    input.startLine = startLine
  }
  const fingerprint = box.getAttribute('data-fingerprint')
  if (fingerprint !== null && fingerprint !== '') {
    input.pointFingerprint = fingerprint
  }
  return input
}

/**
 * Puts the focus in the box that was just opened.
 * @param {ParentNode} root
 * @param {string} id
 */
export function focusComposer(root, id) {
  const textarea = root.querySelector(`#${cssEscape(id)}-t`)
  if (textarea instanceof HTMLTextAreaElement) {
    textarea.focus()
  }
  return textarea
}

/**
 * Removes every open composer under `root`, so only one is open at a time.
 * @param {ParentNode} root
 */
export function closeComposers(root) {
  let closed = 0
  for (const box of Array.from(root.querySelectorAll('.composer-box'))) {
    const row = box.closest('tr.composer')
    ;(row ?? box).remove()
    closed++
  }
  return closed
}

/**
 * Disables everything that posts when the probe said no, and enables it otherwise. A token
 * whose rights cannot be read ('unknown') stays enabled: the host answers for itself.
 *
 * A command can be disabled for a reason of its own (the approve command before every layer is
 * read, a command whose request is still running). Those keep their state: this only adds and
 * removes the reason it owns, which the element carries in `data-post-blocked`.
 * @param {ParentNode} root
 * @param {import('./contract-types.js').Capabilities} capabilities
 */
export function applyCapabilityGating(root, capabilities) {
  const blocked = capabilities.canComment === false
  const reason = capabilities.reason ?? noPostingTitle()
  for (const el of Array.from(root.querySelectorAll('[data-needs-post]'))) {
    if (!(el instanceof HTMLButtonElement) || el.getAttribute('aria-busy') === 'true') {
      continue
    }
    const own = el.getAttribute('data-disabled-reason')
    if (blocked) {
      el.toggleAttribute('data-post-blocked', true)
      el.disabled = true
      el.title = reason
    } else {
      el.removeAttribute('data-post-blocked')
      el.disabled = own !== null
      if (own === null) {
        const tooltip = el.getAttribute('data-tooltip')
        if (tooltip) {
          el.title = tooltip
        } else {
          el.removeAttribute('title')
        }
      } else {
        el.title = own
      }
    }
  }
  const note = root.querySelector('.capability-note')
  if (note !== null) {
    // A disabled command cannot take focus, so the reason is also said in plain sight.
    note.textContent = blocked ? `Posting to GitHub is off: ${reason}` : ''
  }
  return blocked
}

/**
 * Disables one command for a reason of its own, or lifts that reason. The capability state is
 * untouched, so a command that both rules disable stays disabled until both allow it.
 * @param {Element | null} el
 * @param {string | null} reason null enables the command again
 */
export function setDisabledReason(el, reason) {
  if (!(el instanceof HTMLButtonElement)) {
    return
  }
  if (reason === null) {
    el.removeAttribute('data-disabled-reason')
    if (!el.hasAttribute('data-post-blocked')) {
      el.disabled = false
      const tooltip = el.getAttribute('data-tooltip')
      if (tooltip) {
        el.title = tooltip
      } else {
        el.removeAttribute('title')
      }
    }
    return
  }
  el.setAttribute('data-disabled-reason', reason)
  el.disabled = true
  if (!el.hasAttribute('data-post-blocked')) {
    el.title = reason
  }
}

/** One command that swaps the box between writing and previewing; its label is the mode it goes to. */
export function previewControlsHtml() {
  return '<div class="preview-controls"><button class="cmd" type="button" data-act="markdown-toggle">preview</button></div><div class="markdown-preview prose" hidden></div>'
}

/**
 * Puts one editor into write or preview mode.
 * @param {Element} host the `.composer-box` or `.signoff-dialog` that holds the editor
 * @param {boolean} preview
 */
export function setMarkdownPreview(host, preview) {
  const textarea = host.querySelector('textarea')
  const output = host.querySelector('.markdown-preview')
  if (!(textarea instanceof HTMLTextAreaElement) || !(output instanceof HTMLElement)) return
  if (preview)
    output.innerHTML = textarea.value.trim()
      ? renderMarkdown(textarea.value, { github: true })
      : '<p class="muted">Nothing to preview.</p>'
  textarea.hidden = preview
  output.hidden = !preview
  const toggle = host.querySelector('[data-act="markdown-toggle"]')
  if (toggle !== null) toggle.textContent = preview ? 'write' : 'preview'
  if (!preview) textarea.focus()
}

/** @param {HTMLElement} button */
export function toggleMarkdownPreview(button) {
  const host = button.closest('.composer-box, .signoff-dialog')
  if (host === null) return
  const output = host.querySelector('.markdown-preview')
  setMarkdownPreview(host, output instanceof HTMLElement && output.hidden)
}
