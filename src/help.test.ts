// @vitest-environment node
import { Writable } from 'node:stream'
import { visibleText } from './cli-text.js'
import { printUsage } from './help.js'

function render(columns: number): string[] {
  let text = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk)
      callback()
    },
  })
  printUsage(output, columns, '0.5.0')
  return visibleText(text).split('\n')
}

const WHOLE = [
  '--fixture-canvas <review.json>',
  '--harness claude-code|codex|other',
  '--base <ref> --head <ref>',
  '--allow-stale',
  '--json',
  '{ "error": { code, message, hint } }',
  '/review/uncommitted',
  'install-skill',
  'pr-review 0.5.0',
]

describe('pr-review --help', () => {
  it('names the command without a version when none is passed', () => {
    let text = ''
    const output = new Writable({
      write(chunk, _encoding, callback) {
        text += String(chunk)
        callback()
      },
    })
    printUsage(output, 80)
    const page = visibleText(text)
    expect(page).toContain('pr-review')
    expect(page).not.toContain('0.5.0')
  })

  it.each([80, 48, 100])('keeps every flag whole at %i columns', columns => {
    const lines = render(columns)
    expect(lines.every(line => line.length <= columns)).toBe(true)
    const page = lines.join('\n')
    for (const token of WHOLE) {
      expect(
        lines.some(line => line.includes(token)),
        token
      ).toBe(true)
      expect(page).toContain(token)
    }
  })
})
