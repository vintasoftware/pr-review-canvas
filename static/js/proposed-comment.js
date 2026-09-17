// @ts-check
// A ```comment block in an assistant turn is a comment the agent thinks a human should post.
// It is model output, so every field is checked against the pull request's own files before the
// card offers to post it; a block that does not check out stays a code block.
import { splitFences } from './fences.js'

/**
 * @typedef {{ path: string, line: number, side: 'new' | 'old', startLine?: number, body: string }} ProposedComment
 */

/**
 * @typedef {{ type: 'markdown', text: string }
 *   | { type: 'comment', comment: ProposedComment }
 *   | { type: 'invalid', text: string, reason: string }} ChatSegment
 */

/** The comment body a card will show; longer than this is not a review comment. */
export const PROPOSED_BODY_MAX = 4000

/**
 * What a target has to satisfy to be postable: the file is in this pull request, and the line is
 * one the diff shows on that side.
 * @typedef {{ hasPath: (path: string) => boolean, hasLine: (path: string, side: 'new' | 'old', line: number) => boolean }} CommentTargets
 */

/**
 * Reads one block. Returns the comment, or the reason the block is not one.
 * @param {string} source the text inside the fence
 * @param {CommentTargets} [targets]
 * @returns {{ comment: ProposedComment } | { reason: string }}
 */
export function parseProposedComment(source, targets) {
  /** @type {unknown} */
  let raw
  try {
    raw = JSON.parse(source)
  } catch {
    return { reason: 'the block is not JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'the block is not a JSON object' }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const field = /** @param {string} key */ key => record[key]
  const path = field('path')
  const line = field('line')
  const body = field('body')
  const sideRaw = field('side')
  const startRaw = field('startLine')
  if (typeof path !== 'string' || path === '') {
    return { reason: 'the block has no path' }
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
    return { reason: 'the block has no line number' }
  }
  if (typeof body !== 'string' || body.trim() === '') {
    return { reason: 'the block has no body' }
  }
  if (body.length > PROPOSED_BODY_MAX) {
    return { reason: 'the body is too long to post' }
  }
  if (sideRaw !== undefined && sideRaw !== 'new' && sideRaw !== 'old') {
    return { reason: 'side must be "new" or "old"' }
  }
  const side = sideRaw === 'old' ? 'old' : 'new'
  if (
    startRaw !== undefined &&
    (typeof startRaw !== 'number' || !Number.isInteger(startRaw) || startRaw <= 0)
  ) {
    return { reason: 'startLine must be a line number' }
  }
  const startLine = typeof startRaw === 'number' ? startRaw : undefined
  if (startLine !== undefined && startLine > line) {
    return { reason: 'startLine comes after line' }
  }
  if (targets !== undefined) {
    if (!targets.hasPath(path)) {
      return { reason: `${path} is not a file of this pull request` }
    }
    // Both ends of a range have to be on screen, or the comment lands where nobody looked.
    for (const at of startLine === undefined ? [line] : [startLine, line]) {
      if (!targets.hasLine(path, side, at)) {
        return { reason: `${path}:${at} is not a line the diff shows` }
      }
    }
  }
  /** @type {ProposedComment} */
  const comment = { path, line, side, body }
  if (startLine !== undefined) {
    comment.startLine = startLine
  }
  return { comment }
}

/**
 * One assistant turn split into what to render: prose, comment cards, and blocks that claimed to
 * be comments but are not.
 * @param {string} markdown
 * @param {CommentTargets} [targets]
 * @returns {ChatSegment[]}
 */
export function splitChatAnswer(markdown, targets) {
  return splitFences(markdown, 'comment').map(segment => {
    if (segment.type === 'markdown') {
      return /** @type {ChatSegment} */ ({ type: 'markdown', text: segment.text })
    }
    const parsed = parseProposedComment(segment.text, targets)
    return 'comment' in parsed
      ? /** @type {ChatSegment} */ ({ type: 'comment', comment: parsed.comment })
      : /** @type {ChatSegment} */ ({ type: 'invalid', text: segment.text, reason: parsed.reason })
  })
}

/**
 * The lines a diff shows, as the card's check needs them: every hunk's line numbers per side.
 * @param {ReadonlyArray<import('./contract-types.js').FileEntry>} files
 * @returns {CommentTargets}
 */
export function targetsFromFiles(files) {
  const byPath = new Map(files.map(f => [f.path, f]))
  return {
    hasPath: path => byPath.has(path),
    hasLine: (path, side, line) => {
      const entry = byPath.get(path)
      if (entry === undefined) {
        return false
      }
      return entry.hunks.some(h => {
        const start = side === 'new' ? h.newStart : h.oldStart
        // A hunk that adds lines shows none on the old side, and the other way round.
        const count = side === 'new' ? h.newLines : h.oldLines
        return count > 0 && line >= start && line < start + count
      })
    },
  }
}
