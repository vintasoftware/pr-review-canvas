// @vitest-environment node
import { Writable } from 'node:stream'
import { contentWidth, streamColumns, visibleText, wrapParagraph } from './cli-text.js'

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

describe('streamColumns', () => {
  function stream(columns?: unknown): Writable {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })
    if (columns !== undefined) Object.defineProperty(output, 'columns', { value: columns })
    return output
  }

  it('reads a positive column count and falls back otherwise', () => {
    expect(streamColumns(stream(100))).toBe(100)
    expect(streamColumns(stream())).toBe(80)
    expect(streamColumns(stream('wide'))).toBe(80)
    expect(streamColumns(stream(0), 40)).toBe(40)
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
