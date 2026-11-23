// A pull request's diff rebuilt from GitHub's file list, for when GitHub will not send the diff
// itself. The compare diff gives up on a very large range with 422, "The diff is taking too long
// to generate". The file lists still answer: a pull request's lists every file it changes, up to
// 3000, and a compare's lists up to 300. Each entry carries the file's patch, except for a file
// too large to diff, which comes with its line counts and no patch.
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../src/git/diff-collector.js'
import type { FileEntry } from '../src/contract/review-artifact.js'

/** The fields of one entry of GitHub's file lists the rebuild reads. */
export interface GhFile {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

/** How many files GitHub lists, at most: a pull request's list, and a compare's. */
export const PULL_FILES_MAX = 3000
export const COMPARE_FILES_MAX = 300

/** What a diff is, however it came: the files and their patches, and what GitHub left out. */
export interface LoadedDiff {
  /** The diff as one text, so two diffs can be told apart. */
  text: string
  files: FileEntry[]
  /** The patch of every file GitHub sent one for; a file left out has no key here. */
  patches: Record<string, string>
  /** Files GitHub listed with changes but sent no patch for, because they are too large. */
  missing: string[]
  /**
   * Files GitHub did not list at all, because the change set has more than its list holds:
   * `unknown` when the list was full and GitHub gives no total to count them by.
   */
  unlisted: number | 'unknown'
}

function isGhFile(value: unknown): value is GhFile {
  if (value === null || typeof value !== 'object') return false
  const f = value as Record<string, unknown>
  return (
    typeof f['filename'] === 'string' &&
    typeof f['status'] === 'string' &&
    typeof f['additions'] === 'number' &&
    typeof f['deletions'] === 'number' &&
    (f['patch'] === undefined || typeof f['patch'] === 'string') &&
    (f['previous_filename'] === undefined || typeof f['previous_filename'] === 'string')
  )
}

/** The entries of a file list that have the shape the rebuild reads. */
export function ghFiles(raw: unknown): GhFile[] {
  return Array.isArray(raw) ? raw.filter(isGhFile) : []
}

/** One file as `git diff` prints it, so the server's parser reads it as it reads a real diff. */
function blockOf(file: GhFile): string[] {
  const oldPath = file.previous_filename ?? file.filename
  const lines = [`diff --git a/${oldPath} b/${file.filename}`]
  if (file.status === 'renamed' && file.previous_filename !== undefined) {
    lines.push(`rename from ${file.previous_filename}`, `rename to ${file.filename}`)
  }
  if (file.status === 'added') lines.push('new file mode 100644')
  if (file.status === 'removed') lines.push('deleted file mode 100644')
  const changed = file.additions + file.deletions > 0
  if (file.patch === undefined || file.patch === '') {
    // No patch and no changed lines: GitHub says `changed` for a file whose mode alone changed,
    // and `modified` for a binary file.
    if (!changed) {
      if (file.status === 'modified') lines.push(`Binary files a/${oldPath} and b/${file.filename} differ`)
      return lines
    }
  }
  lines.push(
    file.status === 'added' ? '--- /dev/null' : `--- a/${oldPath}`,
    file.status === 'removed' ? '+++ /dev/null' : `+++ b/${file.filename}`
  )
  if (file.patch !== undefined && file.patch !== '') lines.push(...file.patch.split('\n'))
  return lines
}

/**
 * The diff of `files`, the entries of one of GitHub's file lists. `total` is how many files the
 * change set has, when GitHub says, so the files the list could not hold are counted; `unknown`
 * says the list was full with no total given.
 */
export function diffFromFiles(files: readonly GhFile[], total: number | 'unknown'): LoadedDiff {
  const text = `${files.flatMap(blockOf).join('\n')}\n`
  const collected = parseUnifiedDiff(text)
  const byPath = new Map(files.map(f => [f.filename, f]))
  const missing: string[] = []
  const patches = toPatchMap(collected)
  const entries = collected.map(file => {
    const entry = toFileEntry(file)
    const listed = byPath.get(file.path)
    if (listed !== undefined && listed.additions + listed.deletions > 0 && !listed.patch) {
      // The page counts what GitHub reports, and says the file's changes are not shown.
      missing.push(file.path)
      delete patches[file.key]
      return { ...entry, additions: listed.additions, deletions: listed.deletions }
    }
    return entry
  })
  const unlisted = total === 'unknown' ? 'unknown' : Math.max(0, total - files.length)
  return { text, files: entries, patches, missing, unlisted }
}

/** A diff GitHub sent whole, as `git diff` text. */
export function diffFromText(text: string): LoadedDiff {
  const collected = parseUnifiedDiff(text)
  return { text, files: collected.map(toFileEntry), patches: toPatchMap(collected), missing: [], unlisted: 0 }
}

/** Whether two diffs are the same, as far as either says: one with files left out proves nothing. */
export function sameLoadedDiff(a: LoadedDiff, b: LoadedDiff): boolean {
  const partial = (d: LoadedDiff) => d.missing.length > 0 || d.unlisted !== 0
  if (partial(a) || partial(b)) return false
  const keys = Object.keys(a.patches)
  return (
    keys.length === Object.keys(b.patches).length &&
    a.files.length === b.files.length &&
    keys.every(key => a.patches[key] === b.patches[key]) &&
    a.files.every((f, i) => f.path === b.files[i]?.path && f.status === b.files[i]?.status)
  )
}

/** What the page says above a canvas whose diff GitHub sent only in part; null when it sent all. */
export function incompleteWarning(diff: LoadedDiff): string | null {
  const parts: string[] = []
  const count = diff.missing.length
  if (count > 0) {
    const named = diff.missing.slice(0, 5).join(', ')
    const more = count > 5 ? `, and ${count - 5} more` : ''
    parts.push(
      `GitHub sent no changes for ${count} ${count === 1 ? 'file' : 'files'} too large to diff (${named}${more}), so the page lists ${count === 1 ? 'it' : 'them'} without ${count === 1 ? 'its' : 'their'} lines`
    )
  }
  if (diff.unlisted === 'unknown') {
    parts.push(
      'GitHub lists at most 300 files of a comparison this large, so any files past those are not shown'
    )
  } else if (diff.unlisted > 0) {
    parts.push(
      `GitHub lists at most ${PULL_FILES_MAX} files of a pull request, so ${diff.unlisted} ${diff.unlisted === 1 ? 'file is' : 'files are'} not shown`
    )
  }
  if (parts.length === 0) return null
  return `${parts.join('. ')}. Read them on GitHub, or in the local app (pr-review serve), which diffs a clone.`
}
