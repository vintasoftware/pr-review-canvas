// @ts-check
// @vitest-environment node
import { openFence } from './fences.js'

describe('openFence', () => {
  it('cuts a text before a wanted block that has not closed yet', () => {
    expect(openFence('Enough.\n```restatement\n{ "what": "Mul', ['restatement', 'plan'])).toEqual({
      before: 'Enough.',
      info: 'restatement',
    })
    expect(openFence('Here.\r\n~~~~ Plan\r\n{', ['restatement', 'plan'])).toEqual({
      before: 'Here.',
      info: 'plan',
    })
  })

  it('finds nothing once the block closes, or when the open block is another kind', () => {
    expect(openFence('```restatement\n{}\n```\nDone.', ['restatement'])).toBeNull()
    expect(openFence('```ts\nconst a = 1', ['restatement'])).toBeNull()
    // A wanted fence inside another block is code, and a shorter closer does not close.
    expect(openFence('````md\n```restatement\n````\nAfter.', ['restatement'])).toBeNull()
    expect(openFence('````restatement\n{}\n```', ['restatement'])?.before).toBe('')
    expect(openFence('No fences.', ['restatement'])).toBeNull()
  })
})
