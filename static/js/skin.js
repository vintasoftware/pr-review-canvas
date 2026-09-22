// @ts-check
// The skin command cycles terminal → github. `data-skin` on <html> says which look the page wears:
// the component styles are written in the terminal skin, and `styles/skin-github.css` repaints them
// for github. It is independent of the light/dark theme, so each of the four pairings works.
//
// The choice is saved in `.pr-review/settings.yml`, so it holds for every browser that opens this
// server and can be edited by hand. The server renders `data-skin` into the page, which is why this
// module reads the attribute instead of storage and never has to guess before the styles apply.

export const SKINS = /** @type {const} */ (['terminal', 'github'])
/** @typedef {(typeof SKINS)[number]} Skin */

/** The look a page wears when the settings file says nothing. */
export const DEFAULT_SKIN = /** @type {Skin} */ ('github')

/**
 * @param {unknown} value
 * @returns {value is Skin}
 */
export function isSkin(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (SKINS).includes(value)
}

/**
 * The skin the page is wearing, from the attribute the server rendered.
 * @param {HTMLElement} root usually document.documentElement
 * @returns {Skin}
 */
export function readSkin(root) {
  const attribute = root.getAttribute('data-skin')
  return isSkin(attribute) ? attribute : DEFAULT_SKIN
}

/**
 * @param {Skin} skin
 * @returns {Skin}
 */
export function nextSkin(skin) {
  const next = SKINS[SKINS.indexOf(skin) + 1]
  return next ?? SKINS[0]
}

/**
 * Repaints the page. Saving is the caller's job, so the look changes under the click whether or
 * not the server answers.
 * @param {Skin} skin
 * @param {HTMLElement} root usually document.documentElement
 */
export function applySkin(skin, root) {
  root.setAttribute('data-skin', skin)
}

/** @param {Skin} skin */
export function skinLabel(skin) {
  return `skin: ${skin}`
}
