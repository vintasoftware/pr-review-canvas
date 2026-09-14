// @ts-check
// @vitest-environment happy-dom
import { applyTheme, DEFAULT_THEME, isTheme, nextTheme, readTheme, THEMES, themeLabel } from './theme.js'

describe('theme', () => {
  it('cycles auto → light → dark → auto', () => {
    expect(THEMES).toEqual(['auto', 'light', 'dark'])
    expect(DEFAULT_THEME).toBe('auto')
    expect(nextTheme('auto')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('auto')
    expect(themeLabel('dark')).toBe('theme: dark')
  })

  it('knows the names it accepts', () => {
    expect(isTheme('auto')).toBe(true)
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('sepia')).toBe(false)
    expect(isTheme(null)).toBe(false)
  })

  it('reads the theme from the attribute the server rendered, and falls back when it is missing', () => {
    const root = document.documentElement
    root.setAttribute('data-theme', 'dark')
    expect(readTheme(root)).toBe('dark')
    root.setAttribute('data-theme', 'sepia')
    expect(readTheme(root)).toBe('auto')
    root.removeAttribute('data-theme')
    expect(readTheme(root)).toBe('auto')
  })

  it('repaints the page by writing the attribute, auto included', () => {
    const root = document.documentElement
    applyTheme('light', root)
    expect(root.getAttribute('data-theme')).toBe('light')
    // `auto` is written too: no rule matches it, so :root's own `color-scheme: light dark` stands.
    applyTheme('auto', root)
    expect(root.getAttribute('data-theme')).toBe('auto')
    root.removeAttribute('data-theme')
  })
})
