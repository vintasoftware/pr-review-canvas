// @ts-check
// The reason the author cannot approve or request changes. It has no DOM imports, so the server can
// import it too.

/**
 * @param {string} noun `pull request` or `merge request`, as the host names it
 * @returns {string}
 */
export function authorSignOffReason(noun) {
  return `You opened this ${noun}. Sign-off comes from another reviewer.`
}
