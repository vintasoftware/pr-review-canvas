import { describe, expect, it } from 'vitest'
import { latestModel } from './models.js'

/** The links `codex debug models` reported on 2026-09-22: the mid tier changed its name. */
const CODEX = new Map([
  ['gpt-5.5', 'gpt-5.6-sol'],
  ['gpt-5.6-sol', 'gpt-6-sol'],
  ['gpt-5.6-terra', 'gpt-6-sol'],
  ['gpt-5.6-luna', 'gpt-6-luna'],
])

describe('latestModel', () => {
  it.each([
    ['claude-opus-4-8', 'opus'],
    ['claude-opus-5[1m]', 'opus[1m]'],
    ['claude-sonnet-5', 'sonnet'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-fable-5-1', 'fable'],
    ['Claude-Opus-4-1', 'opus'],
  ])('runs the versioned Claude id %s as the alias %s', (versioned, alias) => {
    expect(latestModel('claude', versioned, new Map())).toBe(alias)
  })

  it.each([
    'opus',
    'sonnet[1m]',
    'default',
    'us.anthropic.claude-opus-4-8-v1:0',
    'claude-opus-4-8@20260801',
    'claude-next',
  ])('leaves the Claude id %s as it is', id => {
    expect(latestModel('claude', id, new Map())).toBe(id)
  })

  it('follows the Codex upgrade links to the end, across a rename', () => {
    expect(latestModel('codex', 'gpt-5.5', CODEX)).toBe('gpt-6-sol')
    expect(latestModel('codex', 'gpt-5.6-terra', CODEX)).toBe('gpt-6-sol')
  })

  it('keeps the effort suffix on the upgraded model', () => {
    expect(latestModel('codex', 'gpt-5.6-luna[high]', CODEX)).toBe('gpt-6-luna[high]')
  })

  it('leaves a current or unknown GPT model as it is', () => {
    expect(latestModel('codex', 'gpt-6-astra', CODEX)).toBe('gpt-6-astra')
    expect(latestModel('codex', 'gpt-5.2', new Map())).toBe('gpt-5.2')
  })

  it('sends a pinned id as written, for either agent', () => {
    expect(latestModel('claude', 'pin:claude-opus-4-8', new Map())).toBe('claude-opus-4-8')
    expect(latestModel('codex', 'pin: gpt-5.6-terra[high]', CODEX)).toBe('gpt-5.6-terra[high]')
  })

  it('leaves an id it cannot split into model and setting as it is', () => {
    expect(latestModel('codex', '[high]', CODEX)).toBe('[high]')
  })

  it('stops on a loop in the catalog', () => {
    expect(
      latestModel(
        'codex',
        'a',
        new Map([
          ['a', 'b'],
          ['b', 'a'],
        ])
      )
    ).toBe('b')
  })
})
