// @ts-check
// What the agent says in a grilling, taken apart: prose, the restatement it emits as a fenced
// ```restatement block, and the whole plan as a ```plan block. Both are model output, so each is
// checked before it becomes a card; a block that does not check out stays a code block.
/** @typedef {import('../contract-types.js').Restatement} Restatement */
import { splitFences } from '../fences.js'

/**
 * @typedef {{ changes: Array<Restatement & { key: string }>, kept: string[] }} PlanBlock
 * @typedef {{ type: 'markdown', text: string }
 *   | { type: 'restatement', restatement: Restatement }
 *   | { type: 'plan', plan: PlanBlock }
 *   | { type: 'invalid', text: string, reason: string }} GrillSegment
 */

/** A restatement's fields are short; longer is a paste, not a restatement. */
export const RESTATEMENT_FIELD_MAX = 2000

/**
 * @param {unknown} raw
 * @returns {{ restatement: Restatement } | { reason: string }}
 */
export function readRestatementBlock(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'the block is not a JSON object' }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const what = record['what']
  const where = record['where']
  const unchanged = record['unchanged']
  if (typeof what !== 'string' || what.trim() === '' || what.length > RESTATEMENT_FIELD_MAX) {
    return { reason: 'the block has no "what"' }
  }
  if (typeof unchanged !== 'string' || unchanged.trim() === '' || unchanged.length > RESTATEMENT_FIELD_MAX) {
    return { reason: 'the block has no "unchanged"' }
  }
  const places = Array.isArray(where) ? where.filter(w => typeof w === 'string' && w.trim() !== '') : []
  if (places.length === 0 || places.length > 20) {
    return { reason: 'the block has no "where"' }
  }
  return {
    restatement: {
      what: what.trim(),
      where: places.map(w => String(w).trim().slice(0, 300)),
      unchanged: unchanged.trim(),
    },
  }
}

/**
 * @param {unknown} raw
 * @param {ReadonlySet<string>} keys the decision keys of this tour
 * @returns {{ plan: PlanBlock } | { reason: string }}
 */
export function readPlanBlock(raw, keys) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { reason: 'the block is not a JSON object' }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)
  const changes = record['changes']
  const kept = record['kept']
  if (!Array.isArray(changes) || !Array.isArray(kept)) {
    return { reason: 'the block needs "changes" and "kept" lists' }
  }
  /** @type {PlanBlock['changes']} */
  const out = []
  for (const entry of changes) {
    const key =
      typeof entry === 'object' && entry !== null
        ? /** @type {Record<string, unknown>} */ (entry)['key']
        : null
    if (typeof key !== 'string' || !keys.has(key)) {
      return { reason: `a change names a decision this tour does not have: ${String(key)}` }
    }
    const read = readRestatementBlock(entry)
    if ('reason' in read) {
      return { reason: `the change ${key}: ${read.reason}` }
    }
    out.push({ key, ...read.restatement })
  }
  const keptKeys = kept.filter(k => typeof k === 'string')
  const unknown = keptKeys.find(k => !keys.has(k))
  if (unknown !== undefined) {
    return { reason: `a kept decision this tour does not have: ${unknown}` }
  }
  return { plan: { changes: out, kept: keptKeys } }
}

/**
 * The pieces of an answer in order: prose, restatement cards, plan cards, and what failed to be one.
 * @param {string} markdown
 * @param {ReadonlySet<string>} keys
 * @returns {GrillSegment[]}
 */
export function splitGrillAnswer(markdown, keys) {
  /** @type {GrillSegment[]} */
  const out = []
  // Two fence kinds in one pass: each block of one kind is prose to the splitter of the other.
  for (const outer of splitFences(markdown, 'restatement')) {
    if (outer.type === 'block') {
      out.push(restatementSegment(outer.text))
      continue
    }
    for (const inner of splitFences(outer.text, 'plan')) {
      if (inner.type === 'markdown') {
        if (inner.text.trim() !== '') {
          out.push({ type: 'markdown', text: inner.text })
        }
        continue
      }
      out.push(planSegment(inner.text, keys))
    }
  }
  return out
}

/** @param {string} source */
function parseJson(source) {
  try {
    return { value: /** @type {unknown} */ (JSON.parse(source)) }
  } catch {
    return { reason: 'the block is not JSON' }
  }
}

/**
 * @param {string} text
 * @returns {GrillSegment}
 */
function restatementSegment(text) {
  const parsed = parseJson(text)
  if ('reason' in parsed) {
    return { type: 'invalid', text, reason: parsed.reason }
  }
  const read = readRestatementBlock(parsed.value)
  return 'reason' in read
    ? { type: 'invalid', text, reason: read.reason }
    : { type: 'restatement', restatement: read.restatement }
}

/**
 * @param {string} text
 * @param {ReadonlySet<string>} keys
 * @returns {GrillSegment}
 */
function planSegment(text, keys) {
  const parsed = parseJson(text)
  if ('reason' in parsed) {
    return { type: 'invalid', text, reason: parsed.reason }
  }
  const read = readPlanBlock(parsed.value, keys)
  return 'reason' in read ? { type: 'invalid', text, reason: read.reason } : { type: 'plan', plan: read.plan }
}
