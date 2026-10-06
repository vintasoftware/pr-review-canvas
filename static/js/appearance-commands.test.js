// @ts-check
// @vitest-environment happy-dom
// The header's skin and theme commands, which every page wires the same way.
import { setApiBase } from './api.js'
import { wireAppearanceCommands } from './appearance-commands.js'

/** @type {import('vitest').Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>} */
let fetchMock

/** @param {unknown} body @param {number} [status] */
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The commands in a scope of their own, as the review header draws them, with the look on `<html>`. */
function scope() {
  const root = document.documentElement
  root.setAttribute('data-skin', 'terminal')
  root.setAttribute('data-theme', 'dark')
  const holder = document.createElement('header')
  holder.innerHTML =
    '<button class="cmd" type="button" id="skin-toggle">skin: terminal</button>' +
    '<button class="cmd" type="button" id="theme-toggle">theme: dark</button>'
  document.body.append(holder)
  return holder
}

/**
 * @param {ParentNode} where
 * @param {string} id
 */
function button(where, id) {
  const el = where.querySelector(`#${id}`)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`no #${id}`)
  }
  return el
}

/** The URL, method, and body of each call made. */
function calls() {
  return fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])
}

beforeEach(() => {
  fetchMock = vi.fn(async () => respond({ skin: 'terminal', theme: 'dark' }))
  vi.stubGlobal('fetch', fetchMock)
  setApiBase('/r/acme/widgets/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('/')
  document.body.innerHTML = ''
})

describe('wireAppearanceCommands', () => {
  it('cycles the theme on <html>, relabels the command, saves it under the base, and reports the save', async () => {
    const holder = scope()
    const report = vi.fn()
    wireAppearanceCommands(holder, report)
    const theme = button(holder, 'theme-toggle')
    theme.click()
    // dark wraps around to auto, then auto goes to light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('auto')
    expect(theme.textContent).toBe('theme: auto')
    theme.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(theme.textContent).toBe('theme: light')
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
    expect(calls()).toEqual([
      ['/r/acme/widgets/api/appearance', 'PUT', { theme: 'auto' }],
      ['/r/acme/widgets/api/appearance', 'PUT', { theme: 'light' }],
    ])
    expect(report.mock.calls).toEqual([
      ['theme', true, theme],
      ['theme', true, theme],
    ])
    expect(document.documentElement.getAttribute('data-skin')).toBe('terminal')
  })

  it('cycles the skin the same way', async () => {
    const holder = scope()
    const report = vi.fn()
    wireAppearanceCommands(holder, report)
    const skin = button(holder, 'skin-toggle')
    skin.click()
    expect(document.documentElement.getAttribute('data-skin')).toBe('github')
    expect(skin.textContent).toBe('skin: github')
    skin.click()
    expect(document.documentElement.getAttribute('data-skin')).toBe('olive')
    expect(skin.textContent).toBe('skin: olive')
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
    expect(calls()).toEqual([
      ['/r/acme/widgets/api/appearance', 'PUT', { skin: 'github' }],
      ['/r/acme/widgets/api/appearance', 'PUT', { skin: 'olive' }],
    ])
    expect(report.mock.calls).toEqual([
      ['skin', true, skin],
      ['skin', true, skin],
    ])
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('reports a failed save of either, while the page keeps the new look', async () => {
    fetchMock.mockImplementation(async () =>
      respond({ error: { code: 'INTERNAL', message: 'disk full' } }, 500)
    )
    const holder = scope()
    const report = vi.fn()
    wireAppearanceCommands(holder, report)
    const theme = button(holder, 'theme-toggle')
    const skin = button(holder, 'skin-toggle')
    theme.click()
    skin.click()
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
    expect(report).toHaveBeenCalledWith('theme', false, theme)
    expect(report).toHaveBeenCalledWith('skin', false, skin)
    expect(document.documentElement.getAttribute('data-theme')).toBe('auto')
    expect(document.documentElement.getAttribute('data-skin')).toBe('github')
  })

  it('reads the look from <html> on each click, so a change made elsewhere is cycled from', () => {
    const holder = scope()
    wireAppearanceCommands(holder, () => undefined)
    document.documentElement.setAttribute('data-theme', 'light')
    button(holder, 'theme-toggle').click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('wires only the commands inside its scope', () => {
    const outside = scope()
    const inside = document.createElement('div')
    document.body.append(inside)
    const report = vi.fn()
    wireAppearanceCommands(inside, report)
    button(outside, 'theme-toggle').click()
    button(outside, 'skin-toggle').click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-skin')).toBe('terminal')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('does nothing for a scope without the commands', () => {
    const empty = document.createElement('div')
    const report = vi.fn()
    expect(() => wireAppearanceCommands(empty, report)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
})
