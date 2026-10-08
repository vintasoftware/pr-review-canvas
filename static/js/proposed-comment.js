// @ts-check
// A ```comment block in an assistant turn is a comment the agent thinks a human should post, and
// a ```resolve block is a reason it thinks the author could resolve an attention point with. Both
// are model output, so every field is checked against the pull request's own files and points
// before a card offers to act on it; a block that does not check out stays a code block.
import { splitFences } from './fences.js'

/**
 * `point` is the attention point the comment acts on, when the agent named one this canvas has.
 * @typedef {{ path: string, line: number, side: 'new' | 'old', startLine?: number, body: string, proposalFingerprint?: string, point?: ProposalPoint }} ProposedComment
 */

/** @typedef {{ fingerprint: string, title: string }} ProposalPoint */

/**
 * How the agent names an attention point in a proposed comment: the start of its fingerprint.
 * A fingerprint follows the point's kind, path, and title, so the name holds across the canvases
 * one chat thread sees, where a point's position in the list does not.
 * @param {string} fingerprint
 */
export function pointRef(fingerprint) {
  return fingerprint.slice(0, 8)
}

/**
 * A ```resolve block: the agent's proposal that the author resolve an attention point with this
 * reason. Only the author can act on it; the page decides who sees it as a card.
 * @typedef {{ point: ProposalPoint, reason: string }} ProposedResolution
 */

/**
 * @typedef {{ type: 'markdown', text: string }
 *   | { type: 'comment', comment: ProposedComment }
 *   | { type: 'resolution', resolution: ProposedResolution }
 *   | { type: 'invalid', text: string, reason: string }} ChatSegment
 */

/** The comment body a card will show; longer than this is not a review comment. */
export const PROPOSED_BODY_MAX = 4000

/** The longest reason a settlement takes. The contract and the reason box read it from here too. */
export const SETTLEMENT_REASON_MAX = 600

/** @param {string} body */
export function normalizedCommentBody(body) {
  return body.replace(/\r\n/g, '\n').trimEnd()
}

/**
 * Identity of the original proposal. Draft edits keep this key, as attention-point edits do.
 * FNV-1a over the anchor and normalized body works synchronously in both browser and server.
 * @param {ProposedComment} comment
 */
export function proposalFingerprint(comment) {
  const source = JSON.stringify([
    comment.path,
    comment.side,
    comment.startLine ?? comment.line,
    comment.line,
    normalizedCommentBody(comment.body),
  ])
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(source)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return `proposal:${hash.toString(16).padStart(16, '0')}`
}

/**
 * What a target has to satisfy to be postable: the file is in this pull request, and the line is
 * one the diff shows on that side. `pointFor` finds the attention point a `point` field names, and
 * `resolves` says whether this reader may resolve points here, which a resolution needs.
 * @typedef {{
 *   hasPath: (path: string) => boolean,
 *   hasLine: (path: string, side: 'new' | 'old', line: number) => boolean,
 *   pointFor?: (ref: string) => ProposalPoint | undefined,
 *   resolves?: boolean,
 * }} CommentTargets
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
  // A point the canvas does not have links nothing; the comment itself is still good to post.
  const ref = field('point')
  const point = typeof ref === 'string' ? targets?.pointFor?.(ref) : undefined
  if (point !== undefined) {
    comment.point = point
  }
  return { comment }
}

/**
 * Reads one ```resolve block. Unlike a comment, a resolution is about its point and nothing else,
 * so a block that names no attention point of this canvas is not one. Only a reader who may resolve
 * points here gets one, and only with a reason the route will take.
 * @param {string} source the text inside the fence
 * @param {CommentTargets} [targets]
 * @returns {{ resolution: ProposedResolution } | { reason: string }}
 */
export function parseProposedResolution(source, targets) {
  if (targets?.resolves !== true) {
    return { reason: 'attention points cannot be resolved here' }
  }
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
  const ref = record['point']
  const reason = record['reason']
  const point = typeof ref === 'string' ? targets?.pointFor?.(ref) : undefined
  if (point === undefined) {
    return { reason: 'the block names no attention point of this canvas' }
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return { reason: 'the block has no reason' }
  }
  if (reason.trim().length > SETTLEMENT_REASON_MAX) {
    return { reason: 'the reason is too long to save' }
  }
  return { resolution: { point, reason: reason.trim() } }
}

/**
 * One assistant turn split into what to render: prose, comment cards, resolution cards, and
 * blocks that claimed to be one of those but are not.
 * @param {string} markdown
 * @param {CommentTargets} [targets]
 * @returns {ChatSegment[]}
 */
export function splitChatAnswer(markdown, targets) {
  return splitFences(markdown, ['comment', 'resolve']).map(segment => {
    if (segment.type === 'markdown') {
      return /** @type {ChatSegment} */ ({ type: 'markdown', text: segment.text })
    }
    if (segment.info === 'resolve') {
      const parsed = parseProposedResolution(segment.text, targets)
      return 'resolution' in parsed
        ? /** @type {ChatSegment} */ ({ type: 'resolution', resolution: parsed.resolution })
        : /** @type {ChatSegment} */ ({ type: 'invalid', text: segment.text, reason: parsed.reason })
    }
    const parsed = parseProposedComment(segment.text, targets)
    return 'comment' in parsed
      ? /** @type {ChatSegment} */ ({ type: 'comment', comment: parsed.comment })
      : /** @type {ChatSegment} */ ({ type: 'invalid', text: segment.text, reason: parsed.reason })
  })
}

/**
 * The lines a diff shows, as the card's check needs them: every hunk's line numbers per side, and
 * the attention points a comment may name. A name two points share names neither.
 * @param {ReadonlyArray<import('./contract-types.js').FileEntry>} files
 * @param {ReadonlyArray<Pick<import('./contract-types.js').Point, 'fingerprint' | 'title'>>} [points]
 * @param {boolean} [resolves] whether this reader may resolve points here
 * @returns {CommentTargets}
 */
export function targetsFromFiles(files, points = [], resolves = false) {
  const byPath = new Map(files.map(f => [f.path, f]))
  return {
    resolves,
    pointFor: ref => {
      const named = points.filter(p => pointRef(p.fingerprint) === ref)
      const only = named.length === 1 ? named[0] : undefined
      return only === undefined ? undefined : { fingerprint: only.fingerprint, title: only.title }
    },
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
