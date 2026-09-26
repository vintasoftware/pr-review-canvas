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

describe('pr-review <command> --help', () => {
  function renderFor(command: string): string {
    const terminal = createFakeTerminal(80)
    printUsage(terminal.output, '0.5.0', command)
    return terminal.text()
  }

  it("prints the command's block with the shared flags, and leaves the other commands out", () => {
    const text = renderFor('serve')
    expect(text).toContain('pr-review serve [flags]')
    expect(text).toContain('--chat-agent claude|codex')
    expect(text).toContain('--repo <dir>')
    expect(text).toContain('Exit codes')
    expect(text).not.toContain('--allow-stale')
    expect(text).not.toContain('--claude-dir')
  })

  it('names the positional argument of a command that takes one', () => {
    expect(renderFor('validate')).toContain('pr-review validate <model.json|review.json> [flags]')
  })

  it('prints the whole page for a word that names no command', () => {
    expect(renderFor('nope')).toContain('pr-review <command> [flags]')
  })
})
