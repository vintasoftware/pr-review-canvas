// @ts-check
// The theme command cycles auto → light → dark. `data-theme` on <html> says which one the page
// wears; `auto` follows the operating system, which is what the `color-scheme: light dark` on
// :root already does, so no rule matches that value and none has to.
//
// The choice is saved in `.pr-review/settings.yml` next to the skin, so it holds for every browser
// that opens this server. The server renders `data-theme` into the page, which is why this module
// reads the attribute instead of storage and no theme ever flashes before the styles apply.

export const THEMES = /** @type {const} */ (['auto', 'light', 'dark'])
/** @typedef {(typeof THEMES)[number]} Theme */

/** The theme a page wears when the settings file says nothing. */
export const DEFAULT_THEME = /** @type {Theme} */ ('auto')

/**
 * @param {unknown} value
 * @returns {value is Theme}
 */
export function isTheme(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (THEMES).includes(value)
}

/**
 * The theme the page is wearing, from the attribute the server rendered.
 * @param {HTMLElement} root usually document.documentElement
 * @returns {Theme}
 */
export function readTheme(root) {
  const attribute = root.getAttribute('data-theme')
  return isTheme(attribute) ? attribute : DEFAULT_THEME
}

/**
 * @param {Theme} theme
 * @returns {Theme}
 */
export function nextTheme(theme) {
  const next = THEMES[THEMES.indexOf(theme) + 1]
  return next ?? DEFAULT_THEME
}

/**
 * Repaints the page. Saving is the caller's job, so the theme changes under the click whether or
 * not the server answers.
 * @param {Theme} theme
 * @param {HTMLElement} root usually document.documentElement
 */
export function applyTheme(theme, root) {
  root.setAttribute('data-theme', theme)
}

/** @param {Theme} theme */
export function themeLabel(theme) {
  return `theme: ${theme}`
}
