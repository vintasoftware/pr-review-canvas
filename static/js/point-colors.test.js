// @ts-check
// @vitest-environment happy-dom
import { applyPointColors, DEFAULT_POINT_COLORS, isPointColors, POINT_COLORS } from './point-colors.js'

describe('point colors', () => {
  it('keeps the classic palette by default and knows the names it accepts', () => {
    expect(POINT_COLORS).toEqual(['classic', 'action'])
    expect(DEFAULT_POINT_COLORS).toBe('classic')
    expect(isPointColors('action')).toBe(true)
    expect(isPointColors('neon')).toBe(false)
    expect(isPointColors(null)).toBe(false)
  })

  it('repaints the point icons by writing the attribute', () => {
    const root = document.documentElement
    applyPointColors('action', root)
    expect(root.getAttribute('data-point-colors')).toBe('action')
    applyPointColors('classic', root)
    expect(root.getAttribute('data-point-colors')).toBe('classic')
    root.removeAttribute('data-point-colors')
  })
})
