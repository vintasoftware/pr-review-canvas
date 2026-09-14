// @ts-check
// @vitest-environment happy-dom
import { applySkin, DEFAULT_SKIN, isSkin, nextSkin, readSkin, SKINS, skinLabel } from './skin.js'

describe('skin', () => {
  it('cycles terminal → github → terminal', () => {
    expect(SKINS).toEqual(['terminal', 'github'])
    expect(DEFAULT_SKIN).toBe('terminal')
    expect(nextSkin('terminal')).toBe('github')
    expect(nextSkin('github')).toBe('terminal')
    expect(skinLabel('github')).toBe('skin: github')
  })

  it('knows the names it accepts', () => {
    expect(isSkin('terminal')).toBe(true)
    expect(isSkin('github')).toBe(true)
    expect(isSkin('neon')).toBe(false)
    expect(isSkin(null)).toBe(false)
  })

  it('reads the look from the attribute the server rendered, and falls back when it is missing', () => {
    const root = document.documentElement
    root.setAttribute('data-skin', 'github')
    expect(readSkin(root)).toBe('github')
    root.setAttribute('data-skin', 'neon')
    expect(readSkin(root)).toBe('terminal')
    root.removeAttribute('data-skin')
    expect(readSkin(root)).toBe('terminal')
  })

  it('repaints the page by writing the attribute', () => {
    const root = document.documentElement
    applySkin('github', root)
    expect(root.getAttribute('data-skin')).toBe('github')
    applySkin('terminal', root)
    expect(root.getAttribute('data-skin')).toBe('terminal')
    root.removeAttribute('data-skin')
  })
})
