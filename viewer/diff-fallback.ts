// A pull request's diff rebuilt from GitHub's file list, for when GitHub will not send the diff
// itself. The compare diff gives up on a very large range with 422, "The diff is taking too long
// to generate". The file lists still answer: a pull request's lists every file it changes, up to
// 3000, and a compare's lists up to 300. Each entry carries the file's patch, except for a file
// too large to diff, which comes with its line counts and no patch.
import { parseUnifiedDiff, toFileEntry, toPatchMap } from '../src/git/diff-collector.js'
import type { FileEntry } from '../src/contract/review-artifact.js'
import { explainsHead } from '../static/js/diff-identity.js'

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
  files: FileEntry[]
  /** The patch of every file GitHub sent one for; a file left out has no key here. */
  patches: Record<string, string>
  /** Files GitHub listed with changes but sent no patch for, because they are too large. */
  missing: string[]
  /**
   * Files left out of the rebuild because their name or patch could pass for diff text of its own,
   * shown with control characters escaped.
   */
  refused: string[]
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

/** Whether a name holds a control character, as a newline that would start a line of its own. */
function hasControl(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** What every line of a patch starts with: a hunk header, or a context, added, removed, or no-newline line. */
const PATCH_LINE = /^(@@ |[ +\-\\]|$)/

/**
 * Whether a file can be written as diff text and read back as itself. Git quotes a name that holds
 * a newline in its own diff, but the rebuild writes names as they are, so a name with a line break
 * could pose as another file's header and add or hide files on the page. Such a file is left out.
 */
function writable(file: GhFile): boolean {
  if (
    hasControl(file.filename) ||
    (file.previous_filename !== undefined && hasControl(file.previous_filename))
  ) {
    return false
  }
  return file.patch === undefined || file.patch.split('\n').every(line => PATCH_LINE.test(line))
}

/** A name as the page can show it: control characters escaped, as JSON writes them. */
function shownName(name: string): string {
  return JSON.stringify(name).slice(1, -1)
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
export function diffFromFiles(listed: readonly GhFile[], total: number | 'unknown'): LoadedDiff {
  // A file is written only when its own block parses back as exactly that file. Names the parser
  // would read differently (spaces at either end, a ` b/` inside) could otherwise show one file
  // under another's name.
  const files = listed.filter(file => writable(file) && roundTrips(file))
  const refused = listed.filter(file => !files.includes(file)).map(file => shownName(file.filename))
  const text = `${files.flatMap(blockOf).join('\n')}\n`
  const collected = parseUnifiedDiff(text)
  // Each block was checked alone, so the whole parses to the same files in the same order.
  if (collected.length !== files.length || collected.some((c, i) => c.path !== files[i]!.filename)) {
    throw new Error('the rebuilt diff does not read back as the files GitHub listed')
  }
  const missing: string[] = []
  const patches = toPatchMap(collected)
  const entries = collected.map((file, i) => {
    const entry = toFileEntry(file)
    const row = files[i]!
    if (row.additions + row.deletions > 0 && !row.patch) {
      // The page counts what GitHub reports, and says the file's changes are not shown.
      missing.push(file.path)
      delete patches[file.key]
      return { ...entry, additions: row.additions, deletions: row.deletions }
    }
    return entry
  })
  const unlisted = total === 'unknown' ? 'unknown' : Math.max(0, total - listed.length)
  return { files: entries, patches, missing, refused, unlisted }
}

/** Whether a file's block, parsed alone, is that one file under its own name and old name. */
function roundTrips(file: GhFile): boolean {
  const parsed = parseUnifiedDiff(`${blockOf(file).join('\n')}\n`)
  if (parsed.length !== 1) return false
  const [only] = parsed
  const renamed = file.status === 'renamed' && file.previous_filename !== undefined
  return (
    only!.path === file.filename &&
    (renamed ? only!.oldPath === file.previous_filename : only!.oldPath === undefined)
  )
}

/** A diff GitHub sent whole, as `git diff` text. */
export function diffFromText(text: string): LoadedDiff {
  const collected = parseUnifiedDiff(text)
  return {
    files: collected.map(toFileEntry),
    patches: toPatchMap(collected),
    missing: [],
    refused: [],
    unlisted: 0,
  }
}

/**
 * Whether a canvas of the diff `canvas` explains the head's diff `head`, by the local app's rule
 * (`explainsHead`). A diff GitHub sent only in part proves nothing, so it never does.
 */
export function explainsLoadedHead(canvas: LoadedDiff, head: LoadedDiff): boolean {
  const partial = (d: LoadedDiff) => d.missing.length > 0 || d.refused.length > 0 || d.unlisted !== 0
  return !partial(canvas) && !partial(head) && explainsHead(canvas.patches, head.patches)
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
  if (diff.refused.length > 0) {
    const n = diff.refused.length
    parts.push(
      `The page left out ${n} ${n === 1 ? 'file' : 'files'} whose ${n === 1 ? 'name or patch holds' : 'names or patches hold'} line breaks or other control characters, which could pass for other files (${diff.refused.slice(0, 5).join(', ')}${n > 5 ? `, and ${n - 5} more` : ''})`
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
