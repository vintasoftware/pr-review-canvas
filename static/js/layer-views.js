// @ts-check
// The values of the `layerView` setting. They live apart from the page code that acts on them,
// in `one-layer.js`, because the server validates the settings file against this list.

export const LAYER_VIEWS = /** @type {const} */ (['all', 'one'])
/** @typedef {(typeof LAYER_VIEWS)[number]} LayerView */

/** How the page shows layers when the settings file says nothing: the canvas as one page. */
export const DEFAULT_LAYER_VIEW = /** @type {LayerView} */ ('all')

/** What the settings dialog calls each view. */
export const LAYER_VIEW_LABELS = /** @type {Readonly<Record<LayerView, string>>} */ ({
  all: 'all at once',
  one: 'one at a time',
})

/**
 * @param {unknown} value
 * @returns {value is LayerView}
 */
export function isLayerView(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (LAYER_VIEWS).includes(value)
}
