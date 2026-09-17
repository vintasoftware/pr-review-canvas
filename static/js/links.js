// @ts-check
// The canvas link scheme. Four forms, used in markdown, diagrams, and chat:
//   #layer:<layerKey>
//   #file:<path>
//   #hunk:<path>#<n>
//   #line:<path>:<start>[-<end>][:old]
// The server validates links with this parser (src/contract/links.ts re-exports it) and the
// browser turns them into anchors, so both sides agree on what a link means.

/**
 * @typedef {{ kind: 'layer', layerKey: string }
 *   | { kind: 'file', path: string }
 *   | { kind: 'hunk', path: string, n: number }
 *   | { kind: 'line', path: string, start: number, end: number, side: 'new' | 'old' }} ParsedLink
 */

/**
 * @typedef {{
 *   layers: ReadonlyArray<{ key: string }>,
 *   files: ReadonlyArray<{ path: string, hunks: ReadonlyArray<import('./hunks.js').HunkRange> }>,
 * }} LinkTargets
 */
import { hunkForLine, hunkLineRanges } from './hunks.js'

const LINE_RE = /^([^\n]+?):(\d+)(?:-(\d+))?(:old)?$/

/**
 * Parses one link. Returns null for anything that is not one of the four forms.
 * @param {string} href
 * @returns {ParsedLink | null}
 */
export function parseLink(href) {
  if (href.startsWith('#layer:')) {
    const layerKey = href.slice('#layer:'.length)
    return layerKey ? { kind: 'layer', layerKey } : null
  }
  if (href.startsWith('#file:')) {
    const path = href.slice('#file:'.length)
    return path ? { kind: 'file', path } : null
  }
  if (href.startsWith('#hunk:')) {
    const m = /^(.+)#(\d+)$/.exec(href.slice('#hunk:'.length))
    if (!m || m[1] === undefined || m[2] === undefined) {
      return null
    }
    return { kind: 'hunk', path: m[1], n: Number(m[2]) }
  }
  if (href.startsWith('#line:')) {
    const m = LINE_RE.exec(href.slice('#line:'.length))
    if (!m || m[1] === undefined || m[2] === undefined) {
      return null
    }
    const start = Number(m[2])
    const end = m[3] === undefined ? start : Number(m[3])
    if (end < start) {
      return null
    }
    return { kind: 'line', path: m[1], start, end, side: m[4] ? 'old' : 'new' }
  }
  return null
}

/**
 * Every link found in a markdown text, in order. Matches the `#…` inside `](…)` and bare links
 * that stand on their own (surrounded by whitespace or at the edges).
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractLinks(markdown) {
  /** @type {string[]} */
  const out = []
  const re = /\]\((#(?:layer|file|hunk|line):[^)\s]+)\)|(?:^|\s)(#(?:layer|file|hunk|line):[^\s)]+)/g
  for (const m of markdown.matchAll(re)) {
    if (m[1] !== undefined) {
      out.push(m[1])
    } else if (m[2] !== undefined) {
      // A bare link at the end of a sentence carries the punctuation; it is not part of the target.
      out.push(m[2].replace(/[.,;:!?]+$/, ''))
    }
  }
  return out
}

/**
 * Checks a parsed link against the artifact. The message explains what is missing so the
 * validator can print it as-is.
 * @param {ParsedLink} link
 * @param {LinkTargets} targets
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function resolveLink(link, targets) {
  if (link.kind === 'layer') {
    return targets.layers.some(l => l.key === link.layerKey)
      ? { ok: true }
      : { ok: false, message: `layer ${link.layerKey} does not exist` }
  }
  const file = targets.files.find(f => f.path === link.path)
  if (!file) {
    return { ok: false, message: `${link.path} is not in the diff` }
  }
  if (link.kind === 'hunk' && (link.n < 1 || link.n > file.hunks.length)) {
    return {
      ok: false,
      message: `${link.path}#${link.n} does not exist (file has ${file.hunks.length} chunks)`,
    }
  }
  if (link.kind === 'line') {
    const start = hunkForLine(file.hunks, link.side, link.start)
    const end = hunkForLine(file.hunks, link.side, link.end)
    if (start === null || start !== end) {
      const range = link.end === link.start ? `${link.start}` : `${link.start}-${link.end}`
      return {
        ok: false,
        message: `${link.path}:${range} (${link.side}) is not inside one chunk of the diff (${hunkLineRanges(file.hunks, link.side)})`,
      }
    }
  }
  return { ok: true }
}

/**
 * The DOM id a link points at. Line links target their first line.
 * @param {ParsedLink} link
 * @param {(path: string) => string} keyFor
 * @returns {string}
 */
export function linkTargetId(link, keyFor) {
  switch (link.kind) {
    case 'layer':
      return `layer-${link.layerKey}`
    case 'file':
      return `file-${keyFor(link.path)}`
    case 'hunk':
      return `hunk-${keyFor(link.path)}-${link.n}`
    case 'line':
      return `L-${keyFor(link.path)}-${link.side}-${link.start}`
  }
}

/**
 * Short text for a link when the markdown had none, for example `packages/x.ts:40-52`.
 * @param {ParsedLink} link
 * @returns {string}
 */
export function linkLabel(link) {
  switch (link.kind) {
    case 'layer':
      return link.layerKey
    case 'file':
      return link.path
    case 'hunk':
      return `${link.path} chunk ${link.n}`
    case 'line':
      return `${link.path}:${link.start}${link.end !== link.start ? `-${link.end}` : ''}${link.side === 'old' ? ' (old)' : ''}`
  }
}
