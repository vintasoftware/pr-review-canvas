// @ts-check
// @vitest-environment happy-dom
import {
  createDeckState,
  deckKeyAction,
  dragLean,
  exitDirection,
  nextRecord,
  openCards,
} from './deck-state.js'

/** @typedef {import('./deck-state.js').DecisionCard} DecisionCard */

/**
 * @param {string} key
 * @returns {DecisionCard}
 */
function card(key) {
  const side = { label: key, consequence: 'c', why: 'w', record: /** @type {const} */ ('none') }
  return {
    key,
    bucket: 'trade-off',
    topic: 't',
    title: key,
    context: 'c',
    path: 'a.ts',
    line: 1,
    current: 'a',
    a: side,
    b: { ...side, label: `${key}-b` },
  }
}

/**
 * @param {string} key
 * @param {Partial<KeyboardEventInit>} [init]
 * @param {EventTarget} [target]
 */
function press(key, init = {}, target = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...init })
  Object.defineProperty(event, 'target', { value: target })
  return deckKeyAction(event)
}

describe('deckKeyAction', () => {
  it('maps the deck keys and leaves the arrows alone', () => {
    expect(['a', 'b', 'n', 's', 'u', 'e', 'r', 'o', '?', 'Escape'].map(k => press(k))).toEqual([
      'pick-a',
      'pick-b',
      'neither',
      'skip',
      'undo',
      'edit',
      'record',
      'drawer',
      'help',
      'escape',
    ])
    expect(press('ArrowLeft')).toBeNull()
    expect(press('ArrowRight')).toBeNull()
  })

  it('stays quiet while typing and under modifiers, except for Escape', () => {
    const area = document.createElement('textarea')
    expect(press('a', {}, area)).toBeNull()
    expect(press('Escape', {}, area)).toBe('escape')
    expect(press('b', { ctrlKey: true })).toBeNull()
    expect(press('b', { metaKey: true })).toBeNull()
  })
})

describe('createDeckState', () => {
  it('deals the unanswered cards in order and undoes the page’s own picks, newest first', () => {
    const cards = [card('one'), card('two'), card('three')]
    const state = createDeckState(cards, { two: { choice: 'a', pickedAt: 'x' } })
    expect(state.top()?.key).toBe('one')
    expect(state.peek().map(c => c.key)).toEqual(['three'])
    expect(state.canUndo()).toBe(false)
    state.record('one', { choice: 'b', pickedAt: 'x' })
    state.record('three', { choice: 'skip', pickedAt: 'x' })
    expect(state.top()).toBeNull()
    expect(state.undo()).toBe('three')
    expect(state.top()?.key).toBe('three')
    expect(state.undo()).toBe('one')
    // A pick from an earlier visit is not this page's to undo.
    expect(state.undo()).toBeNull()
    expect(openCards(cards, state.picks()).map(c => c.key)).toEqual(['one', 'three'])
  })

  it('reopens one card from the finish screen', () => {
    const state = createDeckState([card('one')], { one: { choice: 'a', pickedAt: 'x' } })
    expect(state.top()).toBeNull()
    state.reopen('one')
    expect(state.top()?.key).toBe('one')
  })
})

describe('motion helpers', () => {
  it('sends A left, B right, neither down, skip up', () => {
    expect(['a', 'b', 'neither', 'skip'].map(c => exitDirection(/** @type {'a'} */ (c)))).toEqual([
      'left',
      'right',
      'down',
      'up',
    ])
  })

  it('leans a drag toward a side and commits past the threshold', () => {
    expect(dragLean(4, 140)).toEqual({ side: null, strength: 0, commit: false })
    expect(dragLean(-70, 140)).toEqual({ side: 'a', strength: 0.5, commit: false })
    expect(dragLean(200, 140)).toEqual({ side: 'b', strength: 1, commit: true })
  })

  it('cycles where a justification is recorded', () => {
    expect(nextRecord('pr-comment')).toBe('code')
    expect(nextRecord('code')).toBe('none')
    expect(nextRecord('none')).toBe('pr-comment')
  })
})
