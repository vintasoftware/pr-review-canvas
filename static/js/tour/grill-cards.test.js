// @ts-check
// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { readPlanBlock, readRestatementBlock, splitGrillAnswer } from './grill-cards.js'

const KEYS = new Set(['sum-over-product', 'second'])

describe('readRestatementBlock', () => {
  it('reads what, where, and unchanged, trimmed, and refuses what is missing', () => {
    expect(
      readRestatementBlock({ what: ' Multiply. ', where: ['src/app.ts', ' ', 3], unchanged: 'Callers.' })
    ).toEqual({
      restatement: { what: 'Multiply.', where: ['src/app.ts'], unchanged: 'Callers.' },
    })
    expect(readRestatementBlock(null)).toEqual({ reason: 'the block is not a JSON object' })
    expect(readRestatementBlock([])).toEqual({ reason: 'the block is not a JSON object' })
    expect(readRestatementBlock({ where: ['x'], unchanged: 'u' })).toEqual({
      reason: 'the block has no "what"',
    })
    expect(readRestatementBlock({ what: 'w', where: ['x'] })).toEqual({
      reason: 'the block has no "unchanged"',
    })
    expect(readRestatementBlock({ what: 'w', where: [], unchanged: 'u' })).toEqual({
      reason: 'the block has no "where"',
    })
    expect(readRestatementBlock({ what: 'w', where: 'x', unchanged: 'u' })).toEqual({
      reason: 'the block has no "where"',
    })
    expect(readRestatementBlock({ what: 'x'.repeat(2001), where: ['x'], unchanged: 'u' })).toEqual({
      reason: 'the block has no "what"',
    })
  })
})

describe('readPlanBlock', () => {
  it('reads the changes and the kept keys, and refuses keys this tour does not have', () => {
    const plan = readPlanBlock(
      {
        changes: [{ key: 'second', what: 'w', where: ['x'], unchanged: 'u' }],
        kept: ['sum-over-product', 7],
      },
      KEYS
    )
    expect(plan).toEqual({
      plan: {
        changes: [{ key: 'second', what: 'w', where: ['x'], unchanged: 'u' }],
        kept: ['sum-over-product'],
      },
    })
    expect(readPlanBlock('x', KEYS)).toEqual({ reason: 'the block is not a JSON object' })
    expect(readPlanBlock({ changes: [] }, KEYS)).toEqual({
      reason: 'the block needs "changes" and "kept" lists',
    })
    expect(
      readPlanBlock({ changes: [{ key: 'nope', what: 'w', where: ['x'], unchanged: 'u' }], kept: [] }, KEYS)
    ).toEqual({
      reason: 'a change names a decision this tour does not have: nope',
    })
    expect(readPlanBlock({ changes: ['x'], kept: [] }, KEYS)).toEqual({
      reason: 'a change names a decision this tour does not have: null',
    })
    expect(readPlanBlock({ changes: [{ key: 'second', where: ['x'] }], kept: [] }, KEYS)).toEqual({
      reason: 'the change second: the block has no "what"',
    })
    expect(readPlanBlock({ changes: [], kept: ['gone'] }, KEYS)).toEqual({
      reason: 'a kept decision this tour does not have: gone',
    })
  })
})

describe('splitGrillAnswer', () => {
  it('keeps prose, turns the two block kinds into cards, and leaves a bad block as text', () => {
    const answer = [
      'Thanks. Here is what I understood:',
      '```restatement',
      '{ "what": "Multiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }',
      '```',
      'And the plan:',
      '```plan',
      '{ "changes": [], "kept": ["second"] }',
      '```',
      '```restatement',
      'not json',
      '```',
      '```plan',
      '{ "changes": [], "kept": ["nope"] }',
      '```',
      '',
    ].join('\n')
    expect(splitGrillAnswer(answer, KEYS)).toEqual([
      { type: 'markdown', text: 'Thanks. Here is what I understood:' },
      {
        type: 'restatement',
        restatement: { what: 'Multiply.', where: ['src/app.ts:4'], unchanged: 'Callers.' },
      },
      { type: 'markdown', text: 'And the plan:' },
      { type: 'plan', plan: { changes: [], kept: ['second'] } },
      { type: 'invalid', text: 'not json', reason: 'the block is not JSON' },
      {
        type: 'invalid',
        text: '{ "changes": [], "kept": ["nope"] }',
        reason: 'a kept decision this tour does not have: nope',
      },
    ])
    expect(splitGrillAnswer('', KEYS)).toEqual([])
    expect(splitGrillAnswer('```plan\n[]\n```', KEYS)).toEqual([
      { type: 'invalid', text: '[]', reason: 'the block is not a JSON object' },
    ])
    expect(splitGrillAnswer('```restatement\n{}\n```', KEYS)).toEqual([
      { type: 'invalid', text: '{}', reason: 'the block has no "what"' },
    ])
  })
})
