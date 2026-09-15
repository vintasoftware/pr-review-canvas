// @ts-check
// @vitest-environment happy-dom
import {
  buildRows,
  codeHtml,
  detectMoves,
  highlightHunk,
  isImport,
  markNoise,
  pairChangedLines,
  parsePatch,
  prepareHunks,
  renderDiff,
  rowHtml,
  sameIgnoringWhitespace,
  splitHighlightedLines,
  wordDiff,
  wrapRanges,
} from './diff-renderer.js'

const PATCH = [
  '@@ -1,4 +1,5 @@',
  " import { a } from './a'",
  "+import { b } from './b'",
  ' export function run() {',
  '-  return a()',
  '+  return a() + b()',
  ' }',
  '@@ -10,3 +11,4 @@ export function other() {',
  '   const x = 1',
  '+  const y = 2',
  '   return x',
  ' }',
  '\\ No newline at end of file',
].join('\n')

describe('parsePatch', () => {
  it('numbers lines from the hunk headers and tracks consecutive changes', () => {
    const hunks = parsePatch(PATCH)
    expect(hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [1, 4, 1, 5],
      [10, 3, 11, 4],
    ])
    expect(hunks[0]?.entries.map(e => [e.type, e.oldLine, e.newLine, e.consecutive])).toEqual([
      ['ctx', 1, 1, false],
      ['add', null, 2, false],
      ['ctx', 2, 3, false],
      ['del', 3, null, false],
      ['add', null, 4, false],
      ['ctx', 4, 5, false],
    ])
    expect(hunks[1]?.entries).toHaveLength(4)
    expect(parsePatch('')).toEqual([])
    expect(parsePatch('garbage before header\n@@ -1 +1 @@\n-a\n+b')[0]?.entries.map(e => e.code)).toEqual(['a', 'b'])
  })
})

describe('noise', () => {
  it('flags import-only and whitespace-only changes', () => {
    expect(isImport("import { a } from './a'")).toBe(true)
    expect(isImport("} from './a'")).toBe(true)
    expect(isImport("from './a' import x")).toBe(true)
    expect(isImport('const x = 1')).toBe(false)
    expect(sameIgnoringWhitespace('a  =1', 'a = 1')).toBe(true)
    const hunks = parsePatch(
      ['@@ -1,3 +1,4 @@', '-a=1', '-b=2', '+a = 1', '+b = 2', ' z', "+import x from 'y'"].join('\n')
    )
    markNoise(hunks)
    expect(hunks[0]?.entries.map(e => e.noise)).toEqual([true, true, true, true, false, true])
    const mixed = parsePatch(['@@ -1,2 +1,2 @@', '-a=1', '+a = 2', ' z'].join('\n'))
    markNoise(mixed)
    expect(mixed[0]?.entries.map(e => e.noise)).toEqual([false, false, false])
  })
})

describe('detectMoves', () => {
  it('pairs blocks of three or more lines that moved, and points each end at the other', () => {
    const hunks = parsePatch(
      [
        '@@ -1,4 +1,1 @@',
        '-one()',
        '-two()',
        '-three()',
        ' keep',
        '@@ -20,1 +17,4 @@',
        ' keep2',
        '+one()',
        '+two()',
        '+three()',
      ].join('\n')
    )
    const moves = detectMoves(hunks)
    expect(moves.map(m => [m.id, m.kind, m.pairs.length])).toEqual([[1, 'exact', 3]])
    // The deleted block says where the code went; the added block says where it came from.
    // Each line points at the line it matches, so a fold run names its own counterpart.
    expect(hunks[0]?.entries.map(e => e.move && [e.move.side, e.move.kind, e.move.line])).toEqual([
      ['from', 'exact', 18],
      ['from', 'exact', 19],
      ['from', 'exact', 20],
      null,
    ])
    expect(hunks[1]?.entries.map(e => e.move && [e.move.side, e.move.kind, e.move.line])).toEqual([
      null,
      ['to', 'exact', 1],
      ['to', 'exact', 2],
      ['to', 'exact', 3],
    ])
    const edited = parsePatch(
      ['@@ -1,4 +1,4 @@', '-one()', '-two()', '-three()', '-four()', '+one()', '+two()', '+three()', '+five()'].join(
        '\n'
      )
    )
    // One changed line makes the whole block an edited move, so it is shown instead of folded.
    expect(detectMoves(edited).map(m => m.kind)).toEqual(['edited'])
    expect(edited[0]?.entries.every(e => e.move?.kind === 'edited')).toBe(true)
    const twoBlocks = parsePatch(
      ['@@ -1,6 +1,6 @@', '-a1', '-a2', '-a3', '-b1', '-b2', '-b3', '+b1', '+b2', '+b3', '+a1', '+a2', '+a3'].join('\n')
    )
    expect(detectMoves(twoBlocks).map(m => m.id)).toEqual([1, 2])
    expect(twoBlocks[0]?.entries.every(e => e.move?.kind === 'exact')).toBe(true)
    const tooShort = parsePatch(['@@ -1,2 +1,2 @@', '-one()', '-two()', '+one()', '+two()'].join('\n'))
    expect(detectMoves(tooShort)).toEqual([])
    expect(tooShort[0]?.entries.every(e => e.move === null)).toBe(true)
    const noMatch = parsePatch(['@@ -1,3 +1,3 @@', '-a', '-b', '-c', '+x', '+y', '+z'].join('\n'))
    expect(detectMoves(noMatch)).toEqual([])
    expect(noMatch[0]?.entries.every(e => e.move === null)).toBe(true)
  })

  it('bridges the context git left between the deleted lines, and ignores blank lines', () => {
    // The shape of a function body lifted into a helper: git keeps `return false` and `}` as
    // context on the old side and the new side gains a blank line, so neither run of deletions
    // reaches three lines on its own.
    const hunks = parsePatch(
      [
        '@@ -1,8 +1,9 @@',
        '+function check(request, expected) {',
        '+  const header = request.headers.get()',
        '+  if (!header.startsWith(PREFIX)) {',
        '+    return false',
        '+  }',
        '+',
        '+  const actual = header.slice(PREFIX.length)',
        '+  return equal(actual, expected)',
        '+}',
        ' export function verify(request) {',
        '-  const header = request.headers.get()',
        '-  if (!header.startsWith(PREFIX)) {',
        '     return false',
        '   }',
        '-  const actual = header.slice(PREFIX.length)',
        '-  return equal(actual, expected)',
      ].join('\n')
    )
    const moves = detectMoves(hunks)
    expect(moves.map(m => [m.kind, m.pairs.length])).toEqual([['exact', 4]])
    const entries = hunks[0]?.entries ?? []
    // The two bridged context lines keep their place: they are still on both sides of the diff.
    expect(entries.filter(e => e.type === 'ctx').every(e => e.move === null)).toBe(true)
    // Every deleted line of the move points at the added line it became.
    expect(entries.filter(e => e.type === 'del').map(e => [e.oldLine, e.move?.side, e.move?.line])).toEqual([
      [2, 'from', 2],
      [3, 'from', 3],
      [6, 'from', 7],
      [7, 'from', 8],
    ])
    // The blank line the move gained is folded with the rest of the added block.
    expect(entries.filter(e => e.type === 'add' && e.move !== null).map(e => e.newLine)).toEqual([2, 3, 4, 5, 6, 7, 8])
  })

  it('refuses a match made of context alone', () => {
    // Three identical closing lines around one changed line are not a move.
    const hunks = parsePatch(
      ['@@ -1,8 +1,8 @@', '-  alpha()', '   }', '   }', '   }', '+  omega()', '+  }', '+  }', '+  }'].join('\n')
    )
    expect(detectMoves(hunks)).toEqual([])
    expect(hunks[0]?.entries.every(e => e.move === null)).toBe(true)
  })

  it('marks the words an edited move changed on the way, and leaves an exact move unmarked', () => {
    const edited = prepareHunks(
      ['@@ -1,4 +1,4 @@', '-one()', '-two()', '-three()', '-four()', '+one()', '+two()', '+three()', '+five()'].join(
        '\n'
      )
    )
    const entries = edited[0]?.entries ?? []
    expect(entries.slice(0, 3).every(e => e.marks === null)).toBe(true)
    expect(entries[3]?.marks).toEqual([[0, 4]])
    expect(entries[7]?.marks).toEqual([[0, 4]])
    const exact = prepareHunks(
      ['@@ -1,7 +1,7 @@', '-one()', '-two()', '-three()', ' keep', '+one()', '+two()', '+three()'].join('\n')
    )
    expect(exact[0]?.entries.every(e => e.marks === null)).toBe(true)
  })
})

describe('pairChangedLines and wordDiff', () => {
  it('pairs equal-length del/add runs and leaves unequal runs alone', () => {
    const hunks = parsePatch(['@@ -1,5 +1,4 @@', '-a', '-b', '+A', '+B', ' c', '-d', '-e', '+D', ' f'].join('\n'))
    const pairs = pairChangedLines(hunks[0]?.entries ?? [])
    expect(pairs.map(p => [p.del.code, p.add.code])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ])
  })

  it('finds changed ranges and gives up on rewrites or empty lines', () => {
    expect(wordDiff('  return a()', '  return a() + b()')).toEqual({ del: [], add: [[12, 18]] })
    expect(wordDiff('get x(): number {', 'get x(): number | null {')).toEqual({ del: [], add: [[16, 23]] })
    expect(wordDiff('completely different text here', 'zzz')).toEqual({ del: [], add: [] })
    expect(wordDiff('', 'x')).toEqual({ del: [], add: [] })
  })
})

describe('splitHighlightedLines and wrapRanges', () => {
  it('re-opens spans across newlines', () => {
    expect(splitHighlightedLines('<span class="a">x\ny</span>\nz')).toEqual([
      '<span class="a">x</span>',
      '<span class="a">y</span>',
      'z',
    ])
    expect(splitHighlightedLines('broken <span')).toEqual(['broken <span'])
  })

  it('wraps character ranges across existing markup', () => {
    expect(wrapRanges('ab<i>cd</i>ef', [[1, 5]], 'wa')).toBe(
      'a<span class="wa">b</span><i><span class="wa">cd</span></i><span class="wa">e</span>f'
    )
    expect(wrapRanges('abc', [], 'wa')).toBe('abc')
    expect(wrapRanges('abc', [[5, 9]], 'wa')).toBe('abc')
  })
})

describe('highlightHunk and codeHtml', () => {
  it('highlights both sides of a hunk and skips unknown languages', () => {
    const [hunk] = parsePatch(PATCH)
    if (!hunk) {
      throw new Error('no hunk')
    }
    highlightHunk(hunk, 'typescript')
    expect(hunk.entries.every(e => typeof e.html === 'string')).toBe(true)
    expect(hunk.entries[2]?.html).toContain('hljs-keyword')
    const [plain] = parsePatch(PATCH)
    if (!plain) {
      throw new Error('no hunk')
    }
    highlightHunk(plain, 'no-such-language')
    expect(plain.entries.every(e => e.html === null)).toBe(true)
    highlightHunk(plain, undefined)
    expect(
      codeHtml({
        type: 'add',
        code: 'a < b',
        oldLine: null,
        newLine: 1,
        consecutive: false,
        noise: false,
        move: null,
        html: null,
        marks: null,
      })
    ).toBe('a &lt; b')
    expect(
      codeHtml({
        type: 'add',
        code: 'a < b',
        oldLine: null,
        newLine: 1,
        consecutive: false,
        noise: false,
        move: null,
        html: null,
        marks: [[0, 1]],
      })
    ).toBe('<span class="wa">a</span> &lt; b')
  })
})

const EMPTY_HUNK = { header: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, entries: [] }

describe('rowHtml and buildRows', () => {
  it('emits ids per side, data-old on context rows, and the gutter button', () => {
    const [hunk] = parsePatch(PATCH)
    const ctx = hunk?.entries[0]
    const add = hunk?.entries[1]
    const del = hunk?.entries[3]
    if (!(ctx && add && del)) {
      throw new Error('no entries')
    }
    expect(rowHtml(ctx, 'k')).toBe(
      '<tr class="ctx" id="L-k-new-1" data-old="1"><td class="ln">1</td><td class="ln">1</td><td class="gut"><button class="plus" type="button" data-act="comment-line" data-needs-post data-key="k" data-side="new" data-line="1" aria-label="Comment on line 1">+</button></td><td class="code"> import { a } from &#39;./a&#39;</td></tr>'
    )
    expect(rowHtml(add, 'k')).toContain('<tr class="add" id="L-k-new-2">')
    expect(rowHtml(del, 'k')).toContain('<tr class="del" id="L-k-old-3">')
    // A deleted line is commented on the old side, at its old line number.
    expect(rowHtml(del, 'k')).toContain('data-side="old" data-line="3"')
    del.noise = true
    expect(rowHtml(del, 'k')).toContain('<tr class="del folded noise" id="L-k-old-3">')
    del.noise = false
    del.move = { id: 1, kind: 'exact', side: 'from', line: 40 }
    expect(rowHtml(del, 'k')).toContain('<tr class="del folded move-from" id="L-k-old-3">')
    // An edited move is worth reading, so its rows start open.
    del.move = { id: 1, kind: 'edited', side: 'from', line: 40 }
    expect(rowHtml(del, 'k')).toContain('<tr class="del folded shown move-from" id="L-k-old-3">')
  })

  it('folds noise behind a show row and leaves code outside the diff out of the table', () => {
    const hunks = prepareHunks(PATCH)
    const first = buildRows(
      hunks[0] ?? { header: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, entries: [] },
      'k'
    )
    expect(first).toContain('<tr class="hunk">')
    expect(first).toContain('1 line hidden (imports, whitespace)')
    expect(first).toContain(
      '<button class="cmd" type="button" data-act="show-fold" aria-expanded="false">show</button>'
    )
    expect(first).toContain('<tr class="add folded noise" id="L-k-new-2">')
    // A hunk starting below line 1 gets no row for the code above it.
    const second = buildRows(
      hunks[1] ?? { header: '', oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, entries: [] },
      'k'
    )
    expect(second).not.toContain('class="more expand"')
  })

  it('folds each end of an exact move behind a summary naming the other end', () => {
    const hunks = prepareHunks(
      [
        '@@ -1,4 +1,1 @@',
        '-one()',
        '-two()',
        '-three()',
        ' keep',
        '@@ -20,1 +17,4 @@',
        ' keep2',
        '+one()',
        '+two()',
        '+three()',
      ].join('\n')
    )
    const from = buildRows(hunks[0] ?? EMPTY_HUNK, 'k')
    expect(from).toContain('<tr class="more fold move">')
    expect(from).toContain('&#8943; 3 lines moved to <button')
    expect(from).toContain('data-act="jump-line" data-key="k" data-side="new" data-line="18">line 18</button>')
    expect(from).toContain('<button class="cmd" type="button" data-act="show-fold" aria-expanded="false">show</button>')
    expect(from).toContain('<tr class="del folded move-from" id="L-k-old-1">')
    const to = buildRows(hunks[1] ?? EMPTY_HUNK, 'k')
    expect(to).toContain('&#8943; 3 lines moved from <button')
    expect(to).toContain('data-side="old" data-line="1">line 1</button>')
    expect(to).toContain('<tr class="add folded move-to" id="L-k-new-18">')
  })

  it('opens an edited move and says so, with one summary per block', () => {
    const hunks = prepareHunks(
      ['@@ -1,4 +1,4 @@', '-one()', '-two()', '-three()', '-four()', '+one()', '+two()', '+three()', '+five()'].join(
        '\n'
      )
    )
    const rows = buildRows(hunks[0] ?? EMPTY_HUNK, 'k')
    expect(rows).toContain('&#8943; 4 lines moved to <button')
    expect(rows).toContain('>line 1</button>, edited')
    expect(rows).toContain('<button class="cmd" type="button" data-act="show-fold" aria-expanded="true">hide</button>')
    expect(rows.match(/class="more fold move"/g)).toHaveLength(2)
    expect(rows).toContain('<tr class="del folded shown move-from" id="L-k-old-1">')
    expect(rows).toContain('<tr class="add folded shown move-to" id="L-k-new-1">')
  })
})

describe('renderDiff', () => {
  const file = { key: 'src_app_ts', path: 'src/app.ts', lang: 'typescript' }

  it('renders one table per hunk with ids, a header row, and word marks', () => {
    const html = renderDiff(file, PATCH)
    document.body.innerHTML = html
    const tables = document.querySelectorAll('table.diff')
    expect(tables.length).toBe(2)
    expect(tables[0]?.id).toBe('hunk-src_app_ts-1')
    expect(tables[0]?.getAttribute('data-hunk')).toBe('src_app_ts#1')
    expect(tables[0]?.getAttribute('data-key')).toBe('src_app_ts')
    expect(tables[0]?.querySelectorAll('th').length).toBe(4)
    expect(tables[0]?.querySelector('tr.hunk td.code')?.textContent).toBe('@@ -1,4 +1,5 @@')
    expect([...document.querySelectorAll('#L-src_app_ts-new-4 .wa')].map(s => s.textContent).join('')).toBe(' + b()')
    expect(document.querySelector('#L-src_app_ts-old-3')).not.toBeNull()
    expect(document.querySelectorAll('button.plus').length).toBe(10)
  })

  it('renders only the requested hunks, highlighted, and a placeholder when none match', () => {
    document.body.innerHTML = renderDiff(file, PATCH, { hunkIds: new Set(['src_app_ts#2']) })
    expect(document.querySelectorAll('table.diff').length).toBe(1)
    expect(document.querySelector('table.diff')?.id).toBe('hunk-src_app_ts-2')
    expect(document.querySelectorAll('table.diff .hljs-keyword').length).toBeGreaterThan(0)
    expect(renderDiff(file, PATCH, { hunkIds: new Set(['src_app_ts#9']) })).toBe(
      '<div class="unavailable">No diff to show.</div>'
    )
    expect(renderDiff(file, '')).toBe('<div class="unavailable">No diff to show.</div>')
  })

  it('keeps </script> in code as text', () => {
    const html = renderDiff({ key: 'k', path: 'x.ts' }, '@@ -0,0 +1 @@\n+// </script><script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;/script&gt;')
  })
})

describe('move detection boundaries', () => {
  it('does not treat whitespace-only additions as moved code', () => {
    const hunks = parsePatch('@@ -1,3 +1,3 @@\n-a()\n-b()\n-c()\n+  \n+\n+  ')
    expect(detectMoves(hunks)).toEqual([])
  })

  it('uses an added block only once when two deleted blocks contain the same code', () => {
    const hunks = parsePatch([
      '@@ -1,3 +0,0 @@', '-a()', '-b()', '-c()',
      '@@ -10,3 +6,0 @@', '-a()', '-b()', '-c()',
      '@@ -20,0 +14,3 @@', '+a()', '+b()', '+c()',
    ].join('\n'))
    expect(detectMoves(hunks)).toHaveLength(1)
    expect(hunks[1]?.entries.every(entry => entry.move === null)).toBe(true)
  })

  it.each([
    ['a()', 'b()'],
    ['a()', 'other()', 'changed()', 'd()'],
    ['a()', 'b()', 'c()', 'other()', 'changed()'],
  ].map(added => ({ added })))('requires three matching lines and at least 70% similarity: $added', ({ added }) => {
    const removed = ['a()', 'b()', 'c()', 'd()', 'e()']
    const hunks = parsePatch([
      '@@ -1,5 +0,0 @@', ...removed.map(line => '-' + line),
      `@@ -10,0 +5,${added.length} @@`, ...added.map(line => '+' + line),
    ].join('\n'))
    expect(detectMoves(hunks)).toEqual([])
  })
})
