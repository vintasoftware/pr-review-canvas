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
import { diffLayoutToggleHtml, initLayoutSwitch, TOO_NARROW } from './layout-switch.js'

/** @param {number} width */
function page(width) {
  document.body.innerHTML = `${diffLayoutToggleHtml()}<main></main>`
  const main = document.querySelector('main')
  if (main === null) throw new Error('no main')
  Object.defineProperty(main, 'clientWidth', { configurable: true, value: width })
  return main
}

const button = () => /** @type {HTMLButtonElement} */ (document.querySelector('#diff-layout-toggle'))

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
  it('draws the chosen layout where it fits, and names it on the button', () => {
    page(SPLIT_MIN_WIDTH)
    setChosenDiffLayout('split')
    const relayout = vi.fn(layout => setDrawnDiffLayout(layout))
    const sw = initLayoutSwitch(document, relayout)
    expect(relayout).toHaveBeenCalledWith('split')
    expect([button().textContent, button().getAttribute('data-layout'), button().disabled]).toEqual([
      'layout: split',
      'split',
      false,
    ])
    expect(button().title).toBe('Diff layout: split. Switch to unified (s); the choice is saved')
    expect(sw.fits()).toBe(true)
    // Nothing to draw again while the layout holds.
    sw.apply()
    expect(relayout).toHaveBeenCalledTimes(1)
    sw.stop()
  })

  it('falls back to unified in a narrow column and disables the button, saying why', () => {
    const main = page(SPLIT_MIN_WIDTH)
    setChosenDiffLayout('split')
    const relayout = vi.fn(layout => setDrawnDiffLayout(layout))
    const sw = initLayoutSwitch(document, relayout)
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: SPLIT_MIN_WIDTH - 1 })
    sw.apply()
    expect(relayout).toHaveBeenLastCalledWith('unified')
    expect(chosenDiffLayout()).toBe('split')
    expect(button().disabled).toBe(true)
    expect(button().title).toBe(`Diff layout: unified; ${TOO_NARROW}`)
    expect(button().textContent).toBe('layout: unified')
    // Wide again, split comes back on its own.
    Object.defineProperty(main, 'clientWidth', { configurable: true, value: SPLIT_MIN_WIDTH })
    sw.apply()
    expect(drawnDiffLayout()).toBe('split')
    expect(button().disabled).toBe(false)
    sw.stop()
  })
})
