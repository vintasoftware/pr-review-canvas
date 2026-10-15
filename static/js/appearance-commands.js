// @ts-check
// The skin and theme commands of the header, on every page. Each repaints the page under the
// click, from the look `<html>` wears, and saves the choice where the page's look lives; the page
// says how a save turned out, since the next load would come back in the old look after a failed one.
import { saveAppearance } from './api.js'
import { applySkin, nextSkin, readSkin, skinLabel } from './skin.js'
import { applyTheme, nextTheme, readTheme, themeLabel } from './theme.js'

/**
 * @typedef {(what: 'skin' | 'theme', saved: boolean, button: HTMLElement) => void} SaveReport
 */

/**
 * @param {ParentNode} scope where the header's commands are
 * @param {SaveReport} report
 */
export function wireAppearanceCommands(scope, report) {
  const root = document.documentElement
  const theme = scope.querySelector('#theme-toggle')
  if (theme instanceof HTMLElement) {
    theme.addEventListener('click', () => {
      const next = nextTheme(readTheme(root))
      applyTheme(next, root)
      theme.textContent = themeLabel(next)
      void saveAppearance({ theme: next }).then(
        () => report('theme', true, theme),
        () => report('theme', false, theme)
      )
    })
  }
  const skin = scope.querySelector('#skin-toggle')
  if (skin instanceof HTMLElement) {
    skin.addEventListener('click', () => {
      const next = nextSkin(readSkin(root))
      applySkin(next, root)
      skin.textContent = skinLabel(next)
      void saveAppearance({ skin: next }).then(
        () => report('skin', true, skin),
        () => report('skin', false, skin)
      )
    })
  }
}
