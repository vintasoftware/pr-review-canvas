// @ts-check
// The bar every page starts with: the wordmark, which leads to the list of every project the server
// serves; next to it the project's name, which leads to its home page, or where the page is served
// from on a page of the server's own; then the page's own commands, and the skin and theme commands
// last. The server draws it on its pages and the review page draws it in the browser, from this
// one module, so every page has the same header.
import { esc } from './dom.js'
import { skinLabel } from './skin.js'
import { themeLabel } from './theme.js'

/**
 * @typedef {{ slug: string, home: string, reopenIn?: string | undefined }} ProjectLink The project's
 *   name and home page; `reopenIn` is its folder when it runs under the server's environment
 *   rather than the shell's that opened it.
 */

/**
 * @typedef {{
 *   host?: string | undefined,
 *   project?: ProjectLink | undefined,
 *   theme: import('./theme.js').Theme,
 *   skin: import('./skin.js').Skin,
 * }} BarOptions
 */

const BRAND_HTML =
  '<a class="brand-wordmark" href="/" title="All projects"><img class="brand-icon" src="/static/brand.svg" width="32" height="32" alt="">PR review canvas</a>'

export const ENV_DIALOG_ID = 'env-dialog'

/**
 * A project the server built again after a restart runs git, the host CLI, and the agent under the
 * server's environment. That is usually the terminal's too, so the header only wears a badge next
 * to the project's name; it opens a dialog that says what can differ and how to give the project
 * its terminal's back. The page works as it is meanwhile.
 * @param {ProjectLink} project
 * @returns {string}
 */
function envBadgeHtml(project) {
  if (project.reopenIn === undefined) {
    return ''
  }
  return `<button class="pill env-badge" type="button" data-env-help aria-haspopup="dialog" title="This project uses the server's environment since the restart">server env</button>`
}

/**
 * The folder, quoted for a POSIX shell.
 * @param {string} folder
 * @returns {string}
 */
function shellQuote(folder) {
  return `'${folder.replace(/'/g, `'\\''`)}'`
}

/**
 * @param {BarOptions} opts
 * @returns {string}
 */
function envDialogHtml(opts) {
  const folder = opts.project?.reopenIn
  if (folder === undefined) {
    return ''
  }
  const command = `cd ${shellQuote(folder)} && pr-review open`
  return (
    `<dialog id="${ENV_DIALOG_ID}" class="env" aria-labelledby="env-h"><form method="dialog">` +
    `<h2 id="env-h">Running with the server's environment</h2>` +
    '<p>After a restart, git, the GitHub or GitLab CLI, and the chat agent run with the environment of the terminal that started the server. That is usually the same as yours.</p>' +
    '<div><p>It differs only if your terminal sets something for this project alone:</p>' +
    '<ul><li>A token for another account: comments may post as that account.</li>' +
    '<li>Its own <code>PATH</code>: the chat agent or the CLI may not be found.</li></ul></div>' +
    "<div><p>To use this project's terminal environment again, run:</p>" +
    `<div class="cmdbox"><code>${esc(command)}</code><button class="cmd" type="button" data-copy="${esc(command)}">copy</button></div></div>` +
    '<div class="dialog-actions"><button class="cmd" type="submit" value="close" autofocus>close</button></div>' +
    '</form></dialog>'
  )
}

/**
 * @param {BarOptions} opts
 * @returns {string}
 */
function contextHtml(opts) {
  if (opts.project !== undefined) {
    return `<a class="mono muted" href="${esc(opts.project.home)}" title="This project's home page">${esc(opts.project.slug)}</a>${envBadgeHtml(opts.project)}`
  }
  return opts.host === undefined ? '' : `<span class="mono muted">${esc(opts.host)}</span>`
}

const ENV_WIRED = new WeakSet()

/**
 * One delegated click handler per root, so the badge opens its dialog however often the header
 * under the root is drawn again. Calling it again for the same root does nothing.
 * @param {HTMLElement} root
 */
export function wireEnvBadge(root) {
  if (ENV_WIRED.has(root)) {
    return
  }
  ENV_WIRED.add(root)
  root.addEventListener('click', event => {
    if (!(event.target instanceof Element) || event.target.closest('[data-env-help]') === null) {
      return
    }
    const dialog = root.querySelector(`#${ENV_DIALOG_ID}`)
    if (dialog instanceof HTMLDialogElement && !dialog.open) {
      dialog.showModal()
    }
  })
}

/**
 * @param {BarOptions} opts
 * @param {string} [commands] the page's own commands, already HTML
 * @returns {string}
 */
export function headerBarHtml(opts, commands = '') {
  return (
    `<div class="hdr-bar"><div class="brand">${BRAND_HTML}${contextHtml(opts)}</div>` +
    '<div class="hdr-actions" role="group" aria-label="Page actions">' +
    commands +
    `<button class="cmd" type="button" id="skin-toggle" title="Switch between Terminal, GitHub, and Olive styling">${esc(skinLabel(opts.skin))}</button>` +
    `<button class="cmd" type="button" id="theme-toggle" title="Switch between Light, Dark, and Auto themes">${esc(themeLabel(opts.theme))}</button>` +
    '</div></div>' +
    envDialogHtml(opts)
  )
}
