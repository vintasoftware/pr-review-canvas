// @ts-check
// The forge this server talks to, as the page shell's bootstrap names it. One server serves one
// host, so the words and links that depend on it are read from here rather than threaded through
// every renderer.
/** @typedef {import('./contract-types.js').PublicHost} PublicHost */

/** @type {PublicHost} */
const DEFAULT_HOST = { kind: 'github', label: 'GitHub', webBase: 'https://github.com' }

/** @type {PublicHost} */
let current = DEFAULT_HOST

/** @param {PublicHost | undefined} host */
export function setHost(host) {
  current = host ?? DEFAULT_HOST
}

export function currentHost() {
  return current
}

/** `GitHub` or `GitLab`, for sentences. */
export function hostLabel() {
  return current.label
}

/** `post to github` / `post to gitlab`, the command label. */
export function postToLabel() {
  return `post to ${current.kind}`
}

/** What a command says when this login may not post. */
export function noPostingTitle() {
  return `this ${current.label} login cannot post on this repository`
}

/** @param {string} author */
export function authorProfileUrl(author) {
  return `${current.webBase}/${author}`
}
