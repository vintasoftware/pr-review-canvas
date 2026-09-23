// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { findRow } from './anchors.js'
import { applyCodeFolds, setCodeFoldLevel, setFoldShown, wireFoldReveal } from './code-folds.js'
import { followLink } from './deep-link.js'
import { insertNoteRow } from './diff-decorations.js'
import { renderDiff } from './diff-renderer.js'
import { scrollIntoViewSafe } from './dom.js'

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' export function run() {',
  '-  return 1',
  '+  const value = 2',
  '+  return value',
  ' }',
  ' export const more = true',
].join('\n')

const FOLD = {
  title: 'run()',
  side: /** @type {const} */ ('new'),
  startLine: 1,
  endLine: 4,
  level: /** @type {const} */ ('light'),
}

function mount() {
  document.body.innerHTML =
    '<article class="file" id="file-src_app_ts"><div class="file-body"></div></article>'
  const card = document.querySelector('article')
  const body = document.querySelector('.file-body')

  if (!(card instanceof HTMLElement && body instanceof HTMLElement)) {
    throw new Error('missing file card')
  }

  body.innerHTML = renderDiff({ key: 'src_app_ts', path: 'src/app.ts' }, PATCH)
  return card
}

/** @param {ParentNode} card */
function toggle(card) {
  const button = card.querySelector('.code-fold button')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('missing fold toggle')
  }

  return button
}

/**
 * The titles a reader sees, in page order.
 * @param {ParentNode} card
 */
function shownTitles(card) {
  return Array.from(card.querySelectorAll('.code-fold:not([hidden]) button'), button => button.textContent)
}

afterEach(() => document.body.replaceChildren())

describe('applyCodeFolds', () => {
  it('shows the title and line count, and expands all rows between the anchors, including deletions', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    const count = () => card.querySelector('.code-fold .fold-lines')?.textContent

    expect(toggle(card).textContent).toBe('run()')
    expect(toggle(card).getAttribute('aria-expanded')).toBe('false')
    expect(count()).toBe(' · 5 lines hidden')
    expect(Array.from(card.querySelectorAll('tr[hidden]'), row => row.id)).toEqual([
      'L-src_app_ts-new-1',
      'L-src_app_ts-old-2',
      'L-src_app_ts-new-2',
      'L-src_app_ts-new-3',
      'L-src_app_ts-new-4',
    ])
    expect(findRow(card, 'src_app_ts', 'new', 5)?.hidden).toBe(false)

    toggle(card).click()
    expect(card.querySelector('tr[hidden]')).toBeNull()
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
    expect(count()).toBe(' · 5 lines')

    toggle(card).click()
    expect(findRow(card, 'src_app_ts', 'old', 2)?.hidden).toBe(true)
    expect(count()).toBe(' · 5 lines hidden')
  })

  it('opens a fold when a deep link points to one of its lines', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)

    expect(followLink('#line:src/app.ts:3', document.body)).toBe(true)
    expect(findRow(card, 'src_app_ts', 'new', 3)?.hidden).toBe(false)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves a fold the level has not reached alone when a deep link lands in it', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, level: 'moderate' }], 'light', false)

    expect(followLink('#line:src/app.ts:3', document.body)).toBe(true)
    setCodeFoldLevel(card, 'moderate', false)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('false')
    expect(findRow(card, 'src_app_ts', 'new', 3)?.hidden).toBe(true)
  })

  it('opens the folds of a linked hunk', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)

    expect(followLink('#hunk:src/app.ts#1', document.body)).toBe(true)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
  })

  it('reveals whitespace rows at their exact deep-link anchor', () => {
    const card = mount()
    const row = findRow(card, 'src_app_ts', 'new', 3)
    row?.classList.add('folded')
    const summary = document.createElement('tr')
    summary.className = 'more fold'
    row?.before(summary)
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)

    expect(followLink('#line:src/app.ts:3', document.body)).toBe(true)
    expect(row?.hidden).toBe(false)
    expect(row?.classList.contains('is-approx')).toBe(false)
    expect(summary.hidden).toBe(true)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
  })

  it.each(['note', 'point', 'thread'])('keeps a range containing a %s visible', decoration => {
    const card = mount()
    const row = findRow(card, 'src_app_ts', 'new', 4)
    const discussion = document.createElement('tr')
    discussion.setAttribute('data-decoration', decoration)
    row?.after(discussion)

    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    expect(card.querySelector('.code-fold')).toBeNull()
    expect(row?.hidden).toBe(false)
  })

  it('keeps invalid ranges visible', () => {
    const card = mount()
    applyCodeFolds(
      card,
      'src_app_ts',
      [
        { ...FOLD, endLine: 500 },
        { ...FOLD, startLine: 4, endLine: 1 },
      ],
      'light',
      false
    )
    expect(card.querySelector('.code-fold')).toBeNull()
  })

  it('wires a drawn diff once, so a repeated call adds no second title', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    expect(Array.from(card.querySelectorAll('.code-fold button'), button => button.textContent)).toEqual([
      'run()',
    ])
  })

  it('treats the title as plain text', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, title: '<img src=x onerror=alert(1)>' }], 'light', false)

    expect(toggle(card).textContent).toBe('<img src=x onerror=alert(1)>')
    expect(card.querySelector('img')).toBeNull()
  })

  it('applies a fold only from its own level upwards, without redrawing the diff', () => {
    const card = mount()
    const fold = { ...FOLD, level: /** @type {const} */ ('moderate') }
    const table = card.querySelector('table')
    const draft = document.createElement('tr')
    draft.className = 'composer'
    findRow(card, 'src_app_ts', 'new', 5)?.after(draft)

    applyCodeFolds(card, 'src_app_ts', [fold], 'light', false)
    expect(shownTitles(card)).toEqual([])
    expect(card.querySelector('tr[hidden]:not(.code-fold)')).toBeNull()

    setCodeFoldLevel(card, 'moderate', false)
    expect(shownTitles(card)).toEqual(['run()'])
    expect(findRow(card, 'src_app_ts', 'new', 2)?.hidden).toBe(true)

    setCodeFoldLevel(card, 'light', false)
    expect(shownTitles(card)).toEqual([])
    expect(card.querySelector('tr[hidden]:not(.code-fold)')).toBeNull()
    expect(card.querySelector('table')).toBe(table)
    expect(draft.isConnected).toBe(true)
  })

  it('keeps a fold the reader expanded open while the level still applies it, and folds it again once it returns', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    toggle(card).click()

    setCodeFoldLevel(card, 'moderate', false)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
    expect(findRow(card, 'src_app_ts', 'new', 2)?.hidden).toBe(false)

    const nested = mount()
    const outer = { ...FOLD, title: 'the whole function', level: /** @type {const} */ ('moderate') }
    applyCodeFolds(nested, 'src_app_ts', [outer, { ...FOLD, startLine: 2, endLine: 3 }], 'light', false)
    setCodeFoldLevel(nested, 'moderate', false)
    setCodeFoldLevel(nested, 'light', false)
    expect(shownTitles(nested)).toEqual(['run()'])
    expect(findRow(nested, 'src_app_ts', 'new', 2)?.hidden).toBe(true)
    expect(findRow(nested, 'src_app_ts', 'new', 1)?.hidden).toBe(false)
  })

  it('turns every fold off once a thread sits in the card, and back on when it goes', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
    expect(shownTitles(card)).toEqual(['run()'])

    setCodeFoldLevel(card, 'light', true)
    expect(shownTitles(card)).toEqual([])
    expect(card.querySelector('tr[hidden]:not(.code-fold)')).toBeNull()

    setCodeFoldLevel(card, 'light', false)
    expect(shownTitles(card)).toEqual(['run()'])
  })

  it('draws only the outermost fold when one nests inside another', () => {
    const card = mount()
    const folds = [
      { ...FOLD, title: 'the whole function', level: /** @type {const} */ ('moderate') },
      {
        title: 'the body',
        side: /** @type {const} */ ('new'),
        startLine: 2,
        endLine: 3,
        level: /** @type {const} */ ('light'),
      },
    ]

    applyCodeFolds(card, 'src_app_ts', folds, 'light', false)
    expect(shownTitles(card)).toEqual(['the body'])

    setCodeFoldLevel(card, 'moderate', false)
    expect(shownTitles(card)).toEqual(['the whole function'])
  })

  it('hides an annotation only at the aggressive level, and shows its text instead of the title', () => {
    const annotation = {
      side: /** @type {const} */ ('new'),
      startLine: 3,
      endLine: 3,
      text: 'The value is read twice on purpose.',
    }

    const light = mount()
    insertNoteRow(light, 'src_app_ts', annotation)
    applyCodeFolds(light, 'src_app_ts', [{ ...FOLD, level: 'moderate' }], 'moderate', false)
    expect(light.querySelector('.code-fold')).toBeNull()

    document.body.replaceChildren()
    const card = mount()
    insertNoteRow(card, 'src_app_ts', annotation)
    applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, level: 'aggressive' }], 'aggressive', false)

    expect(toggle(card).textContent).toBe('The value is read twice on purpose.')
    expect(card.querySelector('[data-decoration="note"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('keeps an attention point visible at every level', () => {
    const card = mount()
    const point = document.createElement('tr')
    point.setAttribute('data-decoration', 'point')
    findRow(card, 'src_app_ts', 'new', 3)?.after(point)

    applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, level: 'aggressive' }], 'aggressive', false)
    expect(card.querySelector('.code-fold')).toBeNull()
  })
})

const NOISE_PATCH = [
  '@@ -1,3 +1,4 @@',
  " import { a } from './a'",
  "+import { b } from './b'",
  ' export function run() {',
  '   return a()',
].join('\n')

/** Mounts a diff whose second line is an import, which the renderer folds away as noise. */
function mountFolded() {
  document.body.innerHTML =
    '<article class="file" id="file-src_app_ts"><div class="file-body"></div></article>'
  const card = document.querySelector('article')
  const body = document.querySelector('.file-body')

  if (!(card instanceof HTMLElement && body instanceof HTMLElement)) {
    throw new Error('missing file card')
  }

  body.innerHTML = renderDiff({ key: 'src_app_ts', path: 'src/app.ts' }, NOISE_PATCH)
  return card
}

/** @param {ParentNode} card */
function foldSummary(card) {
  const row = card.querySelector('tr.more.fold')
  if (!(row instanceof HTMLTableRowElement)) {
    throw new Error('missing fold summary row')
  }

  return row
}

describe('setFoldShown', () => {
  it('starts hidden, then shows the folded rows and relabels the button', () => {
    const card = mountFolded()
    const summary = foldSummary(card)
    const button = summary.querySelector('button')
    const folded = card.querySelector('tr.folded')

    expect(button?.hasAttribute('disabled')).toBe(false)
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(folded?.classList.contains('shown')).toBe(false)

    setFoldShown(summary, true)
    expect(folded?.classList.contains('shown')).toBe(true)
    expect(button?.textContent).toBe('hide')
    expect(button?.getAttribute('aria-expanded')).toBe('true')

    setFoldShown(summary, false)
    expect(folded?.classList.contains('shown')).toBe(false)
    expect(button?.textContent).toBe('show')
  })
})

describe('wireFoldReveal', () => {
  it('shows the folded rows when a deep link lands on one of them', () => {
    const card = mountFolded()
    wireFoldReveal(card)
    const folded = card.querySelector('tr.folded')

    if (!(folded instanceof HTMLTableRowElement)) {
      throw new Error('missing folded row')
    }

    scrollIntoViewSafe(folded)
    expect(folded.classList.contains('shown')).toBe(true)
    expect(foldSummary(card).querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves the folded rows alone when the deep link lands elsewhere', () => {
    const card = mountFolded()
    wireFoldReveal(card)
    const other = findRow(card, 'src_app_ts', 'new', 3)

    if (other === null) {
      throw new Error('missing row')
    }

    scrollIntoViewSafe(other)
    expect(card.querySelector('tr.folded')?.classList.contains('shown')).toBe(false)
  })
})

it('leaves ranges spanning separate table bodies open', () => {
  const card = mount()
  const last = findRow(card, 'src_app_ts', 'new', 4)
  const table = card.querySelector('table')
  if (!last || !table) throw new Error('missing diff')
  const body = document.createElement('tbody')
  table.appendChild(body)
  body.appendChild(last)
  applyCodeFolds(card, 'src_app_ts', [FOLD], 'light', false)
  expect(card.querySelector('.code-fold')).toBeNull()
  expect(last.hidden).toBe(false)
})

it('ignores reveal events on folded rows without a summary', () => {
  const card = mount()
  const row = findRow(card, 'src_app_ts', 'new', 1)
  if (!row) throw new Error('missing diff row')
  row.classList.add('folded')
  wireFoldReveal(card)
  row.dispatchEvent(new CustomEvent('reveal-code', { bubbles: true }))
  expect(row.classList.contains('shown')).toBe(false)
})

it('includes a preceding noise summary when all of its rows belong to the code fold', () => {
  const card = mountFolded()
  const summary = foldSummary(card)
  applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, startLine: 2, endLine: 2 }], 'light', false)
  expect(summary.hidden).toBe(true)
  toggle(card).click()
  expect(summary.hidden).toBe(true)
  expect(findRow(card, 'src_app_ts', 'new', 2)?.hidden).toBe(false)
})

it('keeps a noise summary visible when its rows extend beyond the code fold', () => {
  const card = mountFolded()
  const summary = foldSummary(card)
  const next = findRow(card, 'src_app_ts', 'new', 3)
  if (!next) throw new Error('missing diff row')
  next.classList.add('folded')
  applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, startLine: 2, endLine: 2 }], 'light', false)
  expect(summary.hidden).toBe(false)
  expect(next.hidden).toBe(false)
  expect(toggle(card).getAttribute('aria-expanded')).toBe('false')
})
