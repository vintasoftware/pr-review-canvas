// @ts-check
// Where the transcript stands: following the answer, or left where the reader put it. Pure, so
// the rules are testable without a scrolling element; chat.js applies the result to the DOM.

/** Within this many pixels of the bottom counts as "at the bottom". */
export const PIN_THRESHOLD_PX = 48

/**
 * @typedef {{ pinned: boolean, unseen: number, firstUnseenId: string | null }} ChatScrollState
 */

/**
 * @typedef {{ type: 'scroll', atBottom: boolean }
 *   | { type: 'append', id: string, belowFold: boolean }
 *   | { type: 'send' }
 *   | { type: 'jump' }
 *   | { type: 'thread-switch', pinned: boolean }} ChatScrollAction
 */

/** @type {ChatScrollState} */
export const INITIAL_SCROLL_STATE = { pinned: true, unseen: 0, firstUnseenId: null }

/**
 * True when the element is scrolled to within the threshold of its bottom.
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} el
 */
export function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD_PX
}

/**
 * @param {ChatScrollState} state
 * @param {ChatScrollAction} action
 * @returns {ChatScrollState}
 */
export function chatScrollReducer(state, action) {
  switch (action.type) {
    case 'scroll':
      // Scrolling back to the bottom by hand counts as catching up.
      return action.atBottom ? { pinned: true, unseen: 0, firstUnseenId: null } : { ...state, pinned: false }
    case 'append':
      // While pinned the new content is being scrolled into view, so nothing is unseen; content
      // that lands inside the part already on screen is not unseen either.
      if (state.pinned || !action.belowFold) {
        return state
      }
      return {
        pinned: false,
        unseen: state.unseen + 1,
        firstUnseenId: state.firstUnseenId ?? action.id,
      }
    case 'send':
      return { pinned: true, unseen: 0, firstUnseenId: null }
    case 'jump':
      // The jump scrolls to the first unseen message, which is not the bottom; the scroll event
      // that follows decides whether to re-pin.
      return { pinned: false, unseen: 0, firstUnseenId: null }
    case 'thread-switch':
      return { pinned: action.pinned, unseen: 0, firstUnseenId: null }
  }
}

/**
 * The bubble's text, or null when there is nothing to catch up on.
 * @param {ChatScrollState} state
 */
export function unseenLabel(state) {
  if (state.unseen === 0) {
    return null
  }
  return state.unseen === 1 ? '1 new message ↓' : `${state.unseen} new messages ↓`
}

/**
 * How to scroll: instantly while following an answer, smoothly when the reader jumps, and never
 * smoothly for a reader who asked for less motion.
 * @param {'follow' | 'jump'} reason
 * @param {boolean} reducedMotion
 * @returns {ScrollBehavior}
 */
export function scrollBehavior(reason, reducedMotion) {
  return reason === 'follow' || reducedMotion ? 'auto' : 'smooth'
}

/**
 * Whether a wheel turn over the chat pane should move the transcript instead of the page.
 *
 * The pane is pinned to the viewport, so a wheel over its header, its controls, or its composer
 * would otherwise scroll the page behind it and leave the transcript where it was. Redirecting
 * keeps one pane under one pointer. A turn that starts inside the transcript already lands there,
 * and a turn inside a control that scrolls its own text belongs to that control.
 *
 * @param {{ pinned: boolean, insideTranscript: boolean, zooming: boolean, insideOwnScroller: boolean }} at
 * @returns {boolean}
 */
export function redirectsWheelToTranscript(at) {
  if (!at.pinned || at.zooming || at.insideTranscript || at.insideOwnScroller) {
    return false
  }
  return true
}

/**
 * True when an element can still scroll in the direction a wheel turn asks for. Used to leave a
 * composer that has its own overflow in charge of its own text.
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} el
 * @param {number} deltaY
 */
export function canScrollBy(el, deltaY) {
  if (deltaY < 0) {
    return el.scrollTop > 0
  }
  return el.scrollTop + el.clientHeight < el.scrollHeight - 1
}
