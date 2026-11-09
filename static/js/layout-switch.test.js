// @ts-check
// @vitest-environment happy-dom
import {
  chosenDiffLayout,
  diffColumns,
  drawnDiffLayout,
  isDiffLayout,
  layoutForWidth,
  setChosenDiffLayout,
  setDrawnDiffLayout,
  SPLIT_MIN_WIDTH,
} from './diff-layouts.js'
import { diffLayoutControlHtml, initLayoutSwitch, TOO_NARROW } from './layout-switch.js'

/** @param {number} width */
function page(width) {
  document.body.innerHTML = `${diffLayoutControlHtml('unified')}<main></main>`
  const main = document.querySelector('main')
  if (main === null) throw new Error('no main')
  Object.defineProperty(main, 'clientWidth', { configurable: true, value: width })
  return main
}

/** @param {string} layout */
const button = layout =>
  /** @type {HTMLButtonElement} */ (document.querySelector(`[data-layout="${layout}"]`))

afterEach(() => {
  setChosenDiffLayout('unified')
  setDrawnDiffLayout('unified')
})

describe('diff layouts', () => {
  it('knows its values and draws split only in a column wide enough', () => {
    expect([isDiffLayout('split'), isDiffLayout('unified'), isDiffLayout('side'), isDiffLayout(1)]).toEqual([
      true,
      true,
      false,
      false,
    ])
    expect(layoutForWidth('split', SPLIT_MIN_WIDTH)).toBe('split')
    expect(layoutForWidth('split', SPLIT_MIN_WIDTH - 1)).toBe('unified')
    expect(layoutForWidth('unified', 4000)).toBe('unified')
  })

  it('counts the columns of the drawn layout', () => {
    expect(diffColumns()).toBe(4)
    setDrawnDiffLayout('split')
    expect(diffColumns()).toBe(6)
  })
})

describe('initLayoutSwitch', () => {
  it('draws the chosen layout where it fits, and presses the button of the one on screen', () => {
    page(SPLIT_MIN_WIDTH)
    setChosenDiffLayout('split')
    const relayout = vi.fn(layout => setDrawnDiffLayout(layout))
    const sw = initLayoutSwitch(document, relayout)
    expect(relayout).toHaveBeenCalledWith('split')
    expect([
      button('unified').getAttribute('aria-pressed'),
      button('split').getAttribute('aria-pressed'),
    ]).toEqual(['false', 'true'])
    expect(sw.fits()).toBe(true)
    // Nothing to draw again while the layout holds.
    sw.apply()
    expect(relayout).toHaveBeenCalledTimes(1)
    sw.stop()
  })

  it('falls back to unified in a narrow column and disables split, saying why', () => {
    const main = page(SPLIT_MIN_WIDTH)
    setChosenDiffLayout('split')
    const relayout = vi.fn(layout => setDrawnDiffLayout(layout))
    const sw = initLayoutSwitch(document, relayout)
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: SPLIT_MIN_WIDTH - 1 })
    sw.apply()
    expect(relayout).toHaveBeenLastCalledWith('unified')
    expect(chosenDiffLayout()).toBe('split')
    expect(button('split').disabled).toBe(true)
    expect(button('split').title).toBe(TOO_NARROW)
    expect(button('unified').getAttribute('aria-pressed')).toBe('true')
    // Wide again, split comes back on its own.
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: SPLIT_MIN_WIDTH })
    sw.apply()
    expect(drawnDiffLayout()).toBe('split')
    expect(button('split').disabled).toBe(false)
    sw.stop()
  })
})
