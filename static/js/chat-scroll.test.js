// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  canScrollBy,
  chatScrollReducer,
  INITIAL_SCROLL_STATE,
  isAtBottom,
  PIN_THRESHOLD_PX,
  redirectsWheelToTranscript,
  scrollBehavior,
  unseenLabel,
} from './chat-scroll.js'

/**
 * @param {import('./chat-scroll.js').ChatScrollState} state
 * @param {import('./chat-scroll.js').ChatScrollAction[]} actions
 */
function run(state, actions) {
  return actions.reduce(chatScrollReducer, state)
}

describe('isAtBottom', () => {
  it('counts the last 48 pixels as the bottom', () => {
    expect(isAtBottom({ scrollTop: 952, scrollHeight: 1000, clientHeight: 0 })).toBe(true)
    expect(isAtBottom({ scrollTop: 951, scrollHeight: 1000, clientHeight: 0 })).toBe(false)
    expect(PIN_THRESHOLD_PX).toBe(48)
  })
})

describe('chatScrollReducer', () => {
  it('starts pinned with nothing unseen', () => {
    expect(INITIAL_SCROLL_STATE).toEqual({ pinned: true, unseen: 0, firstUnseenId: null })
  })

  it('unpins as soon as the reader scrolls up, and re-pins at the bottom', () => {
    const up = chatScrollReducer(INITIAL_SCROLL_STATE, { type: 'scroll', atBottom: false })
    expect(up).toEqual({ pinned: false, unseen: 0, firstUnseenId: null })
    expect(chatScrollReducer(up, { type: 'scroll', atBottom: true })).toEqual({
      pinned: true,
      unseen: 0,
      firstUnseenId: null,
    })
  })

  it('counts what lands below the fold while unpinned, and remembers the first of them', () => {
    const state = run(INITIAL_SCROLL_STATE, [
      { type: 'scroll', atBottom: false },
      { type: 'append', id: 'turn-1', belowFold: true },
      { type: 'append', id: 'turn-2', belowFold: true },
    ])
    expect(state).toEqual({ pinned: false, unseen: 2, firstUnseenId: 'turn-1' })
  })

  it('counts nothing while pinned, because the viewport is following the answer', () => {
    expect(chatScrollReducer(INITIAL_SCROLL_STATE, { type: 'append', id: 'a', belowFold: true })).toEqual(
      INITIAL_SCROLL_STATE
    )
  })

  it('counts nothing for content that lands inside the part already on screen', () => {
    const unpinned = chatScrollReducer(INITIAL_SCROLL_STATE, { type: 'scroll', atBottom: false })
    expect(chatScrollReducer(unpinned, { type: 'append', id: 'a', belowFold: false })).toEqual(unpinned)
  })

  it('re-pins and clears the count when the reader sends a message', () => {
    const state = run(INITIAL_SCROLL_STATE, [
      { type: 'scroll', atBottom: false },
      { type: 'append', id: 'a', belowFold: true },
      { type: 'send' },
    ])
    expect(state).toEqual({ pinned: true, unseen: 0, firstUnseenId: null })
  })

  it('clears the count on a jump without pinning, so the scroll event decides', () => {
    const state = run(INITIAL_SCROLL_STATE, [
      { type: 'scroll', atBottom: false },
      { type: 'append', id: 'a', belowFold: true },
      { type: 'jump' },
    ])
    expect(state).toEqual({ pinned: false, unseen: 0, firstUnseenId: null })
    expect(chatScrollReducer(state, { type: 'scroll', atBottom: true }).pinned).toBe(true)
  })

  it('takes the pinned state of the thread being switched to, and forgets the count', () => {
    const state = run(INITIAL_SCROLL_STATE, [
      { type: 'scroll', atBottom: false },
      { type: 'append', id: 'a', belowFold: true },
      { type: 'thread-switch', pinned: false },
    ])
    expect(state).toEqual({ pinned: false, unseen: 0, firstUnseenId: null })
    expect(chatScrollReducer(state, { type: 'thread-switch', pinned: true }).pinned).toBe(true)
  })
})

describe('unseenLabel', () => {
  it('says nothing when nothing is unseen, and counts in words otherwise', () => {
    expect(unseenLabel({ pinned: true, unseen: 0, firstUnseenId: null })).toBeNull()
    expect(unseenLabel({ pinned: false, unseen: 1, firstUnseenId: 'a' })).toBe('1 new message ↓')
    expect(unseenLabel({ pinned: false, unseen: 4, firstUnseenId: 'a' })).toBe('4 new messages ↓')
  })
})

describe('scrollBehavior', () => {
  it('never animates while following an answer, and not at all for a reader who asked for less motion', () => {
    expect(scrollBehavior('follow', false)).toBe('auto')
    expect(scrollBehavior('jump', false)).toBe('smooth')
    expect(scrollBehavior('jump', true)).toBe('auto')
  })
})

describe('redirectsWheelToTranscript', () => {
  const pinned = { pinned: true, insideTranscript: false, zooming: false, insideOwnScroller: false }

  it('redirects a turn over the pane that is not already in a scroller', () => {
    expect(redirectsWheelToTranscript(pinned)).toBe(true)
  })

  it('leaves the page alone where the pane is not pinned', () => {
    // The narrow layout drops the pin, so the pane scrolls with the page like any other column.
    expect(redirectsWheelToTranscript({ ...pinned, pinned: false })).toBe(false)
  })

  it('leaves a turn that already lands somewhere of its own', () => {
    expect(redirectsWheelToTranscript({ ...pinned, insideTranscript: true })).toBe(false)
    expect(redirectsWheelToTranscript({ ...pinned, insideOwnScroller: true })).toBe(false)
  })

  it('never takes a zoom gesture', () => {
    expect(redirectsWheelToTranscript({ ...pinned, zooming: true })).toBe(false)
  })
})

describe('canScrollBy', () => {
  it('is true only while there is room in the direction asked for', () => {
    const top = { scrollTop: 0, scrollHeight: 300, clientHeight: 100 }
    expect(canScrollBy(top, -1)).toBe(false)
    expect(canScrollBy(top, 1)).toBe(true)
    const bottom = { scrollTop: 200, scrollHeight: 300, clientHeight: 100 }
    expect(canScrollBy(bottom, 1)).toBe(false)
    expect(canScrollBy(bottom, -1)).toBe(true)
  })

  it('is false both ways for content that fits', () => {
    const fits = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 }
    expect(canScrollBy(fits, 1)).toBe(false)
    expect(canScrollBy(fits, -1)).toBe(false)
  })
})
