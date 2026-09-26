// @ts-check
// Error cards for the review page, keyed by the server's error code. Each card says what happened,
// what to do, and offers a retry. Every code in the server's list has one; errors.test.js checks
// that, so a new code cannot ship without its card.
/** @typedef {import('./contract-types.js').ErrorEnvelope} ErrorEnvelope */
import { esc } from './dom.js'

/** @typedef {{ title: string, action: string }} ErrorCard */

/** @type {ErrorCard} */
const FALLBACK = {
  title: 'Something went wrong',
  action: 'Retry. If it keeps failing, check the server log in the terminal running pr-review.',
}

/** @type {Record<string, ErrorCard>} */
export const ERROR_CARDS = {
  BAD_REQUEST: {
    title: 'The page asked for something the server could not read',
    action: 'Check the URL. If you got here from a link inside the page, retry and report it.',
  },
  NOT_FOUND: {
    title: 'Not found',
    action: 'Retry. A missing diff usually means the PR head is not in this clone yet.',
  },
  FORBIDDEN_HOST: {
    title: 'This server only answers to localhost',
    action: 'Open the page as http://localhost:3010 or http://127.0.0.1:3010.',
  },
  CROSS_ORIGIN: {
    title: 'The request did not come from this page',
    action: 'Reload the page and try again. Do not drive this server from another site.',
  },
  NOT_A_REPO: {
    title: 'Not a git repository',
    action: 'Start pr-review from a clone, or pass --repo <dir>.',
  },
  NO_ORIGIN: {
    title: 'No GitHub or GitLab origin',
    action: 'Add an origin remote that points at github.com or GitLab, then restart the server.',
  },
  GIT_ERROR: {
    title: 'A git command failed',
    action: 'Check the message, then retry. Fetching the PR head by hand often clears it.',
  },
  GH_MISSING: {
    title: 'GitHub CLI is not installed',
    action: 'Install gh from https://cli.github.com and log in, then retry.',
  },
  GH_UNAUTHENTICATED: {
    title: 'GitHub CLI is not logged in',
    action: 'Run gh auth login in a terminal, then retry.',
  },
  GITHUB_API_ERROR: {
    title: 'GitHub refused the request',
    action: 'Retry in a moment. A rate limit or an outage both read like this.',
  },
  GLAB_MISSING: {
    title: 'GitLab CLI is not installed',
    action: 'Install glab from https://gitlab.com/gitlab-org/cli and log in, then retry.',
  },
  GLAB_UNAUTHENTICATED: {
    title: 'GitLab CLI is not logged in',
    action: 'Run glab auth login in a terminal, then retry.',
  },
  GITLAB_API_ERROR: {
    title: 'GitLab refused the request',
    action: 'Retry in a moment. A rate limit or an outage both read like this.',
  },
  PR_NOT_FOUND: {
    title: 'Pull request not found',
    action: 'Check the number, and that this clone’s origin is the right repository.',
  },
  CANVAS_NOT_FOUND: {
    title: 'No canvas for this pull request',
    action: 'Generate one with the pr-review-canvas skill, or import a zip a teammate attached.',
  },
  CANVAS_INVALID: {
    title: 'That canvas could not be read',
    action: 'Generate the canvas again for the current head, or import another zip.',
  },
  CANVAS_REPO_MISMATCH: {
    title: 'That canvas belongs to another repository',
    action: 'Import a canvas exported from this repository.',
  },
  CANVAS_PR_MISMATCH: {
    title: 'That canvas belongs to another pull request',
    action: 'Import the canvas exported for this PR, or generate one for it with the skill.',
  },
  CANVAS_TOO_LARGE: {
    title: 'That canvas is too large',
    action: 'A canvas zip holds two JSON files and stays under 20 MB. Export it again.',
  },
  CANVAS_STALE: {
    title: 'The pull request moved on',
    action: 'Reload the page: the head commit changed since this page was drawn.',
  },
  MODEL_INVALID: {
    title: 'The generated canvas did not pass validation',
    action: 'Run the pr-review-canvas skill again; it prints one line per problem.',
  },
  DECK_NOT_FOUND: {
    title: 'No self-review deck yet',
    action: 'Run /pr-self-review branch or /pr-self-review uncommitted to generate one.',
  },
  DECK_INVALID: {
    title: 'The generated deck did not pass validation',
    action: 'Run the pr-self-review skill again; it prints one line per problem.',
  },
  DECK_STALE: {
    title: 'The deck is for another head',
    action: 'Reload the page: the deck was regenerated since this page was drawn.',
  },
  SKILL_DIR_EXISTS: {
    title: 'The skill directory is already taken',
    action: 'Remove it, or run pr-review install-skill --force.',
  },
  COMMENT_FORBIDDEN: {
    title: 'This login cannot post here',
    action: 'Check the account’s repository access and token permissions, then retry.',
  },
  COMMENT_LINE_NOT_IN_DIFF: {
    title: 'Comments must sit on lines the diff shows',
    action: 'Pick a line inside a chunk of this pull request.',
  },
  SIGNOFF_INCOMPLETE: {
    title: 'Some layers are not reviewed yet',
    action: 'Mark every layer outside Other as reviewed, then approve.',
  },
  CHAT_BUSY: {
    title: 'The chat is answering another message',
    action: 'Wait for the answer, or stop it, then send again.',
  },
  NOT_IMPLEMENTED: {
    title: 'That part is not built yet',
    action: 'Nothing to do here; the feature is not in this version.',
  },
  INTERNAL: FALLBACK,
}

/**
 * @param {ErrorEnvelope['error']} error
 * @returns {ErrorCard}
 */
export function errorCardFor(error) {
  return ERROR_CARDS[error.code] ?? FALLBACK
}

/**
 * @param {ErrorEnvelope['error']} error
 * @returns {string}
 */
export function errorCardHtml(error) {
  const card = errorCardFor(error)
  return (
    '<main id="main" class="home">' +
    `<section class="panel error-card" data-code="${esc(error.code)}" aria-labelledby="err-h">` +
    `<div class="panel-h"><h2 id="err-h">${esc(card.title)} <span class="mono muted">${esc(error.code)}</span></h2></div>` +
    `<div class="body"><p>${esc(error.message)}</p>${error.hint ? `<p class="muted">${esc(error.hint)}</p>` : ''}` +
    `<p>${esc(card.action)}</p>` +
    '<p><button class="cmd fill" type="button" id="retry">retry</button></p></div></section></main>'
  )
}
