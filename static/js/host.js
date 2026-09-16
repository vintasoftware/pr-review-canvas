// @ts-check
/** @typedef {{ kind: 'github' | 'gitlab', label: string, cliName?: string, hostname?: string, webBase?: string }} HostInfo */

/** @type {HostInfo} */
export const DEFAULT_HOST = {
  kind: 'github',
  label: 'GitHub',
  cliName: 'gh',
  hostname: 'github.com',
  webBase: 'https://github.com',
}

/** @type {HostInfo} */
let current = DEFAULT_HOST

/** @param {HostInfo | undefined | null} host */
export function setHost(host) {
  current = host ?? DEFAULT_HOST
}

export function currentHost() {
  return current
}

export function forgeLabel() {
  return current.label
}

export function postToLabel() {
  return `post to ${current.kind}`
}

export function noPostingTitle() {
  return `this ${current.label} login cannot post on this repository`
}

/**
 * @param {'APPROVE' | 'REQUEST_CHANGES'} event
 */
export function signoffHostTitle(event) {
  return event === 'APPROVE' ? `Approve on ${current.label}` : `Request changes on ${current.label}`
}

/** @param {string} author */
export function authorProfileUrl(author) {
  const base = current.webBase ?? (current.kind === 'gitlab' ? 'https://gitlab.com' : 'https://github.com')
  return `${base}/${author}`
}
