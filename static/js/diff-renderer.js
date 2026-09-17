// @ts-check
// Unified diff → one <table class="diff"> per chunk. Port of the prior-art renderer.js: import
// filter, whitespace-only collapse, moved-code detection, per-chunk highlight.js; plus jsdiff
// word-level marks on paired changed lines. Line numbers come from the chunk headers and are
// never shifted by filtering: filtered lines are folded (hidden rows), not dropped.
import { diffWordsWithSpace } from 'diff'
import hljs from 'hljs'
import { esc } from './dom.js'
import { parseChunkHeader } from './chunks.js'
import { buildLineId, chunkAnchorId, chunkId } from './keys.js'

/**
 * Where one line of a move sits. `side` is which end of the move this line is: `from` for the
 * deleted block, `to` for the added one. `line` is the line it matches on the other end, so a
 * fold summary can point the reader at it.
 * @typedef {{ id: number, kind: 'exact' | 'edited', side: 'from' | 'to', line: number }} Move
 */
/**
 * @typedef {{
 *   type: 'add' | 'del' | 'ctx',
 *   code: string,
 *   oldLine: number | null,
 *   newLine: number | null,
 *   consecutive: boolean,
 *   noise: boolean,
 *   move: Move | null,
 *   html: string | null,
 *   marks: Array<[number, number]> | null,
 * }} Entry
 */
/**
 * @typedef {{ header: string, oldStart: number, oldLines: number, newStart: number, newLines: number, entries: Entry[] }} ChunkBlock
 */
/**
 * One matched move, as the changed lines of each side paired by position. Context lines the block
 * bridged are compared but not paired: neither side changed them.
 * @typedef {{ id: number, kind: 'exact' | 'edited', pairs: Array<{ del: Entry, add: Entry }> }} MoveBlock
 */

/**
 * @param {string} line
 * @returns {boolean}
 */
export function isImport(line) {
  const s = line.trim()
  return s.startsWith('import ') || s.startsWith('import{') || s.startsWith('} from ') || /^from ['"]/.test(s)
}

/**
 * @param {string} a
 * @param {string} b
 */
export function sameIgnoringWhitespace(a, b) {
  return a.replace(/\s/g, '') === b.replace(/\s/g, '')
}

/** @param {string} s */
function normWs(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * Splits a patch (from its first `@@`) into chunks with numbered entries.
 * @param {string} patch
 * @returns {ChunkBlock[]}
 */
export function parsePatch(patch) {
  /** @type {ChunkBlock[]} */
  const chunks = []
  if (!patch) {
    return chunks
  }
  /** @type {ChunkBlock | null} */
  let cur = null
  let oL = 0
  let nL = 0
  let prevAdd = false
  let prevDel = false
  for (const line of patch.split('\n')) {
    const head = parseChunkHeader(line)
    if (head) {
      oL = head.oldStart
      nL = head.newStart
      cur = { header: line, ...head, entries: [] }
      chunks.push(cur)
      prevAdd = false
      prevDel = false
      continue
    }
    if (cur === null || line.startsWith('\\')) {
      continue
    }
    /** @type {Entry} */
    const base = {
      type: 'ctx',
      code: '',
      oldLine: null,
      newLine: null,
      consecutive: false,
      noise: false,
      move: null,
      html: null,
      marks: null,
    }
    if (line.startsWith('+')) {
      cur.entries.push({ ...base, type: 'add', code: line.slice(1), newLine: nL, consecutive: prevAdd })
      nL++
      prevAdd = true
      prevDel = false
    } else if (line.startsWith('-')) {
      cur.entries.push({ ...base, type: 'del', code: line.slice(1), oldLine: oL, consecutive: prevDel })
      oL++
      prevDel = true
      prevAdd = false
    } else {
      cur.entries.push({
        ...base,
        code: line.startsWith(' ') ? line.slice(1) : line,
        oldLine: oL,
        newLine: nL,
      })
      oL++
      nL++
      prevAdd = false
      prevDel = false
    }
  }
  return chunks
}

/**
 * Marks the lines a reviewer rarely needs: import-only changes and whitespace-only rewrites.
 * They stay in the table, folded behind a "show N hidden lines" row.
 * @param {ChunkBlock[]} chunks
 */
export function markNoise(chunks) {
  for (const h of chunks) {
    const e = h.entries
    for (let i = 0; i < e.length; i++) {
      const cur = e[i]
      if (cur === undefined || cur.type !== 'del') {
        continue
      }
      let j = i
      while (j < e.length && e[j]?.type === 'del') {
        j++
      }
      let k = j
      while (k < e.length && e[k]?.type === 'add') {
        k++
      }
      const dels = e.slice(i, j)
      const adds = e.slice(j, k)
      if (
        dels.length === adds.length &&
        dels.every((d, idx) => sameIgnoringWhitespace(d.code, adds[idx]?.code ?? ''))
      ) {
        for (const x of [...dels, ...adds]) {
          x.noise = true
        }
      }
      i = k - 1
    }
    for (const x of e) {
      if (x.type !== 'ctx' && isImport(x.code)) {
        x.noise = true
      }
    }
  }
}

/** A move must carry this many changed lines on each side. */
const MOVE_MIN_LINES = 3
/** How many context lines a move block bridges before it ends. */
const MOVE_MAX_BRIDGE = 3
/** The longest block a move is looked for in. */
const MOVE_MAX_BLOCK = 40

/**
 * The block a move candidate starts with: one run of lines of the file this side belongs to.
 * A deleted block is a run of the old file, so it is made of deleted and context lines and the
 * added lines in between are skipped — they are not in the old file at all. An added block is
 * the same over the new file. Git routinely leaves a line the move did not touch as context and
 * splits the changed lines around it, so a block that stopped at the first context line would
 * find no move; a short run of context is bridged instead. The block ends on a `type` line.
 * @param {Entry[]} entries one chunk's entries
 * @param {number} from index of a `type` entry
 * @param {'add' | 'del'} type
 * @param {ReadonlySet<Entry>} taken lines another move already claimed
 * @returns {Entry[]}
 */
function blockFrom(entries, from, type, taken) {
  /** @type {Entry[]} */
  const block = []
  let bridge = 0
  for (let i = from; i < entries.length && block.length < MOVE_MAX_BLOCK; i++) {
    const e = entries[i]
    if (e === undefined) {
      break
    }
    if (e.type === type) {
      if (taken.has(e)) {
        break
      }
      block.push(e)
      bridge = 0
      continue
    }
    if (e.type !== 'ctx') {
      continue
    }
    bridge++
    if (bridge > MOVE_MAX_BRIDGE) {
      break
    }
    block.push(e)
  }
  while (block.length > 0 && block[block.length - 1]?.type === 'ctx') {
    block.pop()
  }
  return block
}

/**
 * How far along the alignment the move actually reaches. A bridge is only part of the move when
 * the context line it crossed says the same thing as the line it lines up with; the first one
 * that does not is where the block ran on past the move, so the match stops there.
 * @param {ReadonlyArray<{ entry: Entry, text: string }>} dc
 * @param {ReadonlyArray<{ entry: Entry, text: string }>} ac
 * @param {number} ml
 * @returns {number}
 */
function alignedLength(dc, ac, ml) {
  for (let k = 0; k < ml; k++) {
    const d = dc[k]
    const a = ac[k]
    if (d?.text !== a?.text && (d?.entry.type === 'ctx' || a?.entry.type === 'ctx')) {
      return k
    }
  }
  return ml
}

/**
 * The lines of a block the comparison sees, with the text it compares them by. A blank line says
 * nothing about a move, and leaving it out keeps the two sides aligned when one of them gained
 * or lost one.
 * @param {Entry[]} block
 * @returns {Array<{ entry: Entry, text: string }>}
 */
function comparable(block) {
  /** @type {Array<{ entry: Entry, text: string }>} */
  const out = []
  for (const entry of block) {
    const text = normWs(entry.code)
    if (text !== '') {
      out.push({ entry, text })
    }
  }
  return out
}

/**
 * How many of these lines were added or deleted. A match made of context alone is no move.
 * @param {ReadonlyArray<{ entry: Entry }>} lines
 * @returns {number}
 */
function changedCount(lines) {
  return lines.filter(l => l.entry.type !== 'ctx').length
}

/**
 * The line number of the other end of a move. A `from` line points at the added line it became,
 * a `to` line at the deleted line it came from.
 * @param {{ entry: Entry } | undefined} counterpart
 * @param {'from' | 'to'} side
 * @returns {number}
 */
function counterpartLine(counterpart, side) {
  return (side === 'from' ? counterpart?.entry.newLine : counterpart?.entry.oldLine) ?? 0
}

/**
 * @typedef {{ entries: Entry[], index: number, start: Entry }} AddStart
 */

/**
 * Every added block of the file, in reading order, under the first line it would be compared by.
 * A move begins on a line that moved, so a deleted block only has to look at the added blocks
 * that open on the same line instead of at all of them.
 * @param {ChunkBlock[]} chunks
 * @returns {Map<string, AddStart[]>}
 */
function indexAddStarts(chunks) {
  /** @type {Map<string, AddStart[]>} */
  const byFirstLine = new Map()
  /** @type {Set<Entry>} */
  const none = new Set()
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.entries.length; index++) {
      const start = chunk.entries[index]
      if (start?.type !== 'add') {
        continue
      }
      const text = comparable(blockFrom(chunk.entries, index, 'add', none))[0]?.text
      if (text === undefined) {
        continue
      }
      const starts = byFirstLine.get(text)
      if (starts === undefined) {
        byFirstLine.set(text, [{ entries: chunk.entries, index, start }])
      } else {
        starts.push({ entries: chunk.entries, index, start })
      }
    }
  }
  return byFirstLine
}

/**
 * The first added block that matches these deleted lines.
 * @param {Map<string, AddStart[]>} addStarts
 * @param {ReadonlyArray<{ entry: Entry, text: string }>} dc the deleted side, as compared
 * @param {ReadonlySet<Entry>} taken
 * @returns {{ block: Entry[], ac: Array<{ entry: Entry, text: string }>, ml: number, mc: number } | null}
 */
function findAddMatch(addStarts, dc, taken) {
  for (const { entries, index, start } of addStarts.get(dc[0]?.text ?? '') ?? []) {
    if (taken.has(start)) {
      continue
    }
    const block = blockFrom(entries, index, 'add', taken)
    const ac = comparable(block)
    if (dc[0]?.text !== ac[0]?.text) {
      continue
    }
    const ml = alignedLength(dc, ac, Math.min(dc.length, ac.length))
    if (ml < MOVE_MIN_LINES) {
      continue
    }
    let mc = 0
    for (let k = 0; k < ml; k++) {
      if (dc[k]?.text === ac[k]?.text) {
        mc++
      }
    }
    if (mc < MOVE_MIN_LINES || mc < ml * 0.7) {
      continue
    }
    if (changedCount(dc.slice(0, ml)) < MOVE_MIN_LINES || changedCount(ac.slice(0, ml)) < MOVE_MIN_LINES) {
      continue
    }
    return { block, ac, ml, mc }
  }
  return null
}

/**
 * Marks one side of a match. Every added or deleted line of the matched range points at the line
 * it matches on the other side; a bridged context line is left alone, because it is still where
 * it was and folding it here would hide it from the other side too.
 * @param {Entry[]} block
 * @param {ReadonlyArray<{ entry: Entry, text: string }>} own
 * @param {ReadonlyArray<{ entry: Entry, text: string }>} other
 * @param {number} ml
 * @param {{ id: number, kind: 'exact' | 'edited', side: 'from' | 'to' }} move
 * @param {Set<Entry>} taken
 */
function markSide(block, own, other, ml, move, taken) {
  const last = own[ml - 1]?.entry
  const end = last === undefined ? -1 : block.indexOf(last)
  let k = 0
  let line = counterpartLine(other[0], move.side)
  for (let i = 0; i <= end; i++) {
    const entry = block[i]
    if (entry === undefined) {
      continue
    }
    if (own[k]?.entry === entry) {
      line = counterpartLine(other[k], move.side)
      k++
    }
    if (entry.type === 'ctx') {
      continue
    }
    taken.add(entry)
    entry.move = { ...move, line }
  }
}

/**
 * Blocks of three or more deleted lines that reappear (70%+ equal after whitespace
 * normalization) as a block of additions are moves, not edits. Runs across all chunks of a file.
 * Both ends of a match learn which line of the other end they match, so each can be folded behind
 * a summary that says where the code went or came from.
 * @param {ChunkBlock[]} chunks
 * @returns {MoveBlock[]}
 */
export function detectMoves(chunks) {
  const addStarts = indexAddStarts(chunks)
  /** @type {Set<Entry>} */
  const taken = new Set()
  /** @type {MoveBlock[]} */
  const moves = []
  for (const chunk of chunks) {
    for (let di = 0; di < chunk.entries.length; di++) {
      const start = chunk.entries[di]
      if (start === undefined || start.type !== 'del' || taken.has(start)) {
        continue
      }
      const block = blockFrom(chunk.entries, di, 'del', taken)
      const dc = comparable(block)
      if (dc.length < MOVE_MIN_LINES) {
        continue
      }
      const match = findAddMatch(addStarts, dc, taken)
      if (match === null) {
        continue
      }
      const id = moves.length + 1
      const kind = /** @type {'exact' | 'edited'} */ (match.mc === match.ml ? 'exact' : 'edited')
      markSide(block, dc, match.ac, match.ml, { id, kind, side: 'from' }, taken)
      markSide(match.block, match.ac, dc, match.ml, { id, kind, side: 'to' }, taken)
      /** @type {MoveBlock} */
      const move = { id, kind, pairs: [] }
      for (let k = 0; k < match.ml; k++) {
        const del = dc[k]?.entry
        const add = match.ac[k]?.entry
        if (del?.type === 'del' && add?.type === 'add') {
          move.pairs.push({ del, add })
        }
      }
      moves.push(move)
    }
  }
  return moves
}

/**
 * Adjacent runs of deletions and additions of equal length are pairs: line i of the deletions
 * changed into line i of the additions.
 * @param {Entry[]} entries
 * @returns {Array<{ del: Entry, add: Entry }>}
 */
export function pairChangedLines(entries) {
  /** @type {Array<{ del: Entry, add: Entry }>} */
  const pairs = []
  for (let i = 0; i < entries.length; i++) {
    if (entries[i]?.type !== 'del') {
      continue
    }
    let j = i
    while (j < entries.length && entries[j]?.type === 'del') {
      j++
    }
    let k = j
    while (k < entries.length && entries[k]?.type === 'add') {
      k++
    }
    if (j - i === k - j) {
      for (let n = 0; n < j - i; n++) {
        const del = entries[i + n]
        const add = entries[j + n]
        if (del && add) {
          pairs.push({ del, add })
        }
      }
    }
    i = k - 1
  }
  return pairs
}

/**
 * Character ranges that differ between two lines, as [start, end) offsets into each line.
 * Empty when the lines share nothing (a rewrite), so the rows are not covered in marks.
 * @param {string} oldCode
 * @param {string} newCode
 * @returns {{ del: Array<[number, number]>, add: Array<[number, number]> }}
 */
export function wordDiff(oldCode, newCode) {
  /** @type {Array<[number, number]>} */
  const del = []
  /** @type {Array<[number, number]>} */
  const add = []
  if (oldCode === '' || newCode === '') {
    return { del, add }
  }
  let o = 0
  let n = 0
  let common = 0
  for (const part of diffWordsWithSpace(oldCode, newCode)) {
    const len = part.value.length
    if (part.added) {
      add.push([n, n + len])
      n += len
    } else if (part.removed) {
      del.push([o, o + len])
      o += len
    } else {
      common += len
      o += len
      n += len
    }
  }
  const longest = Math.max(oldCode.length, newCode.length)
  if (common / longest < 0.3) {
    return { del: [], add: [] }
  }
  return { del, add }
}

/**
 * Highlights a block, then cuts it into lines and re-opens every span that crosses a newline,
 * because highlight.js v11 has no continuation state between calls.
 * @param {string} html
 * @returns {string[]}
 */
export function splitHighlightedLines(html) {
  /** @type {string[]} */
  const lines = []
  /** @type {string[]} */
  const open = []
  let buf = ''
  let i = 0
  while (i < html.length) {
    const ch = html[i]
    if (ch === '<') {
      const end = html.indexOf('>', i)
      if (end === -1) {
        buf += html.slice(i)
        break
      }
      const tag = html.slice(i, end + 1)
      if (tag.startsWith('</span')) {
        open.pop()
      } else if (tag.startsWith('<span')) {
        open.push(tag)
      }
      buf += tag
      i = end + 1
    } else if (ch === '\n') {
      lines.push(buf + '</span>'.repeat(open.length))
      buf = open.join('')
      i++
    } else {
      buf += ch
      i++
    }
  }
  lines.push(buf + '</span>'.repeat(open.length))
  return lines
}

/**
 * @param {Entry[]} side
 * @param {string} lang
 * @param {'old' | 'new'} which
 */
function highlightSide(side, lang, which) {
  if (side.length === 0) {
    return
  }
  /** @type {string[]} */
  let out
  try {
    out = splitHighlightedLines(
      hljs.highlight(side.map(e => e.code).join('\n'), { language: lang, ignoreIllegals: true }).value
    )
  } catch {
    return
  }
  if (out.length !== side.length) {
    return
  }
  side.forEach((e, i) => {
    if (e.type === 'ctx' && which !== 'new') {
      return
    }
    e.html = out[i] ?? null
  })
}

/**
 * A chunk holds two versions of the code. Each is rebuilt and highlighted on its own.
 * @param {ChunkBlock} chunk
 * @param {string | undefined} lang
 */
export function highlightChunk(chunk, lang) {
  if (!(lang && hljs.getLanguage(lang))) {
    return
  }
  const oldSide = chunk.entries.filter(e => e.type !== 'add')
  const newSide = chunk.entries.filter(e => e.type !== 'del')
  highlightSide(oldSide, lang, 'old')
  highlightSide(newSide, lang, 'new')
}

/**
 * Wraps character ranges of the text inside an HTML string in <span class="cls">, keeping the
 * existing markup. Offsets count text characters only.
 * @param {string} html
 * @param {ReadonlyArray<[number, number]>} ranges
 * @param {string} cls
 * @returns {string}
 */
export function wrapRanges(html, ranges, cls) {
  if (ranges.length === 0) {
    return html
  }
  const root = document.createElement('div')
  root.innerHTML = html
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  /** @type {Array<{ node: Text, start: number }>} */
  const texts = []
  let pos = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = /** @type {Text} */ (n)
    texts.push({ node: t, start: pos })
    pos += t.data.length
  }
  for (const { node, start } of texts) {
    const end = start + node.data.length
    /** @type {Array<[number, number]>} */
    const local = []
    for (const [s, e] of ranges) {
      const ls = Math.max(s, start) - start
      const le = Math.min(e, end) - start
      if (le > ls) {
        local.push([ls, le])
      }
    }
    if (local.length === 0) {
      continue
    }
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const [ls, le] of local) {
      if (ls > cursor) {
        frag.append(document.createTextNode(node.data.slice(cursor, ls)))
      }
      const span = document.createElement('span')
      span.className = cls
      span.textContent = node.data.slice(ls, le)
      frag.append(span)
      cursor = le
    }
    if (cursor < node.data.length) {
      frag.append(document.createTextNode(node.data.slice(cursor)))
    }
    node.replaceWith(frag)
  }
  return root.innerHTML
}

/**
 * Parse + noise + moves + word pairs, in one call. Noise and moves need the whole file, so this
 * runs over every chunk; highlighting is per chunk and happens in renderDiff for the shown ones.
 * @param {string} patch
 * @returns {ChunkBlock[]}
 */
export function prepareChunks(patch) {
  const chunks = parsePatch(patch)
  markNoise(chunks)
  const moves = detectMoves(chunks)
  // A move that changed on the way is shown rather than folded, so its two ends carry word marks
  // and the reader sees the edit instead of re-reading the block.
  for (const move of moves) {
    if (move.kind === 'exact') {
      continue
    }
    for (const { del, add } of move.pairs) {
      if (normWs(del.code) === normWs(add.code)) {
        continue
      }
      const marks = wordDiff(del.code, add.code)
      del.marks = marks.del
      add.marks = marks.add
    }
  }
  for (const h of chunks) {
    for (const { del, add } of pairChangedLines(h.entries)) {
      if (del.noise || add.noise || del.move || add.move) {
        continue
      }
      const marks = wordDiff(del.code, add.code)
      del.marks = marks.del
      add.marks = marks.add
    }
  }
  return chunks
}

/** @param {Entry} e */
export function codeHtml(e) {
  const base = e.html ?? esc(e.code)
  if (e.marks && e.marks.length > 0) {
    return wrapRanges(base, e.marks, e.type === 'del' ? 'wd' : 'wa')
  }
  return base
}

/**
 * @param {Entry} e
 * @param {string} key
 * @returns {string}
 */
export function rowHtml(e, key) {
  /** @type {string[]} */
  const classes = [e.type]
  if (foldKey(e) !== null) {
    // `folded` is what the stylesheet hides and what the summary row's toggle walks over. An
    // edited move starts open, so it also carries `shown`.
    classes.push('folded')
    if (e.move !== null && e.move.kind === 'edited') {
      classes.push('shown')
    }
  }
  if (e.move !== null) {
    classes.push(`move-${e.move.side}`)
  }
  if (e.noise) {
    classes.push('noise')
  }
  const idSide = e.type === 'del' ? 'old' : 'new'
  const idLine = e.type === 'del' ? e.oldLine : e.newLine
  const id = idLine === null ? '' : ` id="${esc(buildLineId(key, idSide, idLine))}"`
  const dataOld = e.type === 'ctx' && e.oldLine !== null ? ` data-old="${e.oldLine}"` : ''
  const marker = e.type === 'add' ? '+' : e.type === 'del' ? '-' : ' '
  // A deleted line is commented on the old side; every other row on the new side.
  const commentSide = e.type === 'del' ? 'old' : 'new'
  const commentLine = commentSide === 'old' ? e.oldLine : e.newLine
  const plus =
    commentLine === null
      ? ''
      : `<button class="plus" type="button" data-act="comment-line" data-needs-post data-key="${esc(key)}" data-side="${commentSide}" data-line="${commentLine}" aria-label="Comment on line ${commentLine}">+</button>`
  return (
    `<tr class="${classes.join(' ')}"${id}${dataOld}>` +
    `<td class="ln">${e.oldLine ?? ''}</td>` +
    `<td class="ln">${e.newLine ?? ''}</td>` +
    `<td class="gut">${plus}</td>` +
    `<td class="code">${marker}${codeHtml(e)}</td></tr>`
  )
}

/**
 * Which fold a row belongs to, as a key that groups a run of rows behind one summary. A move wins
 * over noise, because an import line that only moved reads better under the move summary.
 * @param {Entry} e
 * @returns {string | null}
 */
export function foldKey(e) {
  if (e.move !== null) {
    return `move-${e.move.id}-${e.move.side}`
  }
  return e.noise ? 'noise' : null
}

/**
 * The summary row a run of folded rows sits behind. A move names the other end of the move and
 * offers a jump to it; anything else counts the lines it hides.
 * @param {Entry} first the first row of the run
 * @param {number} n how many rows the run holds
 * @param {string} key
 * @returns {string}
 */
export function foldSummaryHtml(first, n, key) {
  const lines = `${n} ${n === 1 ? 'line' : 'lines'}`
  const move = first.move
  let label = `&#8943; ${lines} hidden (imports, whitespace)`
  let shown = false
  if (move !== null) {
    // The other end of a move is on the opposite side of the diff: a deleted block moved to added
    // lines, an added block came from deleted ones.
    const side = move.side === 'from' ? 'new' : 'old'
    const jump =
      `<button class="cmd" type="button" data-act="jump-line" data-key="${esc(key)}" data-side="${side}"` +
      ` data-line="${move.line}">line ${move.line}</button>`
    const where = move.side === 'from' ? 'moved to' : 'moved from'
    label = `&#8943; ${lines} ${where} ${jump}${move.kind === 'edited' ? ', edited' : ''}`
    shown = move.kind === 'edited'
  }
  const toggle =
    `<button class="cmd" type="button" data-act="show-fold" aria-expanded="${shown}">` +
    `${shown ? 'hide' : 'show'}</button>`
  return (
    `<tr class="more fold${move === null ? '' : ' move'}"><td class="ln" colspan="2"></td><td class="gut"></td>` +
    `<td class="code">${label} &middot; ${toggle}</td></tr>`
  )
}

/**
 * Rows for one chunk: the header row, folds, and one row per line.
 * @param {ChunkBlock} chunk
 * @param {string} key
 * @returns {string}
 */
export function buildRows(chunk, key) {
  /** @type {string[]} */
  const rows = []
  rows.push(
    `<tr class="chunk"><td class="ln" colspan="2"></td><td class="gut"></td><td class="code">${esc(chunk.header)}</td></tr>`
  )
  let i = 0
  while (i < chunk.entries.length) {
    const e = chunk.entries[i]
    if (e === undefined) {
      break
    }
    const fold = foldKey(e)
    if (fold !== null) {
      let j = i
      while (j < chunk.entries.length) {
        const next = chunk.entries[j]
        if (next === undefined || foldKey(next) !== fold) {
          break
        }
        j++
      }
      rows.push(foldSummaryHtml(e, j - i, key))
      for (let k = i; k < j; k++) {
        const x = chunk.entries[k]
        if (x) {
          rows.push(rowHtml(x, key))
        }
      }
      i = j
      continue
    }
    rows.push(rowHtml(e, key))
    i++
  }
  return rows.join('')
}

const THEAD =
  '<thead><tr><th scope="col" class="ln">Old</th><th scope="col" class="ln">New</th><th scope="col" class="gut"><span class="sr">Comment</span></th><th scope="col" class="code">Change</th></tr></thead>'

/**
 * @param {{ key: string, path: string, lang?: string | undefined }} file
 * @param {string} patch
 * @param {{ chunkIds?: ReadonlySet<string> }} [opts] only these chunk ids; all when omitted
 * @returns {string} HTML: one table per chunk inside .diff-wrap
 */
export function renderDiff(file, patch, opts = {}) {
  const chunks = prepareChunks(patch)
  /** @type {string[]} */
  const tables = []
  chunks.forEach((h, i) => {
    const n = i + 1
    const id = chunkId(file.key, n)
    if (opts.chunkIds && !opts.chunkIds.has(id)) {
      return
    }
    highlightChunk(h, file.lang)
    tables.push(
      `<table class="diff" id="${esc(chunkAnchorId(file.key, n))}" data-chunk="${esc(id)}" data-key="${esc(file.key)}">` +
        `<caption class="sr">Chunk ${n} of ${esc(file.path)}</caption>${THEAD}<tbody>${buildRows(h, file.key)}</tbody></table>`
    )
  })
  if (tables.length === 0) {
    return '<div class="unavailable">No diff to show.</div>'
  }
  return `<div class="diff-wrap">${tables.join('')}</div>`
}
