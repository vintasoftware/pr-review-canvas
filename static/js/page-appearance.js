// @ts-check
// The skin and theme commands of the pages that load no app: the project list, a project's home
// page, and the error pages. The commands are the header's own (see appearance-commands.js); these
// pages have no toast, so a failed save says so in the command's title.
import { setApiBase } from './api.js'
import { wireAppearanceCommands } from './appearance-commands.js'

/**
 * The page's base path from its bootstrap, where its API lives; the server root when it has none.
 * @param {Document} doc
 * @returns {string}
 */
function baseOf(doc) {
  try {
    const bootstrap = JSON.parse(doc.getElementById('bootstrap')?.textContent ?? '{}')
    return typeof bootstrap.base === 'string' ? bootstrap.base : '/'
  } catch {
    return '/'
  }
}

/** @param {Document} doc */
export function wireAppearance(doc) {
  setApiBase(baseOf(doc))
  wireAppearanceCommands(doc, (what, saved, button) => {
    if (saved) {
      button.removeAttribute('data-save-failed')
      return
    }
    button.setAttribute('data-save-failed', '')
    button.title = `Could not save the ${what}; it applies to this page only`
  })
}

if (typeof document !== 'undefined' && document.getElementById('bootstrap') !== null) {
  wireAppearance(document)
}
