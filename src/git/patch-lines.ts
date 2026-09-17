// The header parser and the line lookup live in static/js/chunks.js so the browser can load them
// without a bundler; the server imports the same code here.
import { chunkForLine, parseChunkHeader } from '../../static/js/chunks.js'
import { chunkId } from '../contract/keys.js'
import type { FileEntry, Chunk, Side } from '../contract/review-artifact.js'

export { chunkForLine, chunkLineRanges, parseChunkHeader } from '../../static/js/chunks.js'

export interface ParsedChunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Body lines with their leading marker (`+`, `-`, ` `, `\`). */
  lines: string[]
}

/** Splits a patch (starting at its first `@@`) into chunks. Lines before the first header are dropped. */
export function splitChunks(patch: string): ParsedChunk[] {
  const out: ParsedChunk[] = []
  if (patch === '') {
    return out
  }
  let cur: ParsedChunk | null = null
  for (const line of patch.split('\n')) {
    const head = parseChunkHeader(line)
    if (head !== null) {
      cur = { ...head, header: line, lines: [] }
      out.push(cur)
      continue
    }
    if (cur !== null) {
      cur.lines.push(line)
    }
  }
  return out
}

/** Chunk ids are `<key>#<n>` with n the 1-based position in the file's patch. */
export function buildChunkIndex(key: string, patch: string): Chunk[] {
  return splitChunks(patch).map((h, i) => ({
    id: chunkId(key, i + 1),
    header: h.header,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
  }))
}

/**
 * The patch with a `### chunk <id>` line before every chunk header, so the agent reads the same
 * ids from `derived/patches/<key>.diff` that the manifest and the prompt use.
 */
export function labelPatch(key: string, patch: string): string {
  return splitChunks(patch)
    .map((h, i) => [`### chunk ${chunkId(key, i + 1)}`, h.header, ...h.lines].join('\n'))
    .join('\n')
}

export interface InlineTarget {
  path: string
  line: number
  side: Side
  startLine?: number | undefined
}

/**
 * Whether a comment targets lines in the local diff: the file is in the diff, and the whole
 * range sits inside one chunk on that side. Returns the reason when it will not, so the route can
 * refuse before the request leaves the machine.
 */
export function checkInlineTarget(files: ReadonlyArray<FileEntry>, target: InlineTarget): string | null {
  const file = files.find(f => f.path === target.path)
  if (file === undefined) {
    return `${target.path} is not in the diff`
  }
  const chunk = chunkForLine(file.chunks, target.side, target.line)
  if (chunk === null) {
    return `${target.path}:${target.line} (${target.side}) is not in the diff`
  }
  if (target.startLine !== undefined) {
    if (target.startLine > target.line) {
      return `the first line of the range must come before ${target.line}`
    }
    if (chunkForLine(file.chunks, target.side, target.startLine) !== chunk) {
      return `${target.path}:${target.startLine}-${target.line} (${target.side}) spans more than one chunk`
    }
  }
  return null
}
