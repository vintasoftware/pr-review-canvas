// @ts-check
// Splits a markdown text around fenced blocks with one info string. Two callers: mermaid
// diagrams and the chat's proposed-comment cards.

/** @typedef {{ type: 'markdown' | 'block', text: string }} FenceSegment */

/** A fence line: up to three spaces, the marker, then the info string. */
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*(.*)$/

/**
 * The fence a line opens or closes, or null when the line is ordinary text. A backtick fence
 * carries no backtick in its info string, which is what tells a fence from inline code.
 * @param {string} line
 * @returns {{ marker: string, info: string } | null}
 */
function fenceOf(line) {
  const match = FENCE_RE.exec(line)
  if (match === null) {
    return null
  }
  const marker = match[2] ?? ''
  const info = (match[3] ?? '').trim()
  if (marker.startsWith('`') && info.includes('`')) {
    return null
  }
  return { marker, info }
}

/**
 * The pieces of a markdown text in order: prose and the blocks whose info string is `info`. A
 * fence inside another fence is plain code, and an unclosed block is prose again, opening line
 * and all, because the reader never sees it as a block either.
 * @param {string} markdown
 * @param {string} info the info string to pick out, compared case-insensitively
 * @returns {FenceSegment[]}
 */
export function splitFences(markdown, info) {
  const wanted = info.toLowerCase()
  /** @type {FenceSegment[]} */
  const out = []
  /** @type {string[]} */
  let prose = []
  /** @type {string[]} */
  let block = []
  /** @type {{ marker: string, wanted: boolean, line: string } | null} */
  let open = null
  const flushProse = () => {
    if (prose.length > 0) {
      out.push({ type: 'markdown', text: prose.join('\n') })
      prose = []
    }
  }
  // CRLF text is read as LF, so a fence is found the same way whatever wrote the markdown.
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const fence = fenceOf(line)
    if (open === null) {
      if (fence !== null) {
        open = { marker: fence.marker, wanted: fence.info.toLowerCase() === wanted, line }
        if (open.wanted) {
          block = []
          continue
        }
      }
      prose.push(line)
      continue
    }
    const closer = fence !== null && fence.info === '' ? fence.marker : ''
    const closes = closer.length >= open.marker.length && closer[0] === open.marker[0]
    if (closes) {
      if (open.wanted) {
        flushProse()
        out.push({ type: 'block', text: block.join('\n') })
      } else {
        prose.push(line)
      }
      open = null
      continue
    }
    if (open.wanted) {
      block.push(line)
    } else {
      prose.push(line)
    }
  }
  if (open?.wanted === true) {
    prose.push(open.line, ...block)
  }
  flushProse()
  return out
}
