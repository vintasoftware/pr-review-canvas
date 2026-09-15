// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { findRow } from './anchors.js'
import { applyCodeFolds, setFoldShown, wireFoldReveal } from './code-folds.js'
import { followLink } from './deep-link.js'
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

const FOLD = { title: 'run()', side: /** @type {const} */ ('new'), startLine: 1, endLine: 4 }

function mount() {
  document.body.innerHTML = '<article class="file" id="file-src_app_ts"><div class="file-body"></div></article>'
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

afterEach(() => document.body.replaceChildren())

describe('applyCodeFolds', () => {
  it('shows only the title and expands all rows between the anchors, including deletions', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD])

    expect(toggle(card).textContent).toBe('run()')
    expect(toggle(card).getAttribute('aria-expanded')).toBe('false')
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

    toggle(card).click()
    expect(findRow(card, 'src_app_ts', 'old', 2)?.hidden).toBe(true)
  })

  it('opens a fold when a deep link points to one of its lines', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD])

    expect(followLink('#line:src/app.ts:3', document.body)).toBe(true)
    expect(findRow(card, 'src_app_ts', 'new', 3)?.hidden).toBe(false)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
  })

  it('opens the folds of a linked hunk', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [FOLD])

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
    applyCodeFolds(card, 'src_app_ts', [FOLD])

    expect(followLink('#line:src/app.ts:3', document.body)).toBe(true)
    expect(row?.hidden).toBe(false)
    expect(row?.classList.contains('is-approx')).toBe(false)
    expect(summary.hidden).toBe(true)
    expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a hunk with a GitHub discussion open even outside the requested range', () => {
    const card = mount()
    const discussion = document.createElement('tr')
    discussion.setAttribute('data-decoration', 'thread')
    findRow(card, 'src_app_ts', 'new', 5)?.after(discussion)

    applyCodeFolds(card, 'src_app_ts', [FOLD])
    expect(card.querySelector('.code-fold')).toBeNull()
  })

  it.each(['note', 'point', 'thread'])('keeps a range containing a %s visible', decoration => {
    const card = mount()
    const row = findRow(card, 'src_app_ts', 'new', 4)
    const discussion = document.createElement('tr')
    discussion.setAttribute('data-decoration', decoration)
    row?.after(discussion)

    applyCodeFolds(card, 'src_app_ts', [FOLD])
    expect(card.querySelector('.code-fold')).toBeNull()
    expect(row?.hidden).toBe(false)
  })

  it('keeps invalid ranges visible and avoids duplicate folds on a repeated call', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [
      { ...FOLD, endLine: 500 },
      { ...FOLD, startLine: 4, endLine: 1 },
    ])
    expect(card.querySelector('.code-fold')).toBeNull()

    applyCodeFolds(card, 'src_app_ts', [FOLD])
    applyCodeFolds(card, 'src_app_ts', [FOLD])
    expect(Array.from(card.querySelectorAll('.code-fold'), row => row.textContent)).toEqual(['run()'])
  })

  it('treats the title as plain text', () => {
    const card = mount()
    applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, title: '<img src=x onerror=alert(1)>' }])

    expect(toggle(card).textContent).toBe('<img src=x onerror=alert(1)>')
    expect(card.querySelector('img')).toBeNull()
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
  document.body.innerHTML = '<article class="file" id="file-src_app_ts"><div class="file-body"></div></article>'
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

it('leaves reversed ranges open', () => {
  const card = mount()
  applyCodeFolds(card, 'src_app_ts', [{ ...FOLD, startLine: 4, endLine: 1 }])
  expect(card.querySelector('.code-fold')).toBeNull()
  expect(card.querySelector('tr[hidden]')).toBeNull()
})

it('leaves ranges spanning separate table bodies open', () => {
  const card = mount()
  const last = findRow(card, 'src_app_ts', 'new', 4)
  const table = card.querySelector('table')
  if (!last || !table) throw new Error('missing diff')
  const body = document.createElement('tbody')
  table.appendChild(body)
  body.appendChild(last)
  applyCodeFolds(card, 'src_app_ts', [FOLD])
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
