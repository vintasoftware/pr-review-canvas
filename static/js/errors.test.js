// @ts-check
// @vitest-environment happy-dom
import { ERROR_CODES } from '../../src/contract/api.js'
import { ERROR_CARDS, errorCardFor, errorCardHtml } from './errors.js'

describe('error cards', () => {
  it('renders a card per known code with title, message, hint, action, and a retry command', () => {
    document.body.innerHTML = errorCardHtml({
      code: 'GH_UNAUTHENTICATED',
      message: 'gh is not logged in',
      hint: 'run `gh auth login`',
    })
    const card = document.querySelector('section.error-card')
    expect(card?.getAttribute('data-code')).toBe('GH_UNAUTHENTICATED')
    expect(card?.querySelector('h2')?.textContent).toBe('GitHub CLI is not logged in GH_UNAUTHENTICATED')
    expect([...(card?.querySelectorAll('.body p') ?? [])].map(p => p.textContent)).toEqual([
      'gh is not logged in',
      'run `gh auth login`',
      'Run gh auth login in a terminal, then retry.',
      'retry',
    ])
    expect(card?.querySelector('#retry')?.className).toBe('cmd fill')
    for (const code of ['GH_MISSING', 'PR_NOT_FOUND', 'INTERNAL']) {
      document.body.innerHTML = errorCardHtml({ code: /** @type {'INTERNAL'} */ (code), message: 'm' })
      expect(document.querySelector('h2')?.textContent).toBe(`${ERROR_CARDS[code]?.title} ${code}`)
      expect(document.querySelectorAll('.body p').length).toBe(3)
    }
  })

  it('has a card for every code the server can answer with', () => {
    const missing = ERROR_CODES.filter(code => ERROR_CARDS[code] === undefined)
    expect(missing).toEqual([])
    for (const code of ERROR_CODES) {
      document.body.innerHTML = errorCardHtml({ code, message: 'm' })
      const card = document.querySelector('section.error-card')
      expect(card?.getAttribute('data-code')).toBe(code)
      expect(card?.querySelector('h2')?.textContent).toBe(`${ERROR_CARDS[code]?.title} ${code}`)
      // Title, message, and the action: a card that says nothing to do is not a card.
      expect(card?.querySelectorAll('.body p').length).toBe(3)
      expect(ERROR_CARDS[code]?.action).not.toBe('')
    }
  })

  it('falls back to the generic card for an unknown code and escapes the message', () => {
    const unknown = /** @type {'INTERNAL'} */ ('SOMETHING_NEW')
    expect(errorCardFor({ code: unknown, message: 'x' })).toEqual(
      errorCardFor({ code: 'INTERNAL', message: '' })
    )
    document.body.innerHTML = errorCardHtml({ code: unknown, message: '<b>bold</b>' })
    expect(document.querySelector('h2')?.textContent).toBe('Something went wrong SOMETHING_NEW')
    expect(document.querySelector('.body p')?.innerHTML).toBe('&lt;b&gt;bold&lt;/b&gt;')
  })
})
