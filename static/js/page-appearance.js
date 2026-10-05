// @ts-check
// The skin and theme commands of the pages that load no app: the project list and a project's
// home page. They work as the review header's do: the page repaints under the click, and the
// choice is saved where that page's appearance lives, a project's `.pr-review/settings.yml` or
// the server's own file for the list.
import { saveAppearance, setApiBase } from './api.js'
import { applySkin, nextSkin, readSkin, skinLabel } from './skin.js'
import { applyTheme, nextTheme, readTheme, themeLabel } from './theme.js'

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

/**
 * Wires the two commands. A save that fails says so in the command's title, since the next load
 * would come back in the old look.
 * @param {Document} doc
 */
export function wireAppearance(doc) {
  setApiBase(baseOf(doc))
  const root = doc.documentElement
  /**
   * @param {HTMLElement} button
   * @param {import('./contract-types.js').AppearanceInput} input
   * @param {string} what
   */
  const save = (button, input, what) => {
    void saveAppearance(input).then(
      () => button.removeAttribute('data-save-failed'),
      () => {
        button.setAttribute('data-save-failed', '')
        button.title = `Could not save the ${what}; it applies to this page only`
      }
    )
  }
  const theme = doc.getElementById('theme-toggle')
  theme?.addEventListener('click', () => {
    const next = nextTheme(readTheme(root))
    applyTheme(next, root)
    theme.textContent = themeLabel(next)
    save(theme, { theme: next }, 'theme')
  })
  const skin = doc.getElementById('skin-toggle')
  skin?.addEventListener('click', () => {
    const next = nextSkin(readSkin(root))
    applySkin(next, root)
    skin.textContent = skinLabel(next)
    save(skin, { skin: next }, 'skin')
  })
}

if (typeof document !== 'undefined' && document.getElementById('bootstrap') !== null) {
  wireAppearance(document)
}
