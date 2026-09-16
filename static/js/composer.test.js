// @ts-check
// @vitest-environment happy-dom
import {
  applyCapabilityGating,
  closeComposers,
  composerBody,
  composerHtml,
  composerInput,
  composerRowHtml,
  focusComposer,
  NO_POSTING_TITLE,
  setDisabledReason,
  toggleMarkdownPreview,
} from './composer.js'

/** @param {string} html */
function mount(html) {
  document.body.innerHTML = html
  const box = document.querySelector('.composer-box')
  if (box === null) {
    throw new Error('no composer')
  }
  return box
}

/** @param {Element} box @param {string} text */
function type(box, text) {
  const area = box.querySelector('textarea')
  if (!(area instanceof HTMLTextAreaElement)) {
    throw new Error('no textarea')
  }
  area.value = text
  return area
}

describe('composerHtml', () => {
  it('carries its target as data attributes and leaves out what it has none of', () => {
    const box = mount(
      composerHtml({
        id: 'c1',
        label: 'Comment on src/app.ts:4',
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
      })
    )
    expect(box.getAttribute('data-kind')).toBe('inline')
    expect(box.getAttribute('data-path')).toBe('src/app.ts')
    expect(box.getAttribute('data-line')).toBe('4')
    expect(box.hasAttribute('data-start-line')).toBe(false)
    expect(box.querySelector('label')?.getAttribute('for')).toBe('c1-t')
    expect([...box.querySelectorAll('button')].map(b => b.getAttribute('data-act'))).toEqual([
      'markdown-toggle',
      'composer-post',
      'composer-cancel',
    ])
  })

  it('escapes the draft and the label it is given', () => {
    const box = mount(
      composerHtml({ id: 'c1', label: '<b>x</b>', kind: 'issue', body: '<script>bad()</script>' })
    )
    expect(box.querySelector('script')).toBeNull()
    expect(composerBody(box)).toBe('<script>bad()</script>')
    expect(box.querySelector('label')?.textContent).toBe('<b>x</b>')
  })

  it('wraps itself in a diff row when it sits under a line', () => {
    document.body.innerHTML = `<table><tbody>${composerRowHtml({ id: 'c1', label: 'x', kind: 'inline', path: 'a.ts', line: 1, side: 'new' })}</tbody></table>`
    expect(document.querySelector('tr.composer .composer-box')).not.toBeNull()
    expect(document.querySelector('tr.composer')?.getAttribute('data-decoration')).toBe('composer')
  })
})

describe('composerInput', () => {
  it('builds an inline comment, with the range only when it spans lines', () => {
    const box = mount(
      composerHtml({
        id: 'c1',
        label: 'x',
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'old',
        startLine: 2,
      })
    )
    type(box, '  look here  ')
    expect(composerInput(box)).toEqual({
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'old',
      startLine: 2,
      body: 'look here',
    })
    const single = mount(
      composerHtml({
        id: 'c2',
        label: 'x',
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        startLine: 4,
      })
    )
    type(single, 'one line')
    expect(composerInput(single)).toEqual({
      kind: 'inline',
      path: 'src/app.ts',
      line: 4,
      side: 'new',
      body: 'one line',
    })
  })

  it('carries the attention point it was opened from', () => {
    const box = mount(
      composerHtml({
        id: 'c1',
        label: 'x',
        kind: 'inline',
        path: 'src/app.ts',
        line: 4,
        side: 'new',
        pointFingerprint: 'fp-1',
      })
    )
    type(box, 'body')
    expect(composerInput(box)).toMatchObject({ pointFingerprint: 'fp-1' })
  })

  it('builds a reply and a PR-level comment', () => {
    const reply = mount(composerHtml({ id: 'c1', label: 'Reply', kind: 'reply', inReplyToId: 1001 }))
    type(reply, 'agreed')
    expect(composerInput(reply)).toEqual({ kind: 'reply', inReplyToId: 1001, body: 'agreed' })
    const issue = mount(composerHtml({ id: 'c2', label: 'Comment', kind: 'issue' }))
    type(issue, 'looks fine')
    expect(composerInput(issue)).toEqual({ kind: 'issue', body: 'looks fine' })
  })

  it('answers null for an empty box and for one that lost its target', () => {
    const empty = mount(composerHtml({ id: 'c1', label: 'x', kind: 'issue' }))
    expect(composerInput(empty)).toBeNull()
    const reply = mount(composerHtml({ id: 'c2', label: 'x', kind: 'reply', inReplyToId: 1 }))
    type(reply, 'hi')
    reply.setAttribute('data-in-reply-to', 'nope')
    expect(composerInput(reply)).toBeNull()
    const inline = mount(
      composerHtml({ id: 'c3', label: 'x', kind: 'inline', path: 'a.ts', line: 4, side: 'new' })
    )
    type(inline, 'hi')
    inline.removeAttribute('data-path')
    expect(composerInput(inline)).toBeNull()
  })

  it('reads an empty body from a box without a textarea', () => {
    document.body.innerHTML = '<div class="composer-box"></div>'
    const box = document.querySelector('.composer-box')
    expect(box === null ? '' : composerBody(box)).toBe('')
  })
})

describe('focusComposer and closeComposers', () => {
  it('focuses the box it just opened', () => {
    mount(composerHtml({ id: 'c1', label: 'x', kind: 'issue' }))
    expect(focusComposer(document, 'c1')).toBe(document.activeElement)
    expect(focusComposer(document, 'missing')).toBeNull()
  })

  it('removes every open box, row and all', () => {
    document.body.innerHTML =
      `<table><tbody>${composerRowHtml({ id: 'c1', label: 'x', kind: 'inline', path: 'a.ts', line: 1, side: 'new' })}</tbody></table>` +
      composerHtml({ id: 'c2', label: 'x', kind: 'issue' })
    expect(closeComposers(document)).toBe(2)
    expect(document.querySelectorAll('.composer-box').length).toBe(0)
    expect(document.querySelectorAll('tr.composer').length).toBe(0)
    expect(closeComposers(document)).toBe(0)
  })
})

describe('applyCapabilityGating', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button data-needs-post>post</button><button>other</button><span data-needs-post>not a button</span>' +
      '<span class="capability-note"></span>'
  })

  it('disables what posts and says why when the token may not', () => {
    expect(
      applyCapabilityGating(document, {
        canComment: false,
        tokenKind: 'classic',
        login: 'octocat',
        reason: 'no repo scope',
      })
    ).toBe(true)
    const button = document.querySelector('button[data-needs-post]')
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(button?.getAttribute('title')).toBe('no repo scope')
  })

  it('falls back to a general reason and enables everything again', () => {
    applyCapabilityGating(document, { canComment: false, tokenKind: 'classic', login: null })
    expect(document.querySelector('button[data-needs-post]')?.getAttribute('title')).toBe(NO_POSTING_TITLE)
    expect(
      applyCapabilityGating(document, { canComment: true, tokenKind: 'classic', login: 'octocat' })
    ).toBe(false)
    const button = document.querySelector('button[data-needs-post]')
    expect(button?.hasAttribute('disabled')).toBe(false)
    expect(button?.hasAttribute('title')).toBe(false)
  })

  it('leaves posting enabled for a token whose rights cannot be read', () => {
    applyCapabilityGating(document, { canComment: 'unknown', tokenKind: 'fine-grained', login: 'octocat' })
    expect(document.querySelector('button[data-needs-post]')?.hasAttribute('disabled')).toBe(false)
  })

  it('says in plain sight why posting is off, and takes the line back', () => {
    applyCapabilityGating(document, {
      canComment: false,
      tokenKind: 'classic',
      login: null,
      reason: 'no repo scope',
    })
    expect(document.querySelector('.capability-note')?.textContent).toBe(
      'Posting to GitHub is off: no repo scope'
    )
    applyCapabilityGating(document, { canComment: true, tokenKind: 'classic', login: 'octocat' })
    expect(document.querySelector('.capability-note')?.textContent).toBe('')
  })

  it('keeps a command that is disabled for a reason of its own disabled', () => {
    const button = document.querySelector('button[data-needs-post]')
    setDisabledReason(button, 'every layer must be read first')
    expect(button?.hasAttribute('disabled')).toBe(true)
    applyCapabilityGating(document, {
      canComment: false,
      tokenKind: 'classic',
      login: null,
      reason: 'no scope',
    })
    expect(button?.getAttribute('title')).toBe('no scope')
    // Posting becomes allowed, but the command's own reason still holds.
    applyCapabilityGating(document, { canComment: true, tokenKind: 'classic', login: 'octocat' })
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(button?.getAttribute('title')).toBe('every layer must be read first')
    setDisabledReason(button, null)
    expect(button?.hasAttribute('disabled')).toBe(false)
    expect(button?.hasAttribute('title')).toBe(false)
  })

  it('leaves a command alone while its request is running', () => {
    const button = document.querySelector('button[data-needs-post]')
    button?.setAttribute('aria-busy', 'true')
    if (button instanceof HTMLButtonElement) {
      button.disabled = true
    }
    applyCapabilityGating(document, { canComment: true, tokenKind: 'classic', login: 'octocat' })
    expect(button?.hasAttribute('disabled')).toBe(true)
  })

  it('ignores an element that is not a command', () => {
    setDisabledReason(document.querySelector('span[data-needs-post]'), 'nope')
    expect(document.querySelector('span[data-needs-post]')?.hasAttribute('data-disabled-reason')).toBe(false)
  })
})

describe('Markdown preview', () => {
  it('renders a draft safely, reports an empty preview, and returns focus to the unchanged draft', () => {
    const box = mount(composerHtml({ id: 'preview', label: 'Comment', kind: 'issue' }))
    const textarea = type(box, '**hello** <script>bad()</script>')
    const button = box.querySelector('[data-act="markdown-toggle"]')
    if (!(button instanceof HTMLElement)) throw new Error('missing preview button')
    expect(button.textContent).toBe('preview')
    toggleMarkdownPreview(button)
    expect(textarea.hidden).toBe(true)
    expect(box.querySelector('.markdown-preview strong')?.textContent).toBe('hello')
    expect(box.querySelector('.markdown-preview script')).toBeNull()
    expect(button.textContent).toBe('write')
    toggleMarkdownPreview(button)
    expect(textarea.hidden).toBe(false)
    expect(button.textContent).toBe('preview')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.value).toBe('**hello** <script>bad()</script>')
    textarea.value = '  '
    toggleMarkdownPreview(button)
    expect(box.querySelector('.markdown-preview')?.textContent).toBe('Nothing to preview.')
  })

  it('ignores a preview command after its editor has been removed', () => {
    const button = document.createElement('button')
    expect(() => toggleMarkdownPreview(button)).not.toThrow()
  })

  it('keeps capability restrictions when a local disabled reason changes', () => {
    const box = mount(composerHtml({ id: 'blocked', label: 'Comment', kind: 'issue' }))
    const button = box.querySelector('[data-act="composer-post"]')
    applyCapabilityGating(box, { canComment: false, tokenKind: 'classic', login: null, reason: 'no scope' })
    setDisabledReason(button, 'saving')
    expect(button?.getAttribute('title')).toBe('no scope')
    setDisabledReason(button, null)
    expect(button?.hasAttribute('disabled')).toBe(true)
    expect(button?.getAttribute('title')).toBe('no scope')
  })
})
