// @vitest-environment node
import { visibleLength, visibleText } from './text-length.js'

describe('visibleText', () => {
  it('drops link targets, backticks, and fence lines, and keeps everything a reader sees', () => {
    expect(visibleText('See [the store](#hunk:packages/x/store.ts#2) now.')).toBe('See the store now.')
    expect(visibleText('Bare #hunk:packages/x.ts#1 stays')).toBe('Bare #hunk:packages/x.ts#1 stays')
    expect(visibleText('Call `run()` twice')).toBe('Call run() twice')
    expect(visibleText('a\n```ts\nconst x = 1\n```\nb')).toBe('a\n\nconst x = 1\n\nb')
    expect(visibleText('  ````diff\n+x\n````')).toBe('\n+x\n')
    expect(visibleText('![alt](https://x/y.png) and [](#file:a.ts)')).toBe('alt and ')
    expect(visibleText('')).toBe('')
  })

  it('counts the visible characters', () => {
    expect(visibleLength('[see](#hunk:packages/provider-portal/src/components/shell/surface.tsx#2)')).toBe(3)
    expect(visibleLength('plain')).toBe(5)
  })
})
