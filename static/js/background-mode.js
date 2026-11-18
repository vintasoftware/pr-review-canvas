// @ts-check
import { isAuthor } from './host.js'

export const BACKGROUND_MODES = /** @type {const} */ (['off', 'others', 'all'])
/** @typedef {(typeof BACKGROUND_MODES)[number]} BackgroundMode */

export const BACKGROUND_LABELS = {
  off: 'Off by default',
  others: 'Open except on my PRs',
  all: 'Open for all PRs',
}

/**
 * @param {string} value
 * @returns {value is BackgroundMode}
 */
export function isBackgroundMode(value) {
  return /** @type {readonly string[]} */ (BACKGROUND_MODES).includes(value)
}

/**
 * @param {BackgroundMode} mode
 * @param {Pick<import('./contract-types.js').PrBundle, 'local' | 'capabilities' | 'pr'>} bundle
 */
export function opensBackground(mode, { local, capabilities, pr }) {
  return (
    mode === 'all' ||
    (mode === 'others' &&
      local === undefined &&
      capabilities.login !== null &&
      !isAuthor(capabilities.login, pr))
  )
}
