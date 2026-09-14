// @ts-check
// @vitest-environment happy-dom
import { renderMarkdown } from './markdown.js'

describe('renderMarkdown', () => {
  it('renders GFM and strips scripts, handlers, and javascript: hrefs', () => {
    const html = renderMarkdown(
      '**bold** and `code`\n\n<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) [ok](https://example.com)'
    )
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    document.body.innerHTML = html
    expect(document.querySelector('script, img, [onerror]')).toBeNull()
    expect(html).not.toContain('javascript:')
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a>')
  })

  it('renders raw HTML in the source as text', () => {
    const html = renderMarkdown('a <b>bold</b> tag')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;')
  })

  it('drops class attributes, so a fenced block cannot style itself', () => {
    const html = renderMarkdown('```js\nconst x = 1\n```')
    expect(html).toBe('<pre><code>const x = 1\n</code></pre>\n')
  })

  const FENCED = 'Before.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter.'

  it('turns a mermaid fence into a diagram placeholder and leaves the prose around it', () => {
    document.body.innerHTML = renderMarkdown(FENCED, { diagrams: true })
    const diagram = document.querySelector('.diagram')
    expect(diagram?.getAttribute('data-mermaid')).toBe('flowchart LR\n  A --> B')
    expect(document.querySelector('pre')).toBeNull()
    expect([...document.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Before.', 'After.'])
  })

  it('leaves a mermaid fence as a code block for a field that does not draw diagrams', () => {
    document.body.innerHTML = renderMarkdown(FENCED)
    expect(document.querySelector('.diagram')).toBeNull()
    expect(document.querySelector('pre code')?.textContent).toBe('flowchart LR\n  A --> B\n')
    expect([...document.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Before.', 'After.'])
  })

  it('keeps a mermaid fence inside another fence as a code block', () => {
    document.body.innerHTML = renderMarkdown('````markdown\n```mermaid\nflowchart LR\n```\n````', {
      diagrams: true,
    })
    expect(document.querySelector('.diagram')).toBeNull()
    expect(document.querySelector('pre code')?.textContent).toContain('```mermaid')
  })

  it('keeps a reference link that a drawing sits between', () => {
    const src = 'See [the run path][run].\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n[run]: #file:src/run.ts'
    document.body.innerHTML = renderMarkdown(src, { diagrams: true })
    expect(document.querySelector('.diagram')).not.toBeNull()
    expect(document.querySelector('a')?.getAttribute('href')).toBe('#file:src/run.ts')
  })

  it('keeps a reference definition written over two lines', () => {
    const src = 'See [run].\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n[run]:\n  #file:src/run.ts "the run path"'
    document.body.innerHTML = renderMarkdown(src, { diagrams: true })
    expect(document.querySelector('a')?.getAttribute('href')).toBe('#file:src/run.ts')
  })

  it('sends a destination holding a backslash to the same place a drawing-free text would', () => {
    const def = '[search]: https://example.org/s?q=\\\\*'
    const plain = `See [search].\n\n${def}`
    const drawn = `See [search].\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n${def}`
    document.body.innerHTML = renderMarkdown(plain)
    const expected = document.querySelector('a')?.getAttribute('href')
    expect(expected).toContain('q=')
    document.body.innerHTML = renderMarkdown(drawn, { diagrams: true })
    expect(document.querySelector('a')?.getAttribute('href')).toBe(expected)
  })

  it('reads a reference definition shown inside an unclosed code block as an example', () => {
    const src = 'See [run].\n\n```text\n[run]: https://example.org/wrong'
    document.body.innerHTML = renderMarkdown(src, { diagrams: true })
    expect(document.querySelector('a')).toBeNull()
    expect(document.querySelector('p')?.textContent).toBe('See [run].')
  })

  it('reads a reference definition shown inside a code block as an example, not as a definition', () => {
    const src = [
      'See [run].',
      '',
      '```text',
      '[run]: https://example.org/wrong',
      '```',
      '',
      '[run]: #file:src/run.ts',
    ].join('\n')
    document.body.innerHTML = renderMarkdown(src, { diagrams: true })
    expect(document.querySelector('a')?.getAttribute('href')).toBe('#file:src/run.ts')
    expect(document.querySelector('pre code')?.textContent).toBe('[run]: https://example.org/wrong\n')
  })

  it('demotes headings so model text never outranks the page', () => {
    const html = renderMarkdown('# One\n\n## Two\n\n### Three\n\n#### Four\n\n###### Six')
    expect(html).not.toMatch(/<h[12]/)
    expect(html).toContain('<h3>One</h3>')
    expect(html).toContain('<h4>Two</h4>')
    expect(html).toContain('<h5>Three</h5>')
    expect(html).toContain('<h6>Four</h6>')
    expect(html).toContain('<h6>Six</h6>')
  })

  it('keeps canvas links, labels empty ones, and linkifies path:line only for diff paths', () => {
    const paths = new Set(['src/app.ts'])
    const html = renderMarkdown(
      'See [the swap](#hunk:src/app.ts#2), src/app.ts:4-6, other/file.ts:9 and `src/app.ts:1`.',
      { paths }
    )
    expect(html).toContain('<a href="#hunk:src/app.ts#2" class="loc" data-link="#hunk:src/app.ts#2">the swap</a>')
    expect(html).toContain(
      '<a href="#line:src/app.ts:4-6" class="loc" data-link="#line:src/app.ts:4-6">src/app.ts:4-6</a>'
    )
    expect(html).not.toContain('#line:other/file.ts')
    expect(html).toContain('<code>src/app.ts:1</code>')
    const bare = renderMarkdown('[](#file:src/app.ts)')
    expect(bare).toContain('>src/app.ts</a>')
  })

  it('does not linkify when there are no paths and handles empty input', () => {
    expect(renderMarkdown('src/app.ts:4')).toBe('<p>src/app.ts:4</p>\n')
    expect(renderMarkdown('')).toBe('')
  })

  it('keeps lists, tables, blockquotes, and task boxes', () => {
    const html = renderMarkdown('- [x] done\n- item\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<ul>')
    expect(html).toContain('<input')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<table>')
  })
})
