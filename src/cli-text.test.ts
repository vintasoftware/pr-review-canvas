// @vitest-environment node
import { contentWidth, visibleText, wrapParagraph } from './cli-text.js'

describe('wrapParagraph', () => {
  it('breaks on spaces and keeps a flag in one piece', () => {
    expect(wrapParagraph('publish --allow-stale now', 16)).toEqual(['publish', '--allow-stale', 'now'])
  })

  it('keeps a backticked command together', () => {
    expect(wrapParagraph('run `pr-review install-skill` now', 24)).toEqual([
      'run',
      '`pr-review install-skill`',
      'now',
    ])
  })

  it('returns nothing for blank text', () => {
    expect(wrapParagraph('   ', 40)).toEqual([])
  })
})

describe('contentWidth', () => {
  it('reserves the guide and refuses a column too narrow for a flag', () => {
    expect(contentWidth(80)).toBe(77)
    expect(contentWidth(20)).toBe(40)
  })
})

describe('visibleText', () => {
  it('drops color codes and leaves the words', () => {
    const colored = `${String.fromCharCode(0x1b)}[1mserve${String.fromCharCode(0x1b)}[22m`
    expect(visibleText(colored)).toBe('serve')
  })
})
