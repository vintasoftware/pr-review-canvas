// @ts-check
// Handing a file to the browser. The export command fetches the zip itself, so it can show a
// pending state and an error; this module only does the save at the end.
import { fetchCanvasZip } from './api.js'

/**
 * @typedef {{ doc?: Document, urls?: { createObjectURL: (b: Blob) => string, revokeObjectURL: (u: string) => void } }} SaveDeps
 */

/**
 * @param {Blob} blob
 * @param {string} filename
 * @param {SaveDeps} [deps]
 */
export function saveBlob(blob, filename, deps = {}) {
  const doc = deps.doc ?? document
  const urls = deps.urls ?? URL
  const href = urls.createObjectURL(blob)
  const link = doc.createElement('a')
  link.href = href
  link.download = filename
  doc.body.appendChild(link)
  link.click()
  link.remove()
  urls.revokeObjectURL(href)
}

/**
 * @param {number} prNumber
 * @param {{ headSha?: string, fetchImpl?: typeof fetch } & SaveDeps} [opts]
 * @returns {Promise<string>} the file name the browser saved
 */
export async function exportCanvasZip(prNumber, opts = {}) {
  /** @type {{ headSha?: string, fetchImpl?: typeof fetch }} */
  const request = {}
  if (opts.headSha !== undefined) {
    request.headSha = opts.headSha
  }
  if (opts.fetchImpl !== undefined) {
    request.fetchImpl = opts.fetchImpl
  }
  const { blob, filename } = await fetchCanvasZip(prNumber, request)
  const deps = {}
  if (opts.doc !== undefined) {
    deps.doc = opts.doc
  }
  if (opts.urls !== undefined) {
    deps.urls = opts.urls
  }
  saveBlob(blob, filename, deps)
  return filename
}
