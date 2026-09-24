// @ts-check
// @vitest-environment happy-dom
import { DECK_KEY_HELP } from './deck-state.js'
import { cardHtml, deckHelpHtml, drawerHtml, finishHtml, pipsHtml, stackHtml } from './deck-view.js'

/** @typedef {import('./deck-state.js').DecisionCard} DecisionCard */
/** @typedef {import('./deck-state.js').Pick} Pick */

/**
 * @param {Partial<DecisionCard>} [over]
 * @returns {DecisionCard}
 */
function card(over = {}) {
  return {
    key: 'rows',
    bucket: 'trade-off',
    topic: 'Rare case vs simplify',
    title: 'What happens to empty rows?',
    context: 'The importer skips rows with no cells.',
    path: 'src/import.ts',
    line: 12,
    current: 'a',
    a: {
      label: 'Skip them',
      consequence: 'Old exports import.',
      why: 'Only old exports pad.',
      record: 'pr-comment',
    },
    b: { label: 'Fail loudly', consequence: 'Nothing is dropped.', why: 'Never drop data.', record: 'none' },
    ...over,
  }
}

/**
 * @param {Pick['choice']} choice
 * @param {Partial<Pick>} [over]
 * @returns {Pick}
 */
function pick(choice, over = {}) {
  return { choice, pickedAt: '2026-09-10T12:00:00.000Z', ...over }
}

/** @param {string} html */
function render(html) {
  document.body.innerHTML = html
  return document.body
}

describe('cardHtml', () => {
  it('shows what the generator wrote as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const root = render(
      cardHtml(
        card({ title: hostile, path: `a"${hostile}.ts`, a: { ...card().a, label: hostile, why: hostile } }),
        { index: 0, total: 1 }
      )
    )
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('h2')?.textContent).toBe(hostile)
    expect(root.querySelector('.deck-side-a h3')?.textContent).toBe(hostile)
    expect(root.querySelector('.deck-anchor')?.textContent).toContain(`a"${hostile}.ts:12`)
  })

  it('frames a side’s scene with no permission at all, under its one-line consequence', () => {
    const root = render(
      cardHtml(
        card({ key: 'a/b', b: { ...card().b, scene: '<p>x</p><img src=x onerror=alert(1)>' } }),
        { index: 0, total: 1 },
        { review: '42', theme: 'dark' }
      )
    )
    const frames = root.querySelectorAll('iframe')
    expect(frames).toHaveLength(1)
    const frame = /** @type {HTMLIFrameElement} */ (frames[0])
    expect(frame.closest('.deck-side-b')).not.toBeNull()
    // No script, forms, popups, or navigation; only the origin, so the page can fit the scene.
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin')
    expect(frame.getAttribute('src')).toBe('/deck-scene/42/a%2Fb/b?theme=dark')
    expect(root.querySelector('.deck-side-b .deck-gist')?.textContent?.trim()).toBe('Nothing is dropped.')
    // The scene's HTML reaches the page only through the frame.
    expect(root.innerHTML).not.toContain('<p>x</p>')
    expect(root.querySelector('img')).toBeNull()
    // A side without a scene shows its consequence alone.
    expect(root.querySelector('.deck-side-a')?.hasAttribute('data-plain')).toBe(true)
    expect(root.querySelector('.deck-side-a .deck-gist')?.textContent?.trim()).toBe('Old exports import.')
  })

  it('keeps the headline and consequences on the front, and the reasons and code on the back', () => {
    const excerpt = {
      path: 'src/import.ts',
      header: '@@ -10,2 +10,3 @@',
      oldStart: 10,
      newStart: 10,
      lines: [' const rows = read()', '+if (empty(row)) continue', '+drop(rows)'],
    }
    const root = render(
      cardHtml(
        card({ line: 11, a: { ...card().a, snippet: { code: 'skip()' } } }),
        { index: 0, total: 1 },
        { excerpt }
      )
    )
    const front = /** @type {HTMLElement} */ (root.querySelector('.deck-front'))
    const back = /** @type {HTMLElement} */ (root.querySelector('.deck-back'))
    expect(front.querySelectorAll('h3')).toHaveLength(2)
    expect(front.querySelectorAll('[data-pick]')).toHaveLength(2)
    expect(front.textContent).not.toContain('The importer skips rows')
    expect(front.querySelector('[data-why], .deck-snippet, .deck-diff')).toBeNull()
    expect(back.querySelector('.deck-context')?.textContent?.trim()).toBe(
      'The importer skips rows with no cells.'
    )
    expect(back.querySelector('[data-detail="a"] [data-why-text]')?.textContent).toBe('Only old exports pad.')
    expect(back.querySelector('[data-detail="b"] [data-record-chip]')?.textContent).toBe('not recorded')
    expect(back.querySelector('[data-detail="a"] .deck-snippet')?.textContent).toBe('skip()')
    // The consequences are on the front only.
    expect(back.textContent).not.toContain('Old exports import.')
    // The anchored chunk, its anchor line marked.
    expect(back.querySelector('.deck-back-code-h')?.textContent).toBe('src/import.ts:11 @@ -10,2 +10,3 @@')
    expect(back.querySelector('.deck-diff-here')?.textContent).toContain('if (empty(row)) continue')
    // Every way to the back says it is off, until the card turns.
    expect(
      [...root.querySelectorAll('[data-act="details"]')].map(b => b.getAttribute('aria-pressed'))
    ).toEqual(['false', 'false'])
  })

  it('points to the back from a folded corner that names its key', () => {
    const root = render(cardHtml(card(), { index: 0, total: 1 }))
    const corner = /** @type {HTMLElement} */ (root.querySelector('.deck-corner'))
    expect(corner.getAttribute('data-act')).toBe('details')
    expect(corner.querySelector('.deck-corner-front')?.textContent).toBe('i reasons and code on the back')
    expect(corner.querySelector('.deck-corner-back')?.textContent).toBe('i back to the front')
  })

  it('says so when the anchored chunk has left the diff', () => {
    const root = render(cardHtml(card({ side: 'old' }), { index: 0, total: 1 }))
    expect(root.querySelector('.deck-back-code')?.textContent).toBe(
      "src/import.ts:12 (old)This chunk is not in this clone's diff anymore."
    )
  })

  it('marks only the side the code implements now, and neither when it does neither', () => {
    let root = render(cardHtml(card({ current: 'b' }), { index: 0, total: 1 }))
    expect(root.querySelector('.deck-side-a .deck-now')).toBeNull()
    expect(root.querySelector('.deck-side-b .deck-now')?.textContent).toBe('in code now')
    root = render(cardHtml(card({ current: null }), { index: 0, total: 1 }))
    expect(root.querySelectorAll('.deck-now')).toHaveLength(0)
  })

  it('says where the card is in the deck and which side of the diff it is anchored to', () => {
    const root = render(cardHtml(card({ side: 'old' }), { index: 1, total: 5 }))
    expect(root.querySelector('.deck-count')?.textContent).toBe('2 / 5')
    expect(root.querySelector('.deck-anchor')?.textContent).toContain('src/import.ts:12 (old)')
    expect(root.querySelector('.deck-bucket')?.textContent).toBe('Trade-off')
  })

  it('highlights a snippet in its language, and escapes one in a language it does not know', () => {
    let root = render(
      cardHtml(card({ a: { ...card().a, snippet: { code: 'const x = 1\n' } } }), { index: 0, total: 1 })
    )
    const code = root.querySelector('.deck-side-a .deck-snippet code')
    expect(code?.textContent).toBe('const x = 1')
    expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const')
    expect(root.querySelector('.deck-side-b .deck-snippet')).toBeNull()

    root = render(
      cardHtml(card({ a: { ...card().a, snippet: { lang: 'not-a-language', code: '<b>x</b>' } } }), {
        index: 0,
        total: 1,
      })
    )
    expect(root.querySelector('.deck-snippet b')).toBeNull()
    expect(root.querySelector('.deck-snippet code')?.textContent).toBe('<b>x</b>')
  })

  it('preselects each side’s record target and labels its chip', () => {
    const root = render(cardHtml(card(), { index: 0, total: 1 }))
    // Read the `selected` attribute: happy-dom resolves `select.value` wrongly when the last option
    // is the selected one. Chromium reads it right; browser/deck.spec.ts drives the real control.
    const preselected = (/** @type {string} */ side) =>
      root.querySelector(`[data-record-select="${side}"] option[selected]`)?.getAttribute('value')
    expect(preselected('a')).toBe('pr-comment')
    expect(preselected('b')).toBe('none')
    expect(root.querySelectorAll('[data-record-select="b"] option[selected]')).toHaveLength(1)
    expect(root.querySelector('[data-record-chip="a"]')?.textContent).toBe('PR comment')
    expect(root.querySelector('[data-record-chip="b"]')?.textContent).toBe('not recorded')
    expect(/** @type {HTMLTextAreaElement} */ (root.querySelector('[data-why="b"]')).value).toBe(
      'Never drop data.'
    )
  })

  it('shows a bucket it has no label for as written, so a newer generator still renders', () => {
    const root = render(cardHtml(card({ bucket: 'ethics' }), { index: 0, total: 1 }))
    expect(root.querySelector('.deck-bucket')?.textContent).toBe('ethics')
  })

  it('names the pick keys after the sides', () => {
    const root = render(cardHtml(card(), { index: 0, total: 1 }))
    expect(root.querySelector('[data-pick="a"]')?.textContent).toBe('a pick A')
    expect(root.querySelector('[data-pick="b"]')?.textContent).toBe('b pick B')
  })
})

describe('stackHtml', () => {
  it('puts the next card right behind the top one', () => {
    const root = render(
      stackHtml([card({ key: 'next', title: 'Next' }), card({ key: 'later', title: 'Later' })])
    )
    expect(root.querySelector('.deck-ghost-1')?.textContent).toBe('Next')
    expect(root.querySelector('.deck-ghost-2')?.textContent).toBe('Later')
    // The nearer ghost is drawn last, so it paints over the farther one.
    expect([...root.querySelectorAll('.deck-ghost')].map(g => g.textContent)).toEqual(['Later', 'Next'])
    expect(render(stackHtml([])).innerHTML).toBe('')
  })
})

describe('pipsHtml', () => {
  it('shows each card’s answer, flags the picks that ask for a fix, and rings the top card', () => {
    const cards = [card({ key: 'kept' }), card({ key: 'fix' }), card({ key: 'skip' }), card({ key: 'open' })]
    const root = render(pipsHtml(cards, { kept: pick('a'), fix: pick('b'), skip: pick('skip') }, 'open'))
    const pips = [...root.querySelectorAll('.deck-pip')]
    expect(pips.map(p => p.getAttribute('data-state'))).toEqual(['a', 'b', 'skip', 'open'])
    expect(pips.map(p => p.hasAttribute('data-fix'))).toEqual([false, true, false, false])
    expect(pips.map(p => p.getAttribute('aria-current'))).toEqual([null, null, null, 'step'])
    expect(pips[2]?.getAttribute('title')).toBe('What happens to empty rows?: skipped')
  })
})

describe('drawerHtml', () => {
  const excerpt = {
    path: 'src/import.ts',
    header: '@@ -10,3 +10,4 @@',
    oldStart: 10,
    newStart: 10,
    lines: [' const rows = read()', '-skip(rows)', '+drop(rows)', '+log(rows)', ' return rows'],
  }

  /** @param {Element} root */
  const numbers = root =>
    [...root.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('.ln')].map(td => td.textContent))

  it('numbers each side the way the diff counts it, and marks the anchored line', () => {
    const root = render(drawerHtml(card({ line: 12 }), excerpt))
    expect(numbers(root)).toEqual([
      ['10', '10'],
      ['11', ''],
      ['', '11'],
      ['', '12'],
      ['12', '13'],
    ])
    expect(root.querySelector('.deck-diff-here')?.textContent).toContain('log(rows)')
    expect(root.querySelectorAll('.deck-diff-here')).toHaveLength(1)
  })

  it('reads a blank patch line as context, not as a change', () => {
    const root = render(drawerHtml(card({ line: 11 }), { ...excerpt, lines: [' a', '', ' c'] }))
    expect([...root.querySelectorAll('tr')].map(tr => tr.className)).toEqual([
      'deck-diff-ctx',
      'deck-diff-ctx deck-diff-here',
      'deck-diff-ctx',
    ])
  })

  it('marks an old-side anchor by its old line number', () => {
    const root = render(drawerHtml(card({ line: 11, side: 'old' }), excerpt))
    expect(root.querySelector('.deck-diff-here')?.textContent).toContain('skip(rows)')
  })

  it('says so when the chunk is gone from the diff, and still offers a way to close', () => {
    const root = render(drawerHtml(card(), undefined))
    expect(root.textContent).toContain('src/import.ts:12')
    expect(root.textContent).toContain('not in this clone')
    expect(root.querySelector('.deck-drawer-close')).not.toBeNull()
  })
})

describe('finishHtml', () => {
  const summary = { fixes: 0, records: 0, comments: 0, skipped: 0, open: 0 }

  it('celebrates an empty deck without a tally or a fix command', () => {
    const root = render(
      finishHtml({ review: 'branch', cards: [], picks: {}, summary, fixes: null, settled: 0 })
    )
    expect(root.querySelector('h2')?.textContent).toBe('Nothing needs your call')
    expect(root.querySelector('.deck-tally')).toBeNull()
    expect(root.querySelector('.deck-run')).toBeNull()
  })

  it('offers the fix skill for this review only when there is something to fix or write down', () => {
    const cards = [card()]
    let root = render(
      finishHtml({ review: '42', cards, picks: { rows: pick('a') }, summary, fixes: null, settled: 0 })
    )
    expect(root.textContent).toContain('Nothing to fix')
    expect(root.querySelector('[data-copy]')).toBeNull()

    root = render(
      finishHtml({
        review: '42',
        cards,
        picks: { rows: pick('b') },
        summary: { ...summary, fixes: 1 },
        fixes: {
          path: '/data/decks/42/fixes.md',
          markdown: '# Self-review fix list\n\n- one <script>x</script>',
        },
        settled: 1,
      })
    )
    expect(root.querySelector('.deck-run code')?.textContent).toBe('/pr-self-review-fix 42')
    expect(root.querySelector('.deck-tally-fixes .deck-tally-n')?.textContent).toBe('1')
    expect(root.querySelector('.deck-fixes-path')?.textContent).toContain('/data/decks/42/fixes.md')
    expect(root.querySelector('.deck-fixes-body script')).toBeNull()
    expect(root.textContent).toContain('1 decision settled in earlier decks')
  })

  it('tags every pick as a fix, kept, or open, and offers to change it', () => {
    const cards = [
      card({ key: 'kept', title: 'K' }),
      card({ key: 'fix', title: 'F' }),
      card({ key: 'left', title: 'L' }),
    ]
    const root = render(
      finishHtml({
        review: 'branch',
        cards,
        picks: { kept: pick('a'), fix: pick('neither', { note: 'log it' }), left: pick('skip') },
        summary: { ...summary, fixes: 1, skipped: 1 },
        fixes: null,
        settled: 3,
      })
    )
    const rows = [...root.querySelectorAll('.deck-picks li')].map(li => [
      li.querySelector('.deck-tag')?.textContent,
      li.querySelector('strong')?.textContent,
      li.querySelector('[data-reopen]')?.getAttribute('data-reopen'),
    ])
    expect(rows).toEqual([
      ['kept', 'K', 'kept'],
      ['fix', 'F', 'fix'],
      ['open', 'L', 'left'],
    ])
    expect(root.textContent).toContain('neither: log it')
    expect(root.textContent).toContain('3 decisions settled')
  })

  it('lists only answered cards among the picks', () => {
    const cards = [card({ key: 'done', title: 'Done' }), card({ key: 'open', title: 'Open' })]
    const root = render(
      finishHtml({ review: 'branch', cards, picks: { done: pick('a') }, summary, fixes: null, settled: 0 })
    )
    expect([...root.querySelectorAll('.deck-picks strong')].map(s => s.textContent)).toEqual(['Done'])
  })
})

describe('deckHelpHtml', () => {
  it('lists every key the deck answers to', () => {
    const root = render(deckHelpHtml())
    const keys = [...root.querySelectorAll('td.mono')].map(td => td.textContent)
    expect(keys).toEqual(DECK_KEY_HELP.map(r => r.keys))
    expect(keys).toContain('a')
    expect(keys).toContain('b')
  })
})
