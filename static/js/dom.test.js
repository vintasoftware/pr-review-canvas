// @ts-check
// @vitest-environment happy-dom
import {
  chevronHtml,
  copyToClipboard,
  detailsSummaryHtml,
  esc,
  flash,
  fragment,
  initials,
  qs,
  scrollIntoViewSafe,
  timeAgo,
} from './dom.js'

describe('esc', () => {
  it('escapes the five HTML metacharacters and stringifies other values', () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    expect(esc(12)).toBe('12')
  })
})

describe('fragment', () => {
  it('parses a fragment', () => {
    expect(fragment('<b>a</b><i>b</i>').childNodes.length).toBe(2)
  })
})

describe('chevronHtml and detailsSummaryHtml', () => {
  it('renders the chevron button with its expanded state and escaped label', () => {
    expect(chevronHtml('Collapse file')).toBe(
      '<button class="chev" type="button" aria-expanded="true" aria-label="Collapse file">&gt;</button>'
    )
    expect(chevronHtml('a "b"', false)).toBe(
      '<button class="chev" type="button" aria-expanded="false" aria-label="a &quot;b&quot;">&gt;</button>'
    )
  })

  it('puts a collapsed chevron before the title and reports open when asked', () => {
    expect(detailsSummaryHtml('<span>T</span>', 'Toggle T')).toBe(
      `<summary>${chevronHtml('Toggle T', false)}<span>T</span></summary>`
    )
    document.body.innerHTML = `<details open>${detailsSummaryHtml('<span>T</span>', 'Toggle T', { open: true })}</details>`
    expect(document.querySelector('summary > .chev')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('summary .chev + span')?.textContent).toBe('T')
  })
})

describe('qs, flash, scrollIntoViewSafe', () => {
  it('queries, flashes for a while, and scrolls without throwing', () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="a"></div>'
    const el = qs('#a')
    expect(el).not.toBeNull()
    expect(qs('#missing')).toBeNull()
    if (!el) {
      throw new Error('missing')
    }
    flash(el, 100)
    expect(el.classList.contains('is-target')).toBe(true)
    vi.advanceTimersByTime(100)
    expect(el.classList.contains('is-target')).toBe(false)
    const scrolled = vi.fn()
    Object.defineProperty(el, 'scrollIntoView', { value: scrolled, configurable: true })
    scrollIntoViewSafe(el)
    expect(scrolled).toHaveBeenCalledWith({ block: 'center' })
    Object.defineProperty(el, 'scrollIntoView', { value: undefined, configurable: true })
    expect(() => scrollIntoViewSafe(el)).not.toThrow()
    vi.useRealTimers()
  })
})

describe('timeAgo and initials', () => {
  it('formats relative times', () => {
    const now = new Date('2026-09-10T12:00:00Z')
    expect(timeAgo('2026-09-10T11:59:50Z', now)).toBe('just now')
    expect(timeAgo('2026-09-10T11:48:00Z', now)).toBe('12 min ago')
    expect(timeAgo('2026-09-10T09:00:00Z', now)).toBe('3 h ago')
    expect(timeAgo('2026-09-05T12:00:00Z', now)).toBe('5 d ago')
    expect(timeAgo('not a date', now)).toBe('')
  })

  it('derives avatar initials', () => {
    expect(initials('octocat')).toBe('OC')
    expect(initials('jane-doe')).toBe('JD')
    expect(initials('github-actions[bot]')).toBe('GA')
    expect(initials('')).toBe('?')
  })
})

describe('copyToClipboard', () => {
  it('writes through the clipboard API and fails with a message when there is none', async () => {
    const written = /** @type {string[]} */ ([])
    const clipboard = /** @type {Clipboard} */ (
      /** @type {unknown} */ ({ writeText: async (/** @type {string} */ t) => void written.push(t) })
    )
    await copyToClipboard('/pr-review-canvas 7', clipboard)
    expect(written).toEqual(['/pr-review-canvas 7'])
    await expect(copyToClipboard('x', null)).rejects.toThrow('clipboard is not available; copy the command by hand')
    await expect(copyToClipboard('x', /** @type {Clipboard} */ (/** @type {unknown} */ ({})))).rejects.toThrow(
      /not available/
    )
  })
})
