// @ts-check
// @vitest-environment node
import { mermaidBlocks, splitMermaid, withoutMermaid } from './mermaid-fences.js'

describe('splitMermaid', () => {
  it('returns one markdown segment when there is no fence', () => {
    expect(splitMermaid('Just **prose**.')).toEqual([{ type: 'markdown', text: 'Just **prose**.' }])
    expect(splitMermaid('')).toEqual([{ type: 'markdown', text: '' }])
  })

  it('splits the prose around a mermaid block and keeps the order', () => {
    const src = 'Before.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.'
    expect(splitMermaid(src)).toEqual([
      { type: 'markdown', text: 'Before.\n' },
      { type: 'mermaid', text: 'flowchart LR\n  A --> B' },
      { type: 'markdown', text: '\nAfter.' },
    ])
  })

  it('reads a tilde fence, a longer fence, and an indented one', () => {
    expect(mermaidBlocks('~~~mermaid\nA\n~~~')).toEqual(['A'])
    expect(mermaidBlocks('````mermaid\nA\n````')).toEqual(['A'])
    expect(mermaidBlocks('  ```mermaid\n  A\n  ```')).toEqual(['  A'])
    expect(mermaidBlocks('```MERMAID\nA\n```')).toEqual(['A'])
  })

  it('leaves a mermaid fence inside another fenced block as code, whatever the outer info string', () => {
    const src = '````markdown\n```mermaid\nflowchart LR\n```\n````'
    expect(mermaidBlocks(src)).toEqual([])
    expect(withoutMermaid(src)).toBe(src)
    const titled = '````markdown title="an example"\n```mermaid\nflowchart LR\n```\n````'
    expect(mermaidBlocks(titled)).toEqual([])
    expect(withoutMermaid(titled)).toBe(titled)
  })

  it('reads a fence written with CRLF line endings', () => {
    expect(mermaidBlocks('Before.\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n')).toEqual([
      'flowchart LR\n  A --> B',
    ])
  })

  it('is not fooled by a backtick in the info string of a backtick fence', () => {
    const src = '```mermaid `note`\nflowchart LR\n```'
    expect(mermaidBlocks(src)).toEqual([])
    expect(withoutMermaid(src)).toBe(src)
  })

  it('reads a fence whose info string carries more than the language', () => {
    expect(mermaidBlocks('```mermaid title="the flow"\nA\n```')).toEqual([])
    expect(mermaidBlocks('```mermaid  \nA\n```')).toEqual(['A'])
  })

  it('leaves a plain code fence alone, mermaid or not in its info string', () => {
    expect(mermaidBlocks('```js\nconst mermaid = 1\n```')).toEqual([])
    expect(mermaidBlocks('```mermaidjs\nA\n```')).toEqual([])
  })

  it('treats an unclosed mermaid fence as prose, keeping the opening line it was written with', () => {
    const src = 'Text\n\n```mermaid\nflowchart LR\n  A --> B'
    expect(splitMermaid(src)).toEqual([{ type: 'markdown', text: src }])
    const tilde = '  ~~~~mermaid\n  A --> B'
    expect(splitMermaid(tilde)).toEqual([{ type: 'markdown', text: tilde }])
  })

  it('finds several blocks and strips them all', () => {
    const src = 'a\n```mermaid\nX\n```\nb\n```mermaid\nY\n```\nc'
    expect(mermaidBlocks(src)).toEqual(['X', 'Y'])
    expect(withoutMermaid(src)).toBe('a\nb\nc')
  })
})
