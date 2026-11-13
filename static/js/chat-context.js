// @ts-check
// The one thing a chat message is about. One value per message, set-not-toggle: asking about the
// same target again leaves the context as it is. Both sides use this file: the browser through a
// module import, the server through src/contract/chat.ts.

/**
 * @typedef {{ kind: 'pr' }
 *   | { kind: 'layer', layerId: string }
 *   | { kind: 'file', path: string }
 *   | { kind: 'lines', path: string, side: 'new' | 'old', start: number, end: number }
 *   | { kind: 'point', fingerprint: string }} ChatContext
 */

/** @typedef {import('./contract-types.js').TourPlace} TourPlace */
/** What a saved turn pointed at: a canvas's context, or a place of the tour in a tour thread. */
/** @typedef {ChatContext | TourPlace} ChatTurnContext */

/** @type {ChatContext} */
export const WHOLE_PR = { kind: 'pr' }

/**
 * The thread an ask about a place continues: the one this agent keeps for that place. A thread of
 * another agent is not continued, since its session belongs to that agent. A thread with no place,
 * one from before threads had a place included, is about the whole PR; new thread makes several of
 * those, and an ask about the whole PR continues the latest.
 * @template {{ agent: string, anchor?: ChatContext | undefined }} Thread
 * @param {readonly Thread[]} threads
 * @param {string} agent
 * @param {ChatContext} place
 * @returns {Thread | undefined}
 */
export function threadOfPlace(threads, agent, place) {
  return threads.findLast(t => t.agent === agent && sameChatContext(t.anchor ?? WHOLE_PR, place))
}

/**
 * True when two contexts name the same target, so setting the second one changes nothing.
 * @param {ChatTurnContext} a
 * @param {ChatTurnContext} b
 */
export function sameChatContext(a, b) {
  if (a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'pr' || a.kind === 'tour' || a.kind === 'tour-plan') {
    return true
  }
  if (a.kind === 'layer' && b.kind === 'layer') {
    return a.layerId === b.layerId
  }
  if (a.kind === 'file' && b.kind === 'file') {
    return a.path === b.path
  }
  if (a.kind === 'lines' && b.kind === 'lines') {
    return a.path === b.path && a.side === b.side && a.start === b.start && a.end === b.end
  }
  if (a.kind === 'point' && b.kind === 'point') {
    return a.fingerprint === b.fingerprint
  }
  if (a.kind === 'tour-decision' && b.kind === 'tour-decision') {
    return a.key === b.key
  }
  if (a.kind === 'tour-landmark' || a.kind === 'tour-question') {
    return a.id === /** @type {typeof a} */ (b).id
  }
  return false
}

/**
 * A place of the tour as a thread is titled after it: by the title of its landmark or decision, or
 * the words of its question, while the tour has it.
 * @param {TourPlace} place
 * @param {{ landmarks: ReadonlyArray<{ id: string, title: string }>, decisions: ReadonlyArray<{ key: string, title: string }>, quiz: ReadonlyArray<{ id: string, question: string }> }} tour
 * @returns {string}
 */
export function tourPlaceLabel(place, tour) {
  switch (place.kind) {
    case 'tour':
      return 'the whole tour'
    case 'tour-landmark': {
      const title = tour.landmarks.find(l => l.id === place.id)?.title
      return title === undefined ? `landmark ${place.id}` : `landmark · ${title}`
    }
    case 'tour-decision': {
      const title = tour.decisions.find(d => d.key === place.key)?.title
      return title === undefined ? `decision · ${place.key}` : `decision · ${title}`
    }
    case 'tour-question': {
      const question = tour.quiz.find(q => q.id === place.id)?.question
      return question === undefined ? `question ${place.id}` : `question · ${question}`
    }
    case 'tour-plan':
      return 'the plan'
  }
}

/**
 * What the chip says, and what a saved turn is labelled with. The label names the target exactly,
 * so a reader always knows what the next message is about.
 * @param {ChatTurnContext} context
 * @param {(layerId: string) => string | undefined} [layerTitle]
 * @param {(fingerprint: string) => string | undefined} [pointTitle]
 * @returns {string}
 */
export function chatContextLabel(context, layerTitle, pointTitle) {
  switch (context.kind) {
    case 'pr':
      return 'whole PR'
    case 'layer': {
      const title = layerTitle?.(context.layerId)
      return title === undefined ? `layer ${context.layerId}` : `layer · ${title}`
    }
    case 'file':
      return context.path
    case 'lines': {
      const side = context.side === 'old' ? ' (old side)' : ''
      return context.start === context.end
        ? `${context.path} line ${context.start}${side}`
        : `${context.path} lines ${context.start}–${context.end}${side}`
    }
    case 'point': {
      const title = pointTitle?.(context.fingerprint)
      return title === undefined ? 'attention point' : `point · ${title}`
    }
    case 'tour':
      return 'the whole tour'
    case 'tour-landmark':
      return `landmark ${context.id}`
    case 'tour-decision':
      return `decision · ${context.key}`
    case 'tour-question':
      return `question ${context.id}`
    case 'tour-plan':
      return 'the plan'
  }
}

/**
 * A target's name without its kind, for a place that says the kind already: a group of the
 * Threads tab, or the tag beside a thread's title. The whole PR has no name of its own.
 * @param {Exclude<ChatContext, { kind: 'pr' }>} context
 * @param {(layerId: string) => string | undefined} [layerTitle]
 * @param {(fingerprint: string) => string | undefined} [pointTitle]
 * @returns {string}
 */
export function chatContextName(context, layerTitle, pointTitle) {
  switch (context.kind) {
    case 'layer':
      return layerTitle?.(context.layerId) ?? context.layerId
    case 'point':
      return pointTitle?.(context.fingerprint) ?? 'attention point'
    case 'file':
    case 'lines':
      return chatContextLabel(context)
  }
}

/**
 * The context a `[ ask ]` element names, read from its data attributes. Returns the whole-PR
 * context for an element that names nothing.
 * @param {Element} el
 * @returns {ChatContext}
 */
export function chatContextFromElement(el) {
  const fingerprint = el.getAttribute('data-ask-point')
  if (fingerprint !== null && fingerprint !== '') {
    return { kind: 'point', fingerprint }
  }
  const layerId = el.getAttribute('data-ask-layer')
  if (layerId !== null && layerId !== '') {
    return { kind: 'layer', layerId }
  }
  const path = el.getAttribute('data-ask-path')
  if (path === null || path === '') {
    return WHOLE_PR
  }
  const start = Number(el.getAttribute('data-ask-start'))
  const end = Number(el.getAttribute('data-ask-end'))
  if (!Number.isInteger(start) || start <= 0 || !Number.isInteger(end) || end < start) {
    return { kind: 'file', path }
  }
  return { kind: 'lines', path, side: el.getAttribute('data-ask-side') === 'old' ? 'old' : 'new', start, end }
}

/**
 * The data attributes an `[ ask ]` element carries, ready to put in a template string.
 * @param {ChatContext} context
 * @returns {string}
 */
export function chatContextAttrs(context) {
  switch (context.kind) {
    case 'pr':
      return ''
    case 'layer':
      return ` data-ask-layer="${escapeAttr(context.layerId)}"`
    case 'file':
      return ` data-ask-path="${escapeAttr(context.path)}"`
    case 'lines':
      return (
        ` data-ask-path="${escapeAttr(context.path)}" data-ask-side="${context.side}"` +
        ` data-ask-start="${context.start}" data-ask-end="${context.end}"`
      )
    case 'point':
      return ` data-ask-point="${escapeAttr(context.fingerprint)}"`
  }
}

/**
 * Attribute-safe text. `dom.js` is the browser-only escaper; this file also runs on the server,
 * so it escapes the five characters an attribute value can break on itself.
 * @param {string} value
 */
function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
