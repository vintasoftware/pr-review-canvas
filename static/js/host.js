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

/**
 * A file at a commit on the forge, scrolled to a line when one is given.
 * @param {{ owner: string, name: string }} repo
 * @param {string} sha
 * @param {string} path
 * @param {number} [line]
 */
export function fileUrl(repo, sha, path, line) {
  const blob = current.kind === 'gitlab' ? '-/blob' : 'blob'
  const file = path.split('/').map(encodeURIComponent).join('/')
  return `${current.webBase}/${repo.owner}/${repo.name}/${blob}/${sha}/${file}${line === undefined ? '' : `#L${line}`}`
}
