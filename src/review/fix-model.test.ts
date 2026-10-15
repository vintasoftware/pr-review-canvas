import { describe, expect, it } from 'vitest'
import type { GenerationContext } from '../contract/generation-context.js'
import { describeFixes, fixModel } from './fix-model.js'

describe('fixModel', () => {
  it('leaves a file that is not JSON to the validator', async () => {
    const out = await fixModel('/nonexistent/model.json', 'not json', {} as GenerationContext, {})
    expect(out).toEqual({ text: 'not json', trims: [], folds: [] })
  })
})

describe('describeFixes', () => {
  it('names each fold fix and each shortened title, and skips a title it could not shorten', () => {
    expect(
      describeFixes({
        folds: [
          {
            outcome: 'fixed',
            where: 'layers.0.files.0.folds.1',
            title: 'imports',
            from: { side: 'new', startLine: 1, endLine: 4 },
            to: null,
            reason: 'it repeats an earlier fold',
          },
        ],
        trims: [
          { outcome: 'fixed', where: 'layers.0.title', from: 'Long: detail', to: 'Long' },
          { outcome: 'unfixable', where: 'layers.1.title', length: 90, cap: 60, reason: 'no separator' },
        ],
      })
    ).toEqual([
      'layers.0.files.0.folds.1: dropped fold "imports" at new 1-4: it repeats an earlier fold',
      'layers.0.title: "Long: detail" -> "Long"',
    ])
  })
})
