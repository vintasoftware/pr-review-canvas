// @ts-check
// @vitest-environment happy-dom
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../../src/server/context.js'
import {
  COPY_RESULT_MS,
  clearCommandError,
  runCommand,
  runControl,
  showCommandError,
  toast,
  wireCopyCommands,
} from './commands.js'

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
    expect(button?.textContent).toBe('copied')
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

  describe('says how the copy went', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
      vi.clearAllTimers()
      vi.useRealTimers()
    })

    /** @param {(text: string) => Promise<void>} copy */
    const clickCopy = async copy => {
      const root = document.createElement('div')
      root.innerHTML = '<button class="cmd" data-copy="x">copy</button>'
      wireCopyCommands(root, copy)
      const button = /** @type {HTMLButtonElement} */ (root.querySelector('button'))
      button.click()
      await vi.advanceTimersByTimeAsync(0)
      return { root, button }
    }

    it('marks the button copied for a moment and toasts it', async () => {
      const { root, button } = await clickCopy(async () => {})
      expect(button.textContent).toBe('copied')
      expect(button.getAttribute('data-copied')).toBe('copied')
      const box = root.querySelector('.toast')
      expect(box?.textContent).toBe('copied to clipboard')
      expect(box?.classList.contains('failed')).toBe(false)
      vi.advanceTimersByTime(COPY_RESULT_MS)
      expect(button.textContent).toBe('copy')
      expect(button.hasAttribute('data-copied')).toBe(false)
    })

    it('marks the button failed, toasts the failure, and gives the reason beside the button', async () => {
      const { root, button } = await clickCopy(async () => {
        throw new Error('Write permission denied.')
      })
      expect(button.textContent).toBe('failed')
      expect(button.getAttribute('data-copied')).toBe('failed')
      const box = root.querySelector('.toast')
      expect(box?.textContent).toBe('could not copy')
      expect(box?.classList.contains('failed')).toBe(true)
      expect(root.querySelector('.cmd-err')?.textContent).toBe('Write permission denied.')
      vi.advanceTimersByTime(COPY_RESULT_MS)
      expect(button.textContent).toBe('copy')
    })

    it('gives a second click the label copy back, and its own moment', async () => {
      const { button } = await clickCopy(async () => {})
      vi.advanceTimersByTime(COPY_RESULT_MS - 500)
      button.click()
      await vi.advanceTimersByTimeAsync(0)
      expect(button.textContent).toBe('copied')
      vi.advanceTimersByTime(COPY_RESULT_MS - 1)
      expect(button.textContent).toBe('copied')
      vi.advanceTimersByTime(1)
      expect(button.textContent).toBe('copy')
    })
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

describe('toast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('clears the dismissal notification after five seconds', () => {
    const root = document.createElement('div')
    const box = toast(root, 'attention point dismissed')

    vi.advanceTimersByTime(4999)
    expect(box.textContent).toBe('attention point dismissed')
    vi.advanceTimersByTime(1)
    expect(box.textContent).toBe('')
  })

  it('gives a replacement notification its own five seconds', () => {
    const root = document.createElement('div')
    const box = toast(root, 'attention point dismissed')
    vi.advanceTimersByTime(3000)
    toast(root, 'attention point restored')

    vi.advanceTimersByTime(2000)
    expect(box.textContent).toBe('attention point restored')
    vi.advanceTimersByTime(3000)
    expect(box.textContent).toBe('')
  })

  it('draws a failure as one, and the next message as ordinary again', () => {
    const root = document.createElement('div')
    expect(toast(root, 'could not copy', { failed: true }).classList.contains('failed')).toBe(true)
    expect(toast(root, 'copied to clipboard').classList.contains('failed')).toBe(false)
  })

  it('keeps the page region apart from the region of a dialog inside the page', () => {
    const root = document.createElement('div')
    root.innerHTML = '<dialog open></dialog>'
    const dialog = /** @type {HTMLElement} */ (root.querySelector('dialog'))
    const inDialog = toast(dialog, 'copied to clipboard')
    const onPage = toast(root, 'comment posted to github')
    expect(onPage).not.toBe(inDialog)
    expect(onPage.parentElement).toBe(root)
    expect(inDialog.textContent).toBe('copied to clipboard')
  })

  it('reuses one live region', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const root = document.querySelector('#root')
    if (!(root instanceof HTMLElement)) {
      throw new Error('no root')
    }
    expect(toast(root, 'one').getAttribute('aria-live')).toBe('polite')
    expect(toast(root, 'two').textContent).toBe('two')
    expect(root.querySelectorAll('.toast').length).toBe(1)
  })
})

// showCopyResult puts the word `copy` back after a result, so every copy button must carry it.
it('labels every rendered copy button copy', async () => {
  const dir = path.join(PACKAGE_ROOT, 'static/js')
  const sources = (await readdir(dir)).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
  /** @type {string[]} */
  const labels = []
  for (const file of sources) {
    const text = await readFile(path.join(dir, file), 'utf8')
    for (const m of text.matchAll(/data-copy="[^"]*"[^>]*>([^<]*)</g)) {
      labels.push(`${file}: ${m[1]}`)
    }
  }
  expect(labels.length).toBeGreaterThan(5)
  expect(labels.filter(l => !l.endsWith(': copy'))).toEqual([])
})
