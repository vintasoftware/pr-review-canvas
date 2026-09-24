// @ts-check
// The self-review deck's decisions that are not DOM: which key does what, which card is on top,
// and what an undo takes back. deck.js draws and animates; this module only answers.

/** @typedef {'a' | 'b'} CardSide */
/** @typedef {'a' | 'b' | 'neither' | 'skip'} PickChoice */
/** @typedef {'pr-comment' | 'code' | 'none'} RecordTarget */
/**
 * @typedef {{ label: string, consequence: string, snippet?: { lang?: string, code: string },
 *   why: string, record: RecordTarget }} SideContent
 */
/**
 * @typedef {{ key: string, bucket: string, topic: string, title: string, context: string,
 *   path: string, line: number, side?: 'new' | 'old', current: CardSide | null,
 *   a: SideContent, b: SideContent }} DecisionCard
 */
/** @typedef {{ choice: PickChoice, why?: string, note?: string, record?: RecordTarget, pickedAt: string }} Pick */
/**
 * @typedef {'pick-a' | 'pick-b' | 'neither' | 'skip' | 'undo' | 'edit' | 'record' | 'drawer'
 *   | 'help' | 'escape'} DeckAction
 */

/** Rows of the help dialog, in the order a first-time reader needs them. */
export const DECK_KEY_HELP = [
  { keys: 'a', what: 'pick side A, the left card half' },
  { keys: 'b', what: 'pick side B, the right card half' },
  { keys: 'n', what: 'neither side: say what you want instead' },
  { keys: 's', what: 'skip: leave the decision to reviewers' },
  { keys: 'u', what: 'undo the last pick' },
  { keys: 'e', what: 'edit the justification of either side before picking' },
  { keys: 'r', what: 'change where a justification is recorded' },
  { keys: 'o', what: 'open or close the code the card is about' },
  { keys: '?', what: 'this help' },
  { keys: 'Esc', what: 'close the note, the editor, the code, or this help' },
]

/** Where a record target sends a justification, as the card says it. */
export const RECORD_LABELS = /** @type {const} */ ({
  'pr-comment': 'PR comment',
  code: 'in the code',
  none: 'not recorded',
})

/** @type {readonly RecordTarget[]} */
export const RECORD_ORDER = ['pr-comment', 'code', 'none']

/**
 * @param {RecordTarget} target
 * @returns {RecordTarget}
 */
export function nextRecord(target) {
  return RECORD_ORDER[(RECORD_ORDER.indexOf(target) + 1) % RECORD_ORDER.length] ?? 'none'
}

/**
 * True while the reader is typing, when no deck key may fire.
 * @param {EventTarget | null} target
 */
function isTyping(target) {
  if (!(target instanceof Element)) {
    return false
  }
  const tag = target.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.closest('[contenteditable="true"]') !== null
  )
}

/** @type {Record<string, DeckAction>} */
const KEYS = {
  a: 'pick-a',
  b: 'pick-b',
  n: 'neither',
  s: 'skip',
  u: 'undo',
  e: 'edit',
  r: 'record',
  o: 'drawer',
  '?': 'help',
}

/**
 * The action a key press asks for, or null. Arrow keys are left alone on purpose: they scroll and
 * move focus, and a pick is not something to make by accident.
 * @param {KeyboardEvent} event
 * @returns {DeckAction | null}
 */
export function deckKeyAction(event) {
  const altGraph = event.getModifierState?.('AltGraph') === true
  if (event.metaKey || ((event.ctrlKey || event.altKey) && !altGraph)) {
    return null
  }
  if (event.key === 'Escape') {
    return 'escape'
  }
  if (isTyping(event.target)) {
    return null
  }
  return KEYS[event.key] ?? null
}

/**
 * Whether a pick asks the code to change: the other side, or neither side.
 * @param {DecisionCard} card
 * @param {Pick} pick
 */
export function pickNeedsFix(card, pick) {
  if (pick.choice === 'skip') {
    return false
  }
  return pick.choice === 'neither' || pick.choice !== card.current
}

/**
 * The cards still to answer, in deck order.
 * @param {readonly DecisionCard[]} cards
 * @param {Readonly<Record<string, Pick>>} picks
 */
export function openCards(cards, picks) {
  return cards.filter(card => picks[card.key] === undefined)
}

/**
 * The deck in play: the cards not yet answered, and the picks made on this page, newest last, so
 * an undo can put the last card back on top.
 * @param {readonly DecisionCard[]} cards
 * @param {Readonly<Record<string, Pick>>} picks
 */
export function createDeckState(cards, picks) {
  /** @type {string[]} */
  const history = []
  let answered = { ...picks }
  return {
    /** @returns {DecisionCard | null} */
    top() {
      return openCards(cards, answered)[0] ?? null
    },
    /** The card after the top one, drawn peeking behind it. */
    peek() {
      return openCards(cards, answered).slice(1, 3)
    },
    picks() {
      return answered
    },
    /** @param {Readonly<Record<string, Pick>>} next */
    replacePicks(next) {
      answered = { ...next }
    },
    /**
     * @param {string} key
     * @param {Pick} pick
     */
    record(key, pick) {
      answered = { ...answered, [key]: pick }
      history.push(key)
    },
    /** The key the last pick on this page was for, taken back; null when there is none. */
    undo() {
      const key = history.pop()
      if (key === undefined) {
        return null
      }
      const { [key]: _dropped, ...rest } = answered
      answered = rest
      return key
    },
    /**
     * Takes back one card's pick, from the finish screen.
     * @param {string} key
     */
    reopen(key) {
      const { [key]: _dropped, ...rest } = answered
      answered = rest
      const at = history.lastIndexOf(key)
      if (at >= 0) {
        history.splice(at, 1)
      }
    },
    canUndo() {
      return history.length > 0
    },
  }
}

/**
 * Which way a card leaves the screen for a choice, and comes back from on an undo.
 * @param {PickChoice} choice
 * @returns {'left' | 'right' | 'down' | 'up'}
 */
export function exitDirection(choice) {
  if (choice === 'a') return 'left'
  if (choice === 'b') return 'right'
  return choice === 'neither' ? 'down' : 'up'
}

/**
 * The side a drag is leaning to and how sure it is, from its horizontal distance. Past
 * `threshold` pixels, letting go picks that side.
 * @param {number} dx
 * @param {number} threshold
 * @returns {{ side: CardSide | null, strength: number, commit: boolean }}
 */
export function dragLean(dx, threshold) {
  const strength = Math.min(1, Math.abs(dx) / threshold)
  if (Math.abs(dx) < 8) {
    return { side: null, strength: 0, commit: false }
  }
  return { side: dx < 0 ? 'a' : 'b', strength, commit: Math.abs(dx) >= threshold }
}
