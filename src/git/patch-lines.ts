// The header parser, the hunk splitter and the line lookup live in static/js/hunks.js so the
// browser can load them without a bundler; the server imports the same code here.
import { hunkForLine, splitHunks } from '../../static/js/hunks.js'
import { hunkId } from '../contract/keys.js'
import type { FileEntry, Hunk, Side } from '../contract/review-artifact.js'

export { hunkForLine, hunkLineRanges, hunkSpan, parseHunkHeader, splitHunks } from '../../static/js/hunks.js'

/** Hunk ids are `<key>#<n>` with n the 1-based position in the file's patch. */
export function buildHunkIndex(key: string, patch: string): Hunk[] {
  return splitHunks(patch).map((h, i) => ({
    id: hunkId(key, i + 1),
    header: h.header,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
  }))
}

/**
 * The patch with a `### hunk <id>` line before every hunk header, so the agent reads the same
 * ids from `derived/patches/<key>.diff` that the manifest and the prompt use.
 */
export function labelPatch(key: string, patch: string): string {
  return splitHunks(patch)
    .map((h, i) => [`### hunk ${hunkId(key, i + 1)}`, h.header, ...h.lines].join('\n'))
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
 * range sits inside one hunk on that side. Returns the reason when it will not, so the route can
 * refuse before the request leaves the machine.
 */
export function checkInlineTarget(files: ReadonlyArray<FileEntry>, target: InlineTarget): string | null {
  const file = files.find(f => f.path === target.path)
  if (file === undefined) {
    return `${target.path} is not in the diff`
  }
  const hunk = hunkForLine(file.hunks, target.side, target.line)
  if (hunk === null) {
    return `${target.path}:${target.line} (${target.side}) is not in the diff`
  }
  if (target.startLine !== undefined) {
    if (target.startLine > target.line) {
      return `the first line of the range must come before ${target.line}`
    }
    if (hunkForLine(file.hunks, target.side, target.startLine) !== hunk) {
      return `${target.path}:${target.startLine}-${target.line} (${target.side}) spans more than one chunk`
    }
  }
  return null
}
