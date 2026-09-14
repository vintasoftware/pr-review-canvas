import { sanitizeKey, uniqueKey } from '../contract/keys.js'
import type { FileEntry } from '../contract/review-artifact.js'
import { FILE_STATUSES } from '../contract/review-artifact.js'
import type { Git } from './git.js'
import { langForPath } from './lang.js'
import { buildHunkIndex } from './patch-lines.js'

export type FileStatus = (typeof FILE_STATUSES)[number]

/** One file of the diff with its patch. The patch starts at the first `@@` line. */
export interface CollectedFile {
  path: string
  oldPath?: string
  key: string
  status: FileStatus
  additions: number
  deletions: number
  lang?: string
  patch: string
}

/** Splits `git diff` output into one block per `diff --git` header. */
export function splitBlocks(diffText: string): string[][] {
  const blocks: string[][] = []
  let cur: string[] | null = null
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur !== null) {
        blocks.push(cur)
      }
      cur = []
    }
    if (cur !== null) {
      cur.push(line)
    }
  }
  if (cur !== null) {
    blocks.push(cur)
  }
  return blocks
}

function stripPrefix(p: string | null): string | null {
  if (p === null || p === '/dev/null') {
    return null
  }
  return p.length > 2 && p[1] === '/' ? p.slice(2) : p
}

/** Parses one `diff --git` block. Returns null when no path can be found. */
export function parseBlock(lines: string[]): Omit<CollectedFile, 'key'> | null {
  const hunkAt = lines.findIndex(l => l.startsWith('@@'))
  const header = hunkAt === -1 ? lines : lines.slice(0, hunkAt)
  const body = hunkAt === -1 ? [] : lines.slice(hunkAt)

  let oldRaw: string | null = null
  let newRaw: string | null = null
  let renameFrom: string | null = null
  for (const l of header) {
    if (l.startsWith('--- ')) {
      oldRaw = l.slice(4).trim()
    } else if (l.startsWith('+++ ')) {
      newRaw = l.slice(4).trim()
    } else if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length)
    }
  }
  const oldPath = stripPrefix(oldRaw)
  const newPath = stripPrefix(newRaw)
  let path = newPath ?? oldPath

  if (path === null) {
    // No ---/+++ pair: a pure mode change, a rename without content change, or a binary file.
    // Take the b-side of the "diff --git" line.
    const m = /^diff --git a\/(.*) b\/(.*)$/.exec(lines[0] ?? '')
    path = m?.[2] ?? null
  }
  if (path === null) {
    return null
  }

  const isBinary = header.some(l => l.startsWith('Binary files ')) || header.some(l => l === 'GIT binary patch')
  let status: FileStatus
  if (renameFrom !== null) {
    status = 'renamed'
  } else if (oldPath === null && newPath !== null) {
    status = 'added'
  } else if (newPath === null && oldPath !== null) {
    status = 'deleted'
  } else if (isBinary) {
    status = 'binary'
  } else {
    status = 'modified'
  }

  // Trailing empty line from the final "\n" split belongs to no hunk.
  const bodyLines = body.length > 0 && body[body.length - 1] === '' ? body.slice(0, -1) : body
  const additions = bodyLines.filter(l => l.startsWith('+')).length
  const deletions = bodyLines.filter(l => l.startsWith('-')).length

  const file: Omit<CollectedFile, 'key'> = { path, status, additions, deletions, patch: bodyLines.join('\n') }
  const lang = langForPath(path)
  if (lang !== undefined) {
    file.lang = lang
  }
  if (renameFrom !== null) {
    file.oldPath = renameFrom
  }
  return file
}

/** Pure parse of a whole `git diff` output. Keys are unique across the result. */
export function parseUnifiedDiff(diffText: string): CollectedFile[] {
  const used = new Set<string>()
  const out: CollectedFile[] = []
  for (const block of splitBlocks(diffText)) {
    const parsed = parseBlock(block)
    if (parsed === null) {
      continue
    }
    out.push({ ...parsed, key: uniqueKey(sanitizeKey(parsed.path), used) })
  }
  return out
}

export async function collectDiffs(git: Git, base: string, head: string): Promise<CollectedFile[]> {
  return parseUnifiedDiff(await git.diff(base, head))
}

/** The manifest entry for a collected file: everything but the patch, plus the hunk index. */
export function toFileEntry(file: CollectedFile): FileEntry {
  const entry: FileEntry = {
    path: file.path,
    key: file.key,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    hunks: buildHunkIndex(file.key, file.patch),
  }
  if (file.oldPath !== undefined) {
    entry.oldPath = file.oldPath
  }
  if (file.lang !== undefined) {
    entry.lang = file.lang
  }
  return entry
}

export function toPatchMap(files: CollectedFile[]): Record<string, string> {
  return Object.fromEntries(files.map(f => [f.key, f.patch]))
}
