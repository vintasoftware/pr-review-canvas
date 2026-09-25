// @vitest-environment node
import { printUsage } from './help.js'
import { createFakeTerminal } from './testing/fakes.js'

function render(columns: number): string[] {
  const terminal = createFakeTerminal(columns)
  printUsage(terminal.output, '0.5.0')
  return terminal.text().split('\n')
}

const WHOLE = [
  '--fixture-canvas <review.json>',
  '--no-open',
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
  it.each([80, 48, 100])('keeps every flag whole at %i columns', columns => {
    const lines = render(columns)
    expect(lines.every(line => line.length <= columns)).toBe(true)
    for (const token of WHOLE) {
      expect(
        lines.some(line => line.includes(token)),
        token
      ).toBe(true)
    }
  })
})
