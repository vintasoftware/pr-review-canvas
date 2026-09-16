// @ts-check
// Signing off: approve or request changes. The dialog shows the body the server built, lets the
// reader edit it, and names the commit the review lands on.
/** @typedef {import('./contract-types.js').PrState} PrState */
/** @typedef {import('./contract-types.js').ReviewArtifact} ReviewArtifact */
/** @typedef {import('./contract-types.js').ReviewBodyResponse} ReviewBodyResponse */
import { previewControlsHtml, setDisabledReason, setMarkdownPreview } from './composer.js'
import { esc } from './dom.js'
import { hostLabel } from './host.js'
import { layerProgress } from './progress.js'

export const SIGNOFF_DIALOG_ID = 'signoff-dialog'

/** Why the post command waits: the body the server writes is not there yet. */
export const LOADING_REASON = 'the review body is still loading'

/**
 * Why approve is not allowed yet, or null when it is. Other changes never counts.
 * @param {ReviewArtifact} artifact
 * @param {PrState} state
 * @returns {string | null}
 */
export function approveBlockedReason(artifact, state) {
  const [first, ...rest] = artifact.layers.filter(
    l => l.kind !== 'other' && layerProgress(l, state) !== 'done'
  )
  if (first === undefined) {
    return null
  }
  return rest.length === 0
    ? `1 layer is not reviewed yet: ${first.title}`
    : `${rest.length + 1} layers are not reviewed yet`
}

/**
 * @param {'APPROVE' | 'REQUEST_CHANGES'} event
 */
export function signoffTitle(event) {
  return event === 'APPROVE' ? `Approve on ${hostLabel()}` : `Request changes on ${hostLabel()}`
}

/**
 * @param {{ event: 'APPROVE' | 'REQUEST_CHANGES' }} opts
 * @returns {string}
 */
export function signoffDialogHtml(opts) {
  return (
    `<dialog id="${SIGNOFF_DIALOG_ID}" class="signoff-dialog" aria-labelledby="signoff-h">` +
    `<h2 id="signoff-h">${esc(signoffTitle(opts.event))}</h2>` +
    `<p class="hint">This posts a review on ${esc(hostLabel())} as you. Edit the body first if you want to.</p>` +
    '<p class="signoff-target muted mono"></p>' +
    '<label class="sr" for="signoff-body">Review body</label>' +
    previewControlsHtml() +
    '<textarea id="signoff-body" rows="12" aria-busy="true"></textarea>' +
    '<p class="signoff-result" role="status"></p>' +
    '<div class="dialog-actions">' +
    '<button class="cmd fill" type="button" data-act="signoff-post" data-needs-post disabled ' +
    `data-disabled-reason="${esc(LOADING_REASON)}" title="${esc(LOADING_REASON)}">post review</button>` +
    '<button class="cmd" type="button" data-act="signoff-close">cancel</button></div></dialog>'
  )
}

/**
 * Creates the dialog on first use, points it at this event, and opens it. The body arrives
 * afterwards through `fillSignoffDialog`.
 * @param {HTMLElement} root
 * @param {{ event: 'APPROVE' | 'REQUEST_CHANGES' }} opts
 * @returns {HTMLDialogElement}
 */
export function openSignoffDialog(root, opts) {
  let dialog = root.querySelector(`#${SIGNOFF_DIALOG_ID}`)
  if (!(dialog instanceof HTMLDialogElement)) {
    const t = document.createElement('template')
    t.innerHTML = signoffDialogHtml(opts)
    root.appendChild(t.content)
    dialog = root.querySelector(`#${SIGNOFF_DIALOG_ID}`)
  }
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error('sign-off dialog did not render')
  }
  setMarkdownPreview(dialog, false)
  dialog.setAttribute('data-event', opts.event)
  const heading = dialog.querySelector('#signoff-h')
  if (heading !== null) {
    heading.textContent = signoffTitle(opts.event)
  }
  const result = dialog.querySelector('.signoff-result')
  if (result !== null) {
    result.textContent = ''
  }
  const area = dialog.querySelector('textarea')
  if (area instanceof HTMLTextAreaElement) {
    area.value = ''
    area.placeholder = 'loading the review body…'
    area.setAttribute('aria-busy', 'true')
  }
  setDisabledReason(dialog.querySelector('[data-act="signoff-post"]'), LOADING_REASON)
  if (typeof dialog.showModal === 'function' && !dialog.open) {
    dialog.showModal()
  } else {
    dialog.setAttribute('open', '')
  }
  return dialog
}

/**
 * Puts the generated body and the target commit in the dialog.
 * @param {HTMLDialogElement} dialog
 * @param {ReviewBodyResponse} preview
 */
export function fillSignoffDialog(dialog, preview) {
  const area = dialog.querySelector('textarea')
  if (area instanceof HTMLTextAreaElement) {
    area.value = preview.body
    area.removeAttribute('aria-busy')
    area.focus()
  }
  setDisabledReason(dialog.querySelector('[data-act="signoff-post"]'), null)
  const target = dialog.querySelector('.signoff-target')
  if (target !== null) {
    target.textContent = `on commit ${preview.headSha.slice(0, 7)}`
  }
  return dialog
}

/**
 * Shows the link to the review GitHub created.
 * @param {HTMLDialogElement} dialog
 * @param {import('./contract-types.js').ReviewSummary} review
 */
export function showSignoffResult(dialog, review) {
  const result = dialog.querySelector('.signoff-result')
  if (result !== null) {
    result.textContent = 'Posted · '
    result.append(externalLink(review.url, `see it on ${hostLabel()}`))
  }
  return result
}

/**
 * An anchor built as a node, with an href only when the target is an http(s) address. A link
 * that comes from an API is still untrusted input.
 * @param {string} url
 * @param {string} text
 */
export function externalLink(url, text) {
  const a = document.createElement('a')
  a.textContent = text
  if (/^https?:\/\//i.test(url)) {
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
  }
  return a
}

/**
 * Says inside the dialog why the body could not be read, and keeps the post command off.
 * @param {HTMLDialogElement} dialog
 * @param {string} message
 */
export function showSignoffError(dialog, message) {
  const result = dialog.querySelector('.signoff-result')
  if (result !== null) {
    result.textContent = message
  }
  return result
}

/** @param {HTMLDialogElement} dialog */
export function signoffBody(dialog) {
  const area = dialog.querySelector('textarea')
  return area instanceof HTMLTextAreaElement ? area.value.trim() : ''
}
