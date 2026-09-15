// @ts-check
// @vitest-environment happy-dom
// The library is a boundary, so a fake mermaid module stands in for it: no real render runs here.
import { MERMAID_SOURCE, MERMAID_SVG } from './__fixtures__/mermaid-svg.js'
import { wireCopyCommands } from './commands.js'
import {
  activateNodeLink,
  attachNodeLinks,
  DIRECTIVE_NOTE,
  diagramFallbackHtml,
  diagramKind,
  diagramMarkdown,
  diagramPlaceholderHtml,
  findNodeGroups,
  initDiagrams,
  mermaidConfig,
  nodeGroupPattern,
  observeTheme,
  readThemeColors,
  renderDiagrams,
  resetMermaid,
  sanitizeSvg,
  setsOptions,
  THEME_TOKENS,
  toggleDiagram,
} from './diagram.js'

/** @typedef {import('./diagram.js').MermaidApi} MermaidApi */
/** @typedef {import('./diagram.js').ThemeColors} ThemeColors */

const SOURCE = 'flowchart LR\n  A --> B'

/** @type {ThemeColors} */
const COLORS = /** @type {ThemeColors} */ (Object.fromEntries(THEME_TOKENS.map((t, i) => [t, `rgb(${i}, 0, 0)`])))

/**
 * A mermaid double that records what it was asked to draw.
 * @param {{ svg?: (text: string, n: number) => string, fail?: boolean, hold?: boolean }} [opts]
 *   `hold` keeps every drawing waiting until it is released by its number, so a test can act while
 *   one is in flight and can let them finish in any order. `svg` is given the render's number.
 */
function fakeMermaid(opts = {}) {
  /** @type {{ configs: unknown[], ids: string[], texts: string[], loads: number }} */
  const calls = { configs: [], ids: [], texts: [], loads: 0 }
  /** Drawings waiting to finish, by their render number (1 for the first `render` call). */
  /** @type {Map<number, () => void>} */
  const holds = new Map()
  /** @type {MermaidApi} */
  const api = {
    initialize(config) {
      calls.configs.push(config)
    },
    render(id, text) {
      calls.ids.push(id)
      calls.texts.push(text)
      if (opts.fail === true) {
        return Promise.reject(new Error('Parse error on line 1'))
      }
      const n = calls.ids.length
      const result = {
        svg: opts.svg?.(text, n) ?? `<svg role="graphics-document"><text>${text}</text></svg>`,
        diagramType: 'flowchart',
      }
      if (opts.hold !== true) {
        return Promise.resolve(result)
      }
      return new Promise(resolve => {
        holds.set(n, () => resolve(result))
      })
    },
  }
  return {
    calls,
    /** Lets the drawings that are waiting finish, oldest first. */
    release: () => {
      for (const n of [...holds.keys()]) {
        holds.get(n)?.()
        holds.delete(n)
      }
    },
    /**
     * Lets one waiting drawing finish, named by its render number.
     * @param {number} n
     */
    releaseRender: n => {
      holds.get(n)?.()
      holds.delete(n)
    },
    load: () => {
      calls.loads += 1
      return Promise.resolve(api)
    },
  }
}

beforeEach(() => {
  resetMermaid()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

describe('diagramPlaceholderHtml', () => {
  it('keeps the source in an attribute, escaped, never as markup', () => {
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B')
    const el = document.querySelector('.diagram')
    expect(el?.getAttribute('data-mermaid')).toBe('flowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B')
    expect(document.querySelector('img')).toBeNull()
    expect(el?.querySelector('.diagram-body')?.innerHTML).toBe('')
  })

  it('heads the panel with an open chevron, the kind of drawing, and a copy command', () => {
    document.body.innerHTML = diagramPlaceholderHtml('stateDiagram-v2\n  [*] --> active')
    expect(document.querySelector('.diagram-h .chev')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.diagram-h .chev')?.getAttribute('aria-label')).toBe('Toggle diagram')
    expect(document.querySelector('.diagram-h .lbl')?.textContent).toBe('diagram · stateDiagram')
    expect(document.querySelector('.diagram-h .cmd')?.textContent).toBe('copy')
  })

  it('names the kind from the first word, and says only "diagram" when there is none', () => {
    expect(diagramKind('stateDiagram-v2\n  [*] --> a')).toBe('stateDiagram')
    expect(diagramKind('\n\nflowchart LR\n  A --> B')).toBe('flowchart')
    expect(diagramKind('sequenceDiagram\n  A ->> B: hi')).toBe('sequenceDiagram')
    expect(diagramKind('  erDiagram {\n')).toBe('erDiagram')
    expect(diagramKind('')).toBe('')
    expect(diagramKind('  [*] --> a')).toBe('')
    // A comment above the drawing is not its kind.
    expect(diagramKind('%% what this shows\nflowchart LR\n  A --> B')).toBe('flowchart')
    document.body.innerHTML = diagramPlaceholderHtml('  [*] --> a')
    expect(document.querySelector('.diagram-h .lbl')?.textContent).toBe('diagram')
  })
})

describe('the copy command', () => {
  it('fences a source that holds a fence of its own with a longer one', () => {
    expect(diagramMarkdown('flowchart LR\n  A --> B')).toBe('```mermaid\nflowchart LR\n  A --> B\n```')
    const tricky = 'flowchart LR\n```\n@some-user\n```mermaid'
    expect(diagramMarkdown(tricky)).toBe(`\`\`\`\`mermaid\n${tricky}\n\`\`\`\``)
    expect(diagramMarkdown('a `x` b')).toBe('```mermaid\na `x` b\n```')
  })

  it('copies the diagram as a fenced mermaid block, the way a GitHub comment renders it', async () => {
    /** @type {string[]} */
    const written = []
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    wireCopyCommands(document.body, text => {
      written.push(text)
      return Promise.resolve()
    })
    const copy = document.querySelector('.diagram-h .cmd')
    if (!(copy instanceof HTMLElement)) {
      throw new Error('no copy command')
    }
    copy.click()
    await vi.waitFor(() => expect(written).toEqual(['```mermaid\nflowchart LR\n  A --> B\n```']))
    expect(written[0]).toBe(diagramMarkdown(SOURCE))
    expect(copy.textContent).toBe('copy')
  })
})

describe('toggleDiagram', () => {
  it('closes and opens a diagram from its chevron', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const chevron = document.querySelector('.diagram-h .chev')
    const body = document.querySelector('.diagram-body')
    if (!(chevron instanceof HTMLElement && body instanceof HTMLElement)) {
      throw new Error('no diagram header')
    }
    chevron.click()
    await vi.waitFor(() => expect(body.hidden).toBe(true))
    expect(chevron.getAttribute('aria-expanded')).toBe('false')
    chevron.click()
    await vi.waitFor(() => expect(body.hidden).toBe(false))
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
    // Still one drawing: it was never thrown away, so opening it again asks for nothing.
    expect(mermaid.calls.texts).toHaveLength(1)
    handle.stop()
    chevron.click()
    expect(chevron.getAttribute('aria-expanded')).toBe('true')
  })

  it('does nothing for a placeholder that carries no header', async () => {
    document.body.innerHTML = '<div class="diagram" data-mermaid="flowchart LR"></div>'
    const node = document.querySelector('.diagram')
    if (!(node instanceof HTMLElement)) {
      throw new Error('no diagram')
    }
    await toggleDiagram(node)
    expect(node.innerHTML).toBe('')
    // Drawing one counts nothing: there is nowhere to put the drawing.
    const mermaid = fakeMermaid()
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 0,
      failed: 0,
    })
    expect(node.innerHTML).toBe('')
  })

  it('throws away a drawing that finished after the diagram was closed', async () => {
    const mermaid = fakeMermaid({ hold: true })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const chevron = document.querySelector('.diagram-h .chev')
    const node = document.querySelector('.diagram')
    if (!(chevron instanceof HTMLElement && node instanceof HTMLElement)) {
      throw new Error('no diagram header')
    }
    chevron.click()
    mermaid.release()
    // The drawing arrives for a diagram nobody can see, so it is dropped and the diagram stays
    // waiting: opening it draws it again, in the theme on screen at that moment.
    await vi.waitFor(() => expect(node.querySelector('.diagram-body')?.innerHTML).toBe(''))
    expect(node.querySelector('.diagram-body')?.innerHTML).toBe('')
    chevron.click()
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    mermaid.release()
    await vi.waitFor(() => expect(node.querySelector('.diagram-body')?.innerHTML).not.toBe(''))
    handle.stop()
  })

  it('lets the newest drawing win when a diagram is opened while an older one is still coming', async () => {
    const mermaid = fakeMermaid({ hold: true, svg: (_text, n) => `<svg data-n="${n}"></svg>` })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const chevron = document.querySelector('.diagram-h .chev')
    const node = document.querySelector('.diagram')
    if (!(chevron instanceof HTMLElement && node instanceof HTMLElement)) {
      throw new Error('no diagram header')
    }
    // Close, flip the theme, and open again while the very first drawing is still in flight.
    chevron.click()
    document.documentElement.setAttribute('data-theme', 'light')
    await vi.waitFor(() => expect(node.querySelector('.diagram-body')?.innerHTML).toBe(''))
    chevron.click()
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    // The newer drawing lands first, then the older one arrives and is turned away.
    mermaid.releaseRender(2)
    await vi.waitFor(() => expect(node.querySelector('.diagram-body svg')?.getAttribute('data-n')).toBe('2'))
    mermaid.releaseRender(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(node.querySelector('.diagram-body svg')?.getAttribute('data-n')).toBe('2')
    expect(node.querySelectorAll('.diagram-body svg')).toHaveLength(1)
    expect(node.querySelector('.diagram-body')?.innerHTML).not.toBe('')
    handle.stop()
  })

  it('draws a diagram opened while an earlier one is still being drawn, without waiting for it', async () => {
    const mermaid = fakeMermaid({ hold: true, svg: (text, n) => `<svg data-n="${n}">${text}</svg>` })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE) + diagramPlaceholderHtml('flowchart LR\n  C --> D')
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    // The pass stops on the first diagram, so the second is claimed but still blank.
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const second = document.querySelectorAll('.diagram')[1]
    const chevron = second?.querySelector('.chev')
    if (!(second instanceof HTMLElement && chevron instanceof HTMLElement)) {
      throw new Error('no second diagram')
    }
    chevron.click()
    chevron.click()
    // Opening it asks for its drawing now instead of waiting behind the first one.
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    mermaid.releaseRender(2)
    await vi.waitFor(() => expect(second.querySelector('.diagram-body svg')).not.toBeNull())
    expect(second.querySelector('.diagram-body svg')?.getAttribute('data-n')).toBe('2')
    handle.stop()
  })

  it('leaves the diagrams of a finished pass alone when an older pass resumes', async () => {
    const mermaid = fakeMermaid({ hold: true, svg: (_text, n) => `<svg data-n="${n}"></svg>` })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE) + diagramPlaceholderHtml('flowchart LR\n  C --> D')
    // The first pass stops on the first diagram; the second passes over both and finishes.
    const first = renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const second = renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    mermaid.releaseRender(2)
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(3))
    mermaid.releaseRender(3)
    expect(await second).toEqual({ rendered: 2, failed: 0 })
    const drawn = () => [...document.querySelectorAll('.diagram-body svg')].map(el => el.getAttribute('data-n'))
    expect(drawn()).toEqual(['2', '3'])
    // The first pass wakes up owning nothing: it draws no more and overwrites nothing.
    mermaid.releaseRender(1)
    expect(await first).toEqual({ rendered: 0, failed: 0 })
    expect(mermaid.calls.texts).toHaveLength(3)
    expect(drawn()).toEqual(['2', '3'])
  })

  it('draws a diagram that was closed when the theme flipped, at the moment it is opened', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
    const chevron = document.querySelector('.diagram-h .chev')
    const node = document.querySelector('.diagram')
    if (!(chevron instanceof HTMLElement && node instanceof HTMLElement)) {
      throw new Error('no diagram header')
    }
    chevron.click()
    document.documentElement.setAttribute('data-theme', 'light')
    await vi.waitFor(() => expect(node.querySelector('.diagram-body')?.innerHTML).toBe(''))
    // The flip drew nothing, since nobody could see it, and it cleared the old drawing.
    expect(mermaid.calls.texts).toHaveLength(1)
    expect(node.querySelector('.diagram-body')?.innerHTML).toBe('')
    chevron.click()
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    expect(node.querySelector('.diagram-body')?.innerHTML).not.toBe('')
    expect(node.querySelector('.diagram-body svg')).not.toBeNull()
    handle.stop()
  })
})

describe('renderDiagrams', () => {
  it('imports mermaid only when the page holds a placeholder', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = '<p>no diagrams here</p>'
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 0,
      failed: 0,
    })
    expect(mermaid.calls.loads).toBe(0)
  })

  it('draws every placeholder with one id each and imports the library once', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE) + diagramPlaceholderHtml('sequenceDiagram\n  A ->> B: hi')
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 2,
      failed: 0,
    })
    expect(mermaid.calls.loads).toBe(1)
    expect(mermaid.calls.texts).toEqual([SOURCE, 'sequenceDiagram\n  A ->> B: hi'])
    expect(new Set(mermaid.calls.ids).size).toBe(2)
    const bodies = [...document.querySelectorAll('.diagram .diagram-body svg')]
    expect(bodies).toHaveLength(2)
    await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    expect(mermaid.calls.loads).toBe(1)
  })

  it('shows the source and a muted note when mermaid cannot draw it', async () => {
    const mermaid = fakeMermaid({ fail: true })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 0,
      failed: 1,
    })
    const el = document.querySelector('.diagram')
    expect(el?.querySelector('.diagram-src code')?.textContent).toBe(SOURCE)
    expect(el?.querySelector('p.muted')?.textContent).toBe('diagram could not be rendered')
  })

  it('falls back the same way when the library itself cannot be loaded', async () => {
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const result = await renderDiagrams(document.body, {
      load: () => Promise.reject(new Error('offline')),
      colors: COLORS,
    })
    expect(result).toEqual({ rendered: 0, failed: 1 })
    expect(document.querySelector('.diagram-src code')?.textContent).toBe(SOURCE)
    // The failure is not cached: a later render tries again.
    const mermaid = fakeMermaid()
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 1,
      failed: 0,
    })
  })

  it('strips scripts and handlers from the rendered SVG and keeps the drawing', async () => {
    const mermaid = fakeMermaid({
      svg: () => '<svg><g onclick="alert(1)"><rect/><text>A</text></g><script>alert(1)</script></svg>',
    })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('[onclick]')).toBeNull()
    expect(document.querySelector('.diagram-body rect')).not.toBeNull()
    expect(document.querySelector('.diagram-body text')?.textContent).toBe('A')
  })

  it('refuses a source that sets mermaid options and shows it instead', async () => {
    const mermaid = fakeMermaid()
    const source = '%%{init: {"themeCSS": "text { display: none }"}}%%\nflowchart LR\n  A --> B'
    expect(setsOptions(source)).toBe(true)
    // Front matter is the other way a source sets options, and mermaid reads it the same way.
    expect(setsOptions('---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\n  A --> B')).toBe(true)
    expect(setsOptions(SOURCE)).toBe(false)
    expect(setsOptions('flowchart LR\n  A --- B')).toBe(false)
    document.body.innerHTML = diagramPlaceholderHtml(source) + diagramPlaceholderHtml(SOURCE)
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({
      rendered: 1,
      failed: 1,
    })
    expect(mermaid.calls.texts).toEqual([SOURCE])
    const refused = document.querySelectorAll('.diagram')[0]
    expect(refused?.querySelector('.diagram-src code')?.textContent).toBe(source)
    expect(refused?.querySelector('p.muted')?.textContent).toBe(DIRECTIVE_NOTE)
    expect(document.querySelector('style')).toBeNull()
  })

  it('stops between placeholders when the screen it draws goes away', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE) + diagramPlaceholderHtml('flowchart LR\n  C --> D')
    const result = await renderDiagrams(document.body, {
      load: mermaid.load,
      colors: COLORS,
      cancelled: () => mermaid.calls.texts.length >= 1,
    })
    expect(result).toEqual({ rendered: 0, failed: 0 })
    // The first drawing is thrown away rather than written, and the second is never asked for.
    expect(mermaid.calls.texts).toEqual([SOURCE])
    expect([...document.querySelectorAll('.diagram-body')].map(el => el.innerHTML)).toEqual(['', ''])
  })

  it('draws nothing when the screen goes away while the library loads', async () => {
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS, cancelled: () => true })).toEqual({
      rendered: 0,
      failed: 0,
    })
    expect(mermaid.calls.configs).toEqual([])
  })

  it('writes no fallback for a screen that went away while a drawing failed', async () => {
    const mermaid = fakeMermaid({ fail: true })
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE) + diagramPlaceholderHtml('flowchart LR\n  C --> D')
    expect(
      await renderDiagrams(document.body, {
        load: mermaid.load,
        colors: COLORS,
        cancelled: () => mermaid.calls.texts.length >= 1,
      })
    ).toEqual({ rendered: 0, failed: 0 })
    // The first drawing failed after the screen went away, and the second was never asked for.
    expect(mermaid.calls.texts).toEqual([SOURCE])
    expect([...document.querySelectorAll('.diagram-body')].map(el => el.innerHTML)).toEqual(['', ''])
  })

  it('writes no fallback for a screen that went away while the library failed to load', async () => {
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    expect(
      await renderDiagrams(document.body, {
        load: () => Promise.reject(new Error('offline')),
        colors: COLORS,
        cancelled: () => true,
      })
    ).toEqual({ rendered: 0, failed: 0 })
    expect(document.querySelector('.diagram-src')).toBeNull()
  })

  it('reads the theme from the computed style when no colors are given', async () => {
    const mermaid = fakeMermaid()
    const style = document.createElement('style')
    style.textContent = `:root { ${THEME_TOKENS.map(t => `${t}: rgb(1, 2, 3)`).join('; ')} }`
    document.head.append(style)
    try {
      document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
      await renderDiagrams(document.body, { load: mermaid.load })
      const config = /** @type {{ themeVariables: { background: string } }} */ (mermaid.calls.configs[0])
      expect(config.themeVariables.background).toBe('rgb(1, 2, 3)')
      // The probe the reader adds does not stay in the page.
      expect(document.querySelectorAll('body > span')).toHaveLength(0)
    } finally {
      style.remove()
    }
  })
})

describe('mermaidConfig', () => {
  it('runs strict, suppresses mermaid error drawings, sizes diagrams by themselves, and maps every page token', () => {
    const config = mermaidConfig(COLORS)
    expect(config.securityLevel).toBe('strict')
    expect(config.suppressErrorRendering).toBe(true)
    expect(config.startOnLoad).toBe(false)
    expect(config.theme).toBe('base')
    expect(config.flowchart.htmlLabels).toBe(false)
    expect([
      config.flowchart.useMaxWidth,
      config.sequence.useMaxWidth,
      config.state.useMaxWidth,
      config.er.useMaxWidth,
    ]).toEqual([false, false, false, false])
    expect(config.themeVariables.background).toBe(COLORS['--bg'])
    expect(config.themeVariables.primaryTextColor).toBe(COLORS['--fg'])
    expect(config.themeVariables.lineColor).toBe(COLORS['--fg-muted'])
    const used = new Set(Object.values(config.themeVariables))
    for (const token of THEME_TOKENS) {
      expect(used.has(COLORS[token]), token).toBe(true)
    }
  })
})

describe('readThemeColors', () => {
  it('falls back to a readable color for a token the page does not define', () => {
    const colors = readThemeColors()
    expect(colors['--bg']).toBe('#1e1f2b')
    expect(Object.keys(colors)).toEqual([...THEME_TOKENS])
  })
})

describe('observeTheme and initDiagrams', () => {
  it('draws again in the new colors when the theme flips, and stops when told to', async () => {
    const mermaid = fakeMermaid()
    const style = document.createElement('style')
    style.textContent = `:root { --bg: rgb(1, 1, 1) } :root[data-theme="light"] { --bg: rgb(9, 9, 9) }`
    document.head.append(style)
    try {
      document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
      const handle = initDiagrams(document.body, { load: mermaid.load })
      await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(1))
      document.documentElement.setAttribute('data-theme', 'light')
      await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
      const backgrounds = mermaid.calls.configs.map(
        c => /** @type {{ themeVariables: { background: string } }} */ (c).themeVariables.background
      )
      expect(backgrounds).toEqual(['rgb(1, 1, 1)', 'rgb(9, 9, 9)'])
      handle.stop()
      document.documentElement.setAttribute('data-theme', 'dark')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(mermaid.calls.texts).toHaveLength(2)
    } finally {
      style.remove()
    }
  })

  it('writes nothing more once the screen it draws is stopped', async () => {
    /** @type {(api: import('./diagram.js').MermaidApi) => void} */
    let release = () => {}
    const pending = new Promise(resolve => {
      release = resolve
    })
    const mermaid = fakeMermaid()
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    const handle = initDiagrams(document.body, { load: () => pending, colors: COLORS })
    handle.stop()
    release(await mermaid.load())
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(mermaid.calls.texts).toEqual([])
    expect(document.querySelector('.diagram-body')?.innerHTML).toBe('')
  })

  it('does nothing when the environment has no MutationObserver', () => {
    const real = globalThis.MutationObserver
    // @ts-expect-error the test removes the global on purpose
    globalThis.MutationObserver = undefined
    try {
      /** @type {number[]} */
      const calls = []
      const handle = observeTheme(() => calls.push(1))
      handle.stop()
      expect(calls).toEqual([])
    } finally {
      globalThis.MutationObserver = real
    }
  })
})

describe('sanitizeSvg and diagramFallbackHtml', () => {
  it('keeps the drawing and escapes the source', () => {
    expect(sanitizeSvg('<svg><path d="M0 0"/></svg>')).toContain('<path d="M0 0">')
    expect(diagramFallbackHtml('a <b> & "c"')).toContain('a &lt;b&gt; &amp; &quot;c&quot;')
  })
})

describe('node links', () => {
  /**
   * A mermaid double that answers with what the library really drew for the same source.
   * @param {keyof typeof MERMAID_SVG} type
   */
  function realMermaid(type) {
    return fakeMermaid({ svg: () => MERMAID_SVG[type] })
  }

  /**
   * One drawn placeholder with its sidecar map, rendered through the real pipeline.
   * @param {keyof typeof MERMAID_SVG} type
   * @param {Record<string, string>} links
   */
  async function draw(type, links) {
    // The library is remembered per page, so a second drawing in one test needs a fresh one.
    resetMermaid()
    const mermaid = realMermaid(type)
    document.body.innerHTML = diagramPlaceholderHtml(MERMAID_SOURCE[type], links)
    await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    const node = document.querySelector('.diagram')
    if (!(node instanceof HTMLElement)) {
      throw new Error('no diagram')
    }
    return node
  }

  /** @param {Element | null | undefined} el */
  function linkAttrs(el) {
    return {
      link: el?.getAttribute('data-link') ?? null,
      role: el?.getAttribute('role') ?? null,
      tabindex: el?.getAttribute('tabindex') ?? null,
      label: el?.getAttribute('aria-label') ?? null,
    }
  }

  it('carries the sidecar map in an attribute, escaped, and omits it when there is none', () => {
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE, { A: '#file:src/a"b.ts' })
    const el = document.querySelector('.diagram')
    expect(el?.getAttribute('data-links')).toBe('{"A":"#file:src/a\\"b.ts"}')
    document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
    expect(document.querySelector('.diagram')?.hasAttribute('data-links')).toBe(false)
  })

  it('matches the group id mermaid writes, drawing id and counter included', () => {
    expect(nodeGroupPattern('store').test('pr-diagram-flowchart-flowchart-store-1')).toBe(true)
    expect(nodeGroupPattern('active').test('pr-diagram-state-state-active-1')).toBe(true)
    expect(nodeGroupPattern('SHL').test('pr-diagram-er-entity-SHL-0')).toBe(true)
    // A near miss stays a miss: another node's id, and the note group of the same state.
    expect(nodeGroupPattern('SHL').test('pr-diagram-er-entity-SHL_FILE-1')).toBe(false)
    expect(nodeGroupPattern('active').test('pr-diagram-state-state-active----note-1')).toBe(false)
    expect(nodeGroupPattern('a.b*c').test('pr-diagram-flowchart-a.b*c-0')).toBe(true)
    // Naming the drawing keeps `b` apart from a node whose own id ends in `-state-b`.
    expect(nodeGroupPattern('b', 'pr-diagram-1').test('pr-diagram-1-flowchart-a-state-b-0')).toBe(false)
    expect(nodeGroupPattern('a-state-b', 'pr-diagram-1').test('pr-diagram-1-flowchart-a-state-b-0')).toBe(true)
    expect(nodeGroupPattern('b', 'pr-diagram-1').test('pr-diagram-1-flowchart-b-2')).toBe(true)
  })

  it("links the node whose id ends in another node's name, and not its neighbour", () => {
    const svg =
      '<svg id="d1">' +
      '<g class="node" id="d1-flowchart-a-state-b-0"><text>one</text></g>' +
      '<g class="node" id="d1-flowchart-b-1"><text>two</text></g>' +
      '</svg>'
    const mermaid = fakeMermaid({ svg: () => svg })
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  a-state-b --> b', { b: '#file:src/app.ts' })
    return renderDiagrams(document.body, { load: mermaid.load, colors: COLORS }).then(() => {
      expect([...document.querySelectorAll('[data-link]')].map(el => el.getAttribute('id'))).toEqual([
        'd1-flowchart-b-1',
      ])
    })
  })

  it('leaves an edge label alone even when its data-id is the name of a node', async () => {
    const svg =
      '<svg id="d2">' +
      '<g class="label" data-id="L_a_b_0"><text>edge</text></g>' +
      '<g class="node" id="d2-flowchart-L_a_b_0-1"><text>node</text></g>' +
      '</svg>'
    const mermaid = fakeMermaid({ svg: () => svg })
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  L_a_b_0 --> z', { L_a_b_0: '#file:src/app.ts' })
    await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    expect([...document.querySelectorAll('[data-link]')].map(el => el.getAttribute('id'))).toEqual([
      'd2-flowchart-L_a_b_0-1',
    ])
  })

  it('links the flowchart nodes the map names and leaves the rest alone', async () => {
    const node = await draw('flowchart', {
      store: '#file:src/app.ts',
      serve: '#hunk:src/app.ts#2',
      nope: '#file:src/app.ts',
    })
    const store = node.querySelector('#pr-diagram-flowchart-flowchart-store-1')
    expect(linkAttrs(store)).toEqual({
      link: '#file:src/app.ts',
      role: 'link',
      tabindex: '0',
      label: 'src/app.ts',
    })
    expect(linkAttrs(node.querySelector('#pr-diagram-flowchart-flowchart-serve-3')).label).toBe('src/app.ts hunk 2')
    expect(node.querySelector('#pr-diagram-flowchart-flowchart-ingest-0')?.hasAttribute('data-link')).toBe(false)
    expect(node.querySelectorAll('[data-link]')).toHaveLength(2)
  })

  it('links a sequence participant by the data-id mermaid writes on it', async () => {
    const node = await draw('sequence', { App: '#layer:auth' })
    const app = node.querySelector('g[data-id="App"]')
    expect(linkAttrs(app).link).toBe('#layer:auth')
    expect(linkAttrs(app).label).toBe('auth')
    expect(node.querySelector('g[data-id="Srv"]')?.hasAttribute('data-link')).toBe(false)
  })

  it('links a state and an ER entity by their group ids', async () => {
    const state = await draw('state', { active: '#file:src/app.ts', purged: '#line:src/app.ts:3-4' })
    expect(linkAttrs(state.querySelector('#pr-diagram-state-state-active-1')).link).toBe('#file:src/app.ts')
    expect(linkAttrs(state.querySelector('#pr-diagram-state-state-purged-4')).label).toBe('src/app.ts:3-4')
    const er = await draw('er', { SHL_FILE: '#hunk:src/app.ts#1' })
    expect(linkAttrs(er.querySelector('#pr-diagram-er-entity-SHL_FILE-1')).link).toBe('#hunk:src/app.ts#1')
    expect(er.querySelector('#pr-diagram-er-entity-SHL-0')?.hasAttribute('data-link')).toBe(false)
  })

  it('takes only the four canvas link forms from the map', async () => {
    const node = await draw('flowchart', { store: 'javascript:alert(1)', serve: 'https://example.test' })
    expect(node.querySelectorAll('[data-link]')).toHaveLength(0)
    expect(node.innerHTML).not.toContain('javascript:')
  })

  it('reads a sidecar map that is not a map as no links at all', async () => {
    for (const raw of ['[1,2]', 'not json', '"text"', 'null', '{"a":3}']) {
      const mermaid = realMermaid('flowchart')
      document.body.innerHTML = diagramPlaceholderHtml(MERMAID_SOURCE.flowchart)
      document.querySelector('.diagram')?.setAttribute('data-links', raw)
      await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
      expect(document.querySelectorAll('[data-link]'), raw).toHaveLength(0)
    }
  })

  it('links the nodes again after every redraw, and never twice from one', async () => {
    const mermaid = realMermaid('flowchart')
    const style = document.createElement('style')
    style.textContent = ':root { --bg: rgb(1, 1, 1) } :root[data-theme="light"] { --bg: rgb(9, 9, 9) }'
    document.head.append(style)
    try {
      document.body.innerHTML = diagramPlaceholderHtml(MERMAID_SOURCE.flowchart, { store: '#file:src/app.ts' })
      const handle = initDiagrams(document.body, { load: mermaid.load })
      await vi.waitFor(() => expect(document.querySelectorAll('[data-link]')).toHaveLength(1))
      document.documentElement.setAttribute('data-theme', 'light')
      await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
      await vi.waitFor(() => expect(document.querySelectorAll('[data-link]')).toHaveLength(1))
      handle.stop()
    } finally {
      style.remove()
    }
  })

  it('finds nothing to link when the placeholder shows its source instead of a drawing', async () => {
    const mermaid = fakeMermaid({ fail: true })
    document.body.innerHTML = diagramPlaceholderHtml(MERMAID_SOURCE.flowchart, { store: '#file:src/app.ts' })
    await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    expect(document.querySelectorAll('[data-link]')).toHaveLength(0)
    expect(document.querySelector('.diagram-src')).not.toBeNull()
  })

  it('does nothing for a placeholder without a body', () => {
    const orphan = document.createElement('div')
    orphan.className = 'diagram'
    orphan.setAttribute('data-links', '{"a":"#file:src/app.ts"}')
    expect(attachNodeLinks(orphan)).toBe(0)
  })

  it('jumps to the target on a click and on Enter, through one listener for the screen', async () => {
    const mermaid = realMermaid('flowchart')
    document.body.innerHTML =
      '<div id="file-src_app_ts">the file card</div>' +
      diagramPlaceholderHtml(MERMAID_SOURCE.flowchart, { store: '#file:src/app.ts' })
    const added = vi.spyOn(document.body, 'addEventListener')
    const handle = initDiagrams(document.body, { load: mermaid.load, colors: COLORS })
    await vi.waitFor(() => expect(document.querySelectorAll('[data-link]')).toHaveLength(1))
    const target = document.getElementById('file-src_app_ts')
    const group = document.querySelector('[data-link]')
    if (!(group instanceof Element)) {
      throw new Error('no linked node')
    }
    // The click lands on the text inside the group, the way a reader's click does.
    const inside = group.querySelector('text') ?? group
    inside.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    expect(target?.classList.contains('is-target')).toBe(true)
    target?.classList.remove('is-target')
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(target?.classList.contains('is-target')).toBe(true)
    target?.classList.remove('is-target')
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))
    expect(target?.classList.contains('is-target')).toBe(false)
    // One click listener and one keydown listener, however many diagrams the screen redraws, and
    // one jump per click: a second listener would flash the target twice as often.
    document.documentElement.setAttribute('data-theme', 'light')
    await vi.waitFor(() => expect(mermaid.calls.texts).toHaveLength(2))
    expect(added.mock.calls.filter(([type]) => type === 'click')).toHaveLength(1)
    expect(added.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    added.mockRestore()
    // Each jump scrolls once; a second listener on the same screen would scroll twice.
    const scrolls = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const redrawn = document.querySelector('[data-link]')
    redrawn?.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    expect(target?.classList.contains('is-target')).toBe(true)
    expect(scrolls).toHaveBeenCalledTimes(1)
    scrolls.mockRestore()
    // The screen is gone: the listeners went with it and a click does nothing.
    handle.stop()
    target?.classList.remove('is-target')
    redrawn?.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    redrawn?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(target?.classList.contains('is-target')).toBe(false)
  })

  it('ignores an event that is not on a linked node', () => {
    document.body.innerHTML = '<div class="diagram-body"><span id="plain">x</span></div>'
    /** @type {boolean[]} */
    const answers = []
    // The listener goes with the test: the body outlives it, and a leftover would jump twice.
    const listening = new AbortController()
    document.body.addEventListener('click', event => answers.push(activateNodeLink(event)), {
      signal: listening.signal,
    })
    document.getElementById('plain')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('click'))
    listening.abort()
    expect(answers).toEqual([false, false])
    // An event with no element behind it, which is what a synthetic event carries.
    expect(activateNodeLink(new Event('click'))).toBe(false)
    expect(findNodeGroups(document.body, 'plain')).toEqual([])
  })

  it('does not follow a link whose target is not on the page', async () => {
    const node = await draw('flowchart', { store: '#file:src/gone.ts' })
    /** @type {boolean[]} */
    const followed = []
    const listening = new AbortController()
    document.body.addEventListener('click', event => followed.push(activateNodeLink(event)), {
      signal: listening.signal,
    })
    node.querySelector('[data-link]')?.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
    listening.abort()
    expect(followed).toEqual([false])
  })
})

describe('diagram lifecycle boundaries', () => {
  it('renders a placeholder passed as the root itself', async () => {
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  A --> B')
    const node = document.querySelector('.diagram')
    if (!(node instanceof HTMLElement)) throw new Error('missing diagram')
    const mermaid = fakeMermaid()
    expect(await renderDiagrams(node, { load: mermaid.load, colors: COLORS })).toEqual({ rendered: 1, failed: 0 })
    expect(node.querySelector('svg')).not.toBeNull()
  })

  it('reads fallback colors from a detached document without a window', () => {
    const doc = document.implementation.createHTMLDocument('preview')
    expect(doc.defaultView).toBeNull()
    expect(readThemeColors(doc)['--bg']).toBe('#1e1f2b')
    expect(doc.body.children).toHaveLength(0)
  })

  it('does not write a failed library load into a diagram whose body disappeared', async () => {
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  A --> B')
    const result = await renderDiagrams(document.body, {
      load: async () => {
        document.querySelector('.diagram-body')?.remove()
        throw new Error('offline')
      },
      colors: COLORS,
    })
    expect(result).toEqual({ rendered: 0, failed: 0 })
    expect(document.querySelector('.diagram-error')).toBeNull()
  })

  it('ignores a closed placeholder whose body was removed', async () => {
    document.body.innerHTML = diagramPlaceholderHtml('flowchart LR\n  A --> B')
    document.querySelector('.diagram-h .chev')?.setAttribute('aria-expanded', 'false')
    document.querySelector('.diagram-body')?.remove()
    const mermaid = fakeMermaid()
    expect(await renderDiagrams(document.body, { load: mermaid.load, colors: COLORS })).toEqual({ rendered: 0, failed: 0 })
    expect(mermaid.calls.loads).toBe(0)
  })

  it('initializes diagrams inside a document fragment and disposes cleanly', async () => {
    const fragment = document.createDocumentFragment()
    const holder = document.createElement('div')
    holder.innerHTML = diagramPlaceholderHtml('flowchart LR\n  A --> B')
    fragment.append(holder)
    const mermaid = fakeMermaid()
    const handle = initDiagrams(fragment, { load: mermaid.load, colors: COLORS })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(holder.querySelector('svg')).not.toBeNull()
    handle.stop()
  })
})

it('does not show a late rendering error after the reader closes the diagram', async () => {
  document.body.innerHTML = diagramPlaceholderHtml(SOURCE)
  const load = async () => ({
    initialize() {},
    async render() {
      document.querySelector('.diagram-h .chev')?.setAttribute('aria-expanded', 'false')
      throw new Error('render failed')
    },
  })
  expect(await renderDiagrams(document.body, { load, colors: COLORS })).toEqual({ rendered: 0, failed: 0 })
  expect(document.querySelector('.diagram-body')?.innerHTML).toBe('')
})
