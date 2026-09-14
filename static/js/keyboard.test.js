// @ts-check
// @vitest-environment happy-dom
import { HELP_DIALOG_ID, isTypingTarget, KEY_HELP, keyAction, openHelpDialog } from './keyboard.js'

/**
 * @param {string} key
 * @param {{ target?: EventTarget | null, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean }} [opts]
 * @returns {KeyboardEvent}
 */
function press(key, opts = {}) {
  return /** @type {KeyboardEvent} */ ({
    key,
    target: opts.target ?? null,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    altKey: opts.altKey ?? false,
  })
}

describe('keyAction', () => {
  it('maps every key of the review page', () => {
    const pairs = [
      ['j', 'next-layer'],
      ['k', 'prev-layer'],
      ['n', 'next-file'],
      ['p', 'prev-file'],
      [']', 'next-point'],
      ['[', 'prev-point'],
      ['o', 'toggle'],
      ['r', 'reviewed-file'],
      ['R', 'reviewed-layer'],
      ['c', 'comment'],
      ['d', 'dismiss'],
      ['?', 'help'],
      ['Escape', 'escape'],
    ]
    expect(pairs.map(([key]) => keyAction(press(String(key))).action)).toEqual(pairs.map(([, action]) => action))
  })

  it('sends a and / to the chat pane and says nothing for other keys', () => {
    expect([keyAction(press('a')).action, keyAction(press('/')).action]).toEqual(['ask', 'focus-chat'])
    expect(keyAction(press('z')).action).toBeNull()
  })

  it('waits for the second key of g o', () => {
    const first = keyAction(press('g'))
    expect(first).toEqual({ action: null, pendingG: true })
    expect(keyAction(press('o'), { pendingG: true })).toEqual({ action: 'overview', pendingG: false })
    // Any other key after g does nothing and forgets the sequence.
    expect(keyAction(press('x'), { pendingG: true })).toEqual({ action: null, pendingG: false })
  })

  it('stays quiet while a modifier is held, so browser shortcuts keep working', () => {
    expect(keyAction(press('j', { ctrlKey: true })).action).toBeNull()
    expect(keyAction(press('j', { metaKey: true })).action).toBeNull()
    expect(keyAction(press('j', { altKey: true })).action).toBeNull()
  })

  it('stays quiet while the reader is typing, except for Esc', () => {
    document.body.innerHTML =
      '<textarea id="t"></textarea><input id="i"><select id="s"></select><div contenteditable="true"><span id="c">x</span></div><p id="p">x</p>'
    for (const id of ['t', 'i', 's', 'c']) {
      const target = document.querySelector(`#${id}`)
      expect([id, keyAction(press('j', { target })).action]).toEqual([id, null])
      expect([id, keyAction(press('Escape', { target })).action]).toEqual([id, 'escape'])
    }
    expect(keyAction(press('j', { target: document.querySelector('#p') })).action).toBe('next-layer')
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('the help dialog', () => {
  it('lists every key once, the reserved ones included', () => {
    document.body.innerHTML = '<pr-app id="root"></pr-app>'
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    const dialog = openHelpDialog(root)
    expect(dialog.id).toBe(HELP_DIALOG_ID)
    expect([...dialog.querySelectorAll('table.keys tr')].length).toBe(KEY_HELP.length)
    expect(dialog.textContent).toContain('ask AI Chat about the card, point, or selection in focus')
    // Opening it again reuses the same element.
    expect(openHelpDialog(root)).toBe(dialog)
    expect(document.querySelectorAll('dialog').length).toBe(1)
  })
})
