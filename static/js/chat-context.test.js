// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { askButtonHtml, isChatEnabled, setChatEnabled } from './ask.js'
import {
  chatContextAttrs,
  chatContextFromElement,
  chatContextLabel,
  sameChatContext,
  WHOLE_PR,
} from './chat-context.js'

/** A stand-in for the one method `chatContextFromElement` reads. */
function el(/** @type {Record<string, string>} */ attrs) {
  return /** @type {Element} */ (
    /** @type {unknown} */ ({ getAttribute: (/** @type {string} */ name) => attrs[name] ?? null })
  )
}

describe('sameChatContext', () => {
  it('is true only for the same target, so asking twice changes nothing', () => {
    expect(sameChatContext(WHOLE_PR, { kind: 'pr' })).toBe(true)
    expect(sameChatContext({ kind: 'layer', layerId: 'a' }, { kind: 'layer', layerId: 'a' })).toBe(true)
    expect(sameChatContext({ kind: 'layer', layerId: 'a' }, { kind: 'layer', layerId: 'b' })).toBe(false)
    expect(sameChatContext({ kind: 'file', path: 'a.ts' }, { kind: 'file', path: 'a.ts' })).toBe(true)
    expect(sameChatContext({ kind: 'file', path: 'a.ts' }, { kind: 'file', path: 'b.ts' })).toBe(false)
    expect(sameChatContext(WHOLE_PR, { kind: 'file', path: 'a.ts' })).toBe(false)
  })

  it('compares every part of a line range', () => {
    const base = /** @type {const} */ ({ kind: 'lines', path: 'a.ts', side: 'new', start: 1, end: 2 })
    expect(sameChatContext(base, { ...base })).toBe(true)
    expect(sameChatContext(base, { ...base, end: 3 })).toBe(false)
    expect(sameChatContext(base, { ...base, side: 'old' })).toBe(false)
    expect(sameChatContext(base, { ...base, path: 'b.ts' })).toBe(false)
  })
})

describe('chatContextLabel', () => {
  it('names the target exactly', () => {
    expect(chatContextLabel(WHOLE_PR)).toBe('whole PR')
    expect(chatContextLabel({ kind: 'file', path: 'src/app.ts' })).toBe('src/app.ts')
    expect(chatContextLabel({ kind: 'lines', path: 'a.ts', side: 'new', start: 40, end: 52 })).toBe('a.ts lines 40–52')
    expect(chatContextLabel({ kind: 'lines', path: 'a.ts', side: 'new', start: 7, end: 7 })).toBe('a.ts line 7')
    expect(chatContextLabel({ kind: 'lines', path: 'a.ts', side: 'old', start: 7, end: 7 })).toBe(
      'a.ts line 7 (old side)'
    )
  })

  it('uses the layer title when it can find one', () => {
    expect(chatContextLabel({ kind: 'layer', layerId: 'layer-1' }, () => 'Run path')).toBe('layer · Run path')
    expect(chatContextLabel({ kind: 'layer', layerId: 'layer-1' })).toBe('layer layer-1')
  })
})

describe('chatContextFromElement and chatContextAttrs', () => {
  it('reads back what the attributes wrote, for every kind', () => {
    /** @type {import('./chat-context.js').ChatContext[]} */
    const contexts = [
      WHOLE_PR,
      { kind: 'layer', layerId: 'layer-1' },
      { kind: 'file', path: 'src/app.ts' },
      { kind: 'lines', path: 'src/app.ts', side: 'old', start: 2, end: 5 },
      { kind: 'point', fingerprint: 'fp-1' },
    ]
    for (const context of contexts) {
      const attrs = Object.fromEntries(
        [...chatContextAttrs(context).matchAll(/([a-z-]+)="([^"]*)"/g)].map(m => [m[1] ?? '', m[2] ?? ''])
      )
      expect(chatContextFromElement(el(attrs))).toEqual(context)
    }
  })

  it('falls back to the file when the line numbers make no range', () => {
    expect(chatContextFromElement(el({ 'data-ask-path': 'a.ts', 'data-ask-start': '0', 'data-ask-end': '2' }))).toEqual(
      { kind: 'file', path: 'a.ts' }
    )
    expect(chatContextFromElement(el({ 'data-ask-path': 'a.ts', 'data-ask-start': '5', 'data-ask-end': '2' }))).toEqual(
      { kind: 'file', path: 'a.ts' }
    )
  })

  it('escapes a path that would otherwise break out of the attribute', () => {
    const attrs = chatContextAttrs({ kind: 'file', path: 'a"><script>x</script>.ts' })
    expect(attrs).not.toContain('<script>')
    expect(attrs).toContain('&quot;')
  })
})

describe('askButtonHtml', () => {
  it('renders nothing at all while the pane is off', () => {
    setChatEnabled(false)
    expect(isChatEnabled()).toBe(false)
    expect(askButtonHtml({ kind: 'file', path: 'a.ts' })).toBe('')
    expect(askButtonHtml({ kind: 'file', path: 'a.ts' }, { enabled: true })).toContain('data-act="ask"')
  })

  it('carries the target and the label once the pane is on', () => {
    setChatEnabled(true)
    const html = askButtonHtml({ kind: 'layer', layerId: 'layer-1' }, { label: 'ask about this layer' })
    expect(html).toContain('data-act="ask"')
    expect(html).toContain('data-ask-layer="layer-1"')
    expect(html).toContain('>ask about this layer<')
    setChatEnabled(false)
  })
})

describe('attention-point context', () => {
  const point = /** @type {const} */ ({ kind: 'point', fingerprint: 'fp-1' })

  it('writes the fingerprint as its only attribute', () => {
    expect(chatContextAttrs(point)).toBe(' data-ask-point="fp-1"')
  })

  it('names the point in the chip when the title resolves, and stays generic otherwise', () => {
    expect(chatContextLabel(point, undefined, () => 'Sum instead of product')).toBe('point · Sum instead of product')
    expect(chatContextLabel(point)).toBe('attention point')
  })

  it('matches only the same point', () => {
    expect(sameChatContext(point, { kind: 'point', fingerprint: 'fp-1' })).toBe(true)
    expect(sameChatContext(point, { kind: 'point', fingerprint: 'fp-2' })).toBe(false)
    expect(sameChatContext(point, { kind: 'file', path: 'a.ts' })).toBe(false)
  })
})
