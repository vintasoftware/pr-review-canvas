// @ts-check
// The values of the `pointColors` setting, and the attribute on <html> that paints the level icons
// of attention points. The shapes say the level in every palette; the palette only colors them.
// The values live here, apart from the styles, because the server validates the settings file
// against this list.

export const POINT_COLORS = /** @type {const} */ (['classic', 'action'])
/** @typedef {(typeof POINT_COLORS)[number]} PointColors */

/** Red, amber, and gray, the colors points had before the palette became a setting. */
export const DEFAULT_POINT_COLORS = /** @type {PointColors} */ ('classic')

/** What the settings dialog calls each palette. */
export const POINT_COLORS_LABELS = /** @type {Readonly<Record<PointColors, string>>} */ ({
  classic: 'classic: red, amber, gray',
  action: 'action: purple, blue, gray',
})

/**
 * @param {unknown} value
 * @returns {value is PointColors}
 */
export function isPointColors(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (POINT_COLORS).includes(value)
}

/**
 * Repaints the level icons on the page.
 * @param {PointColors} colors
 * @param {HTMLElement} root usually document.documentElement
 */
export function applyPointColors(colors, root) {
  root.setAttribute('data-point-colors', colors)
}
