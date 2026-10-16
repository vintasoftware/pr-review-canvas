// `tour hunk`: a code chunk ready for the tour model, so a generator never copies diff text by
// hand. The whole hunk as the patch has it, or the lines of a new-side range with an `@@` header
// whose numbers match the lines kept.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { TourContext } from '../contract/tour.js'
import { splitHunks } from '../git/patch-lines.js'
import type { ParsedHunk } from '../../static/js/hunks.js'

export interface ChunkRange {
  /** First new-side line kept. */
  from: number
  /** Last new-side line kept. */
  to: number
}

/**
 * The hunk, or the part of it a new-side range covers: context and added lines on those lines,
 * and the deleted lines that sit among them. Null when the range keeps no line.
 */
export function excerptHunk(hunk: ParsedHunk, range?: ChunkRange): string | null {
  if (range === undefined) return [hunk.header, ...hunk.lines].join('\n')
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  let first: { old: number; new: number } | null = null
  let oldCount = 0
  let newCount = 0
  let keptLast = false
  const kept: string[] = []
  for (const line of hunk.lines) {
    const mark = line[0]
    if (mark === '\\') {
      if (keptLast) kept.push(line)
      continue
    }
    const inRange = newLine >= range.from && newLine <= range.to
    if (inRange) {
      first ??= { old: oldLine, new: newLine }
      kept.push(line)
    }
    keptLast = inRange
    if (mark === '-') {
      if (inRange) oldCount += 1
      oldLine += 1
    } else if (mark === '+') {
      if (inRange) newCount += 1
      newLine += 1
    } else {
      if (inRange) {
        oldCount += 1
        newCount += 1
      }
      oldLine += 1
      newLine += 1
    }
  }
  if (first === null) return null
  // The text after a header's second `@@` names the enclosing function; it still does.
  const section = /^@@ [^@]* @@(.*)$/.exec(hunk.header)?.[1] ?? ''
  // A side that keeps no line names the line before the excerpt, as diff does; an added or a
  // deleted file has no line before, so its side starts at 0.
  const start = (line: number, count: number) => (count === 0 ? Math.max(0, line - 1) : line)
  const header = `@@ -${start(first.old, oldCount)},${oldCount} +${start(first.new, newCount)},${newCount} @@${section}`
  return [header, ...kept].join('\n')
}

export class HunkNotFound extends Error {}

/** The chunk for hunk `id` of the prepared change: its file's path and its diff. */
export async function tourChunk(
  context: Pick<TourContext, 'files' | 'paths'>,
  id: string,
  range?: ChunkRange
): Promise<{ path: string; diff: string }> {
  const file = context.files.find(f => f.hunks.some(h => h.id === id))
  if (file === undefined) {
    throw new HunkNotFound(`no hunk ${id} in this change; the manifest in the prompt lists every hunk id`)
  }
  const n = file.hunks.findIndex(h => h.id === id)
  const labeled = await readFile(path.join(context.paths.patches, `${file.key}.diff`), 'utf8')
  const patch = labeled
    .split('\n')
    .filter(line => !line.startsWith('### hunk '))
    .join('\n')
  const hunk = splitHunks(patch.replace(/\n$/, ''))[n]
  const diff = hunk === undefined ? null : excerptHunk(hunk, range)
  if (diff === null) {
    throw new HunkNotFound(
      `hunk ${id} has no new-side line in ${range?.from}–${range?.to}; it covers ${file.hunks[n]?.newStart}–${(file.hunks[n]?.newStart ?? 0) + (file.hunks[n]?.newLines ?? 0) - 1}`
    )
  }
  return { path: file.path, diff }
}
