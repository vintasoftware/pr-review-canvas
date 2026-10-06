// @ts-check
// The bar every page starts with: the wordmark, which leads to the list of every project the server
// serves; next to it the project's name, which leads to its home page, or where the page is served
// from on a page of the server's own; then the page's own commands, and the skin and theme commands
// last. The server draws it on its pages and the review page draws it in the browser, from this
// one module, so every page has the same header.
import { esc } from './dom.js'
import { skinLabel } from './skin.js'
import { themeLabel } from './theme.js'

/** @typedef {{ slug: string, home: string }} ProjectLink The project's name and home page. */

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

/**
 * @param {BarOptions} opts
 * @returns {string}
 */
function contextHtml(opts) {
  if (opts.project !== undefined) {
    return `<a class="mono muted" href="${esc(opts.project.home)}" title="This project's home page">${esc(opts.project.slug)}</a>`
  }
  return opts.host === undefined ? '' : `<span class="mono muted">${esc(opts.host)}</span>`
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
    '</div></div>'
  )
}
