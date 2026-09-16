// @ts-check
// @vitest-environment happy-dom
import { clearCommandError, runCommand, runControl, showCommandError, wireCopyCommands } from './commands.js'

describe('runCommand', () => {
  /** @returns {HTMLButtonElement} */
  function button() {
    document.body.innerHTML = '<p><button class="cmd" type="button">export zip</button></p>'
    const el = document.querySelector('button')
    if (!(el instanceof HTMLButtonElement)) {
      throw new Error('no button')
    }
    return el
  }

  it('disables the element, shows the label with an ellipsis while running, and restores it', async () => {
    const el = button()
    /** @type {{ disabled: boolean, text: string | null, busy: string | null } | null} */
    let during = null
    const result = await runCommand(el, async () => {
      during = { disabled: el.disabled, text: el.textContent, busy: el.getAttribute('aria-busy') }
      return 7
    })
    expect(result).toBe(7)
    expect(during).toEqual({ disabled: true, text: 'export zip…', busy: 'true' })
    expect(el.disabled).toBe(false)
    expect(el.textContent).toBe('export zip')
    expect(el.hasAttribute('aria-busy')).toBe(false)
    expect(document.querySelector('.cmd-err')).toBeNull()
  })

  it('shows the failure inline with role=alert and clears it on the next run', async () => {
    const el = button()
    const result = await runCommand(
      el,
      async () => {
        throw new Error('GitHub said no')
      },
      { pendingLabel: 'working…' }
    )
    expect(result).toBeUndefined()
    const err = document.querySelector('.cmd-err')
    expect(err?.textContent).toBe('GitHub said no')
    expect(err?.getAttribute('role')).toBe('alert')
    expect(el.textContent).toBe('export zip')
    await runCommand(el, async () => 'ok')
    expect(document.querySelector('.cmd-err')).toBeNull()
  })

  it('handles non-Error throws and non-button elements', async () => {
    document.body.innerHTML = '<a class="cmd">help</a>'
    const el = document.querySelector('a')
    if (!(el instanceof HTMLElement)) {
      throw new Error('no anchor')
    }
    await runCommand(el, async () => {
      throw 'plain string'
    })
    expect(document.querySelector('.cmd-err')?.textContent).toBe('plain string')
    showCommandError(el, 'second')
    expect(document.querySelectorAll('.cmd-err').length).toBe(1)
    expect(document.querySelector('.cmd-err')?.textContent).toBe('second')
    clearCommandError(el)
    expect(document.querySelector('.cmd-err')).toBeNull()
    clearCommandError(el)
  })
})

describe('wireCopyCommands', () => {
  it('copies once per click after the root re-rendered any number of times', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    /** @type {string[]} */
    const written = []
    const copy = async (/** @type {string} */ text) => void written.push(text)
    expect(wireCopyCommands(root, copy)).toBe(true)
    for (let i = 0; i < 3; i++) {
      // Each render replaces the content, as the page does when a canvas appears.
      root.innerHTML = `<p><button class="cmd fill" data-copy="/pr-review-canvas ${i}">copy</button></p>`
      expect(wireCopyCommands(root, copy)).toBe(false)
    }
    const button = root.querySelector('button')
    button?.click()
    await Promise.resolve()
    expect(written).toEqual(['/pr-review-canvas 2'])
    await new Promise(r => setTimeout(r, 0))
    expect(button?.textContent).toBe('copy')
    expect(button?.disabled).toBe(false)
    // Clicks elsewhere copy nothing.
    root.querySelector('p')?.click()
    expect(written).toEqual(['/pr-review-canvas 2'])
  })

  it('shows the clipboard failure next to the button', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    root.innerHTML = '<button data-copy="x">copy</button>'
    wireCopyCommands(root, async () => {
      throw new Error('clipboard is not available')
    })
    root.querySelector('button')?.click()
    await new Promise(r => setTimeout(r, 0))
    expect(root.querySelector('.cmd-err')?.textContent).toBe('clipboard is not available')
  })
})

describe('runControl', () => {
  it('keeps the label of a checkbox, marks it busy, and gives it back afterwards', async () => {
    document.body.innerHTML = '<label class="chk"><input type="checkbox"> reviewed</label>'
    const label = document.querySelector('label')
    const box = document.querySelector('input')
    if (!(label instanceof HTMLElement && box instanceof HTMLInputElement)) {
      throw new Error('no control')
    }
    /** @type {{ busy: string | null, disabled: boolean, text: string } | null} */
    let during = null
    const result = await runControl(label, async () => {
      during = {
        busy: label.getAttribute('aria-busy'),
        disabled: box.disabled,
        text: label.textContent ?? '',
      }
      return 'ok'
    })
    expect(result).toBe('ok')
    expect(during).toEqual({ busy: 'true', disabled: true, text: ' reviewed' })
    expect(label.querySelector('input')).toBe(box)
    expect(box.disabled).toBe(false)
    expect(label.hasAttribute('aria-busy')).toBe(false)
  })

  it('shows a thrown value that is not an Error as text', async () => {
    document.body.innerHTML = '<p><input type="checkbox" id="c"></p>'
    const box = document.querySelector('#c')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no control')
    }
    await runControl(box, () => Promise.reject('plain string'))
    expect(document.querySelector('.cmd-err')?.textContent).toBe('plain string')
  })

  it('shows the failure next to the control and re-enables it', async () => {
    document.body.innerHTML = '<p><input type="checkbox" id="b"></p>'
    const box = document.querySelector('#b')
    if (!(box instanceof HTMLInputElement)) {
      throw new Error('no control')
    }
    expect(
      await runControl(box, async () => {
        throw new Error('offline')
      })
    ).toBeUndefined()
    expect(document.querySelector('.cmd-err')?.textContent).toBe('offline')
    expect(box.disabled).toBe(false)
  })
})
