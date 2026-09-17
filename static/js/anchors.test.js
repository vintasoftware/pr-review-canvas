// @ts-check
// @vitest-environment happy-dom
import { cssEscape, findRow, jumpTo, keyFromPath, nearestRow } from './anchors.js'

function table() {
  document.body.innerHTML = `
    <section id="layer-auth"></section>
    <article class="file" id="file-src_app_ts"><div class="file-body" hidden>
    <table class="diff" id="chunk-src_app_ts-1" data-key="src_app_ts"><tbody>
      <tr id="L-src_app_ts-new-1" data-old="1" class="ctx"></tr>
      <tr id="L-src_app_ts-old-2" class="del"></tr>
      <tr id="L-src_app_ts-new-2" class="add folded noise"></tr>
      <tr id="L-src_app_ts-new-3" class="add"></tr>
      <tr id="L-src_app_ts-new-8" class="add"></tr>
    </tbody></table></div></article>`
}

describe('findRow and nearestRow', () => {
  beforeEach(table)

  it('finds new-side rows by id and old-side context rows by data-old', () => {
    expect(findRow(document, 'src_app_ts', 'new', 3)?.id).toBe('L-src_app_ts-new-3')
    expect(findRow(document, 'src_app_ts', 'old', 2)?.id).toBe('L-src_app_ts-old-2')
    expect(findRow(document, 'src_app_ts', 'old', 1)?.id).toBe('L-src_app_ts-new-1')
    expect(findRow(document, 'src_app_ts', 'new', 99)).toBeNull()
    expect(findRow(document, 'other', 'old', 1)).toBeNull()
  })

  it('skips folded rows and reports approximate hits', () => {
    expect(nearestRow(document, 'src_app_ts', 'new', 3)).toEqual({
      row: findRow(document, 'src_app_ts', 'new', 3),
      approx: false,
    })
    expect(nearestRow(document, 'src_app_ts', 'new', 2)).toEqual({
      row: findRow(document, 'src_app_ts', 'new', 1),
      approx: true,
    })
    expect(nearestRow(document, 'src_app_ts', 'new', 6)).toEqual({
      row: findRow(document, 'src_app_ts', 'new', 8),
      approx: true,
    })
    expect(nearestRow(document, 'src_app_ts', 'new', 200, 5)).toBeNull()
    expect(nearestRow(document, 'src_app_ts', 'old', 1)?.approx).toBe(false)
    expect(nearestRow(document, 'other', 'new', 1, 3)).toBeNull()
  })
})

describe('jumpTo', () => {
  beforeEach(table)

  it('asks a card that has not drawn its diff to draw it, then jumps into it', () => {
    document.body.innerHTML =
      '<pr-file><article class="file" id="file-src_late_ts"><div class="file-body"></div></article></pr-file>'
    const host = document.querySelector('pr-file')
    let drawn = 0
    // The page's `pr-file` draws its own diff; the test element answers the same call.
    Object.assign(host ?? {}, {
      renderNow: () => {
        drawn += 1
        const body = host?.querySelector('.file-body')
        if (body) {
          body.innerHTML = '<table class="diff" id="chunk-src_late_ts-1" data-key="src_late_ts"></table>'
        }
        return true
      },
    })
    expect(jumpTo('#chunk:src/late.ts#1')).toBe(true)
    expect(drawn).toBe(1)
  })

  it('jumps without a card element, and to a target that never appears', () => {
    document.body.innerHTML = '<article class="file" id="file-src_bare_ts"></article>'
    expect(jumpTo('#file:src/bare.ts')).toBe(true)
    expect(jumpTo('#chunk:src/bare.ts#2')).toBe(false)
  })

  it('scrolls to and flashes the link target, opening a collapsed card', () => {
    expect(jumpTo('#line:src/app.ts:3')).toBe(true)
    const row = findRow(document, 'src_app_ts', 'new', 3)
    expect(row?.classList.contains('is-target')).toBe(true)
    expect(document.querySelector('.file-body')?.hasAttribute('hidden')).toBe(false)
    expect(jumpTo('#layer:auth')).toBe(true)
    expect(jumpTo('#chunk:src/app.ts#1')).toBe(true)
    expect(jumpTo('#file:src/app.ts')).toBe(true)
  })

  it('returns false for unknown targets and malformed links', () => {
    expect(jumpTo('#chunk:src/app.ts#9')).toBe(false)
    expect(jumpTo('#nope')).toBe(false)
  })
})

describe('helpers', () => {
  it('sanitizes keys and escapes css identifiers with or without CSS.escape', () => {
    expect(keyFromPath('a/b.ts')).toBe('a_b_ts')
    expect(cssEscape('L-a_b-new-1')).toBe('L-a_b-new-1')
    const saved = globalThis.CSS
    vi.stubGlobal('CSS', undefined)
    expect(cssEscape('a.b#c')).toBe('a\\.b\\#c')
    vi.stubGlobal('CSS', saved)
  })
})
