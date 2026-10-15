// @ts-check
// @vitest-environment happy-dom
// The skin and theme commands of the project list and a project's home page.
import { setApiBase } from './api.js'
import { wireAppearance } from './page-appearance.js'

/** @type {import('vitest').Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>} */
let fetchMock

/** @param {unknown} body @param {number} [status] */
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A page as the server renders it: the appearance on `<html>`, the bootstrap, and the commands.
 * @param {string | null} bootstrap the bootstrap's text, or null for a page without one
 */
function page(bootstrap) {
  const root = document.documentElement
  root.setAttribute('data-skin', 'github')
  root.setAttribute('data-theme', 'auto')
  document.head.innerHTML =
    bootstrap === null ? '' : `<script id="bootstrap" type="application/json">${bootstrap}</script>`
  document.body.innerHTML =
    '<button class="cmd" type="button" id="skin-toggle">skin: github</button>' +
    '<button class="cmd" type="button" id="theme-toggle">theme: auto</button>'
}

/** @param {string} id */
function button(id) {
  const el = document.getElementById(id)
  if (el === null) {
    throw new Error(`no #${id}`)
  }
  return el
}

/** The URL and body of each call the page made. */
function calls() {
  return fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])
}

beforeEach(() => {
  fetchMock = vi.fn(async () => respond({ skin: 'github', theme: 'auto' }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBase('/')
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('wireAppearance', () => {
  it('cycles the theme on the page, relabels the command, and saves it under the base path', async () => {
    page(JSON.stringify({ base: '/r/acme/widgets/', version: '1.2.3' }))
    wireAppearance(document)
    const theme = button('theme-toggle')
    theme.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(theme.textContent).toBe('theme: light')
    theme.click()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(theme.textContent).toBe('theme: dark')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(calls()).toEqual([
      ['/r/acme/widgets/api/appearance', 'PUT', { theme: 'light' }],
      ['/r/acme/widgets/api/appearance', 'PUT', { theme: 'dark' }],
    ])
    // The skin stays as it was.
    expect(document.documentElement.getAttribute('data-skin')).toBe('github')
  })

  it('cycles the skin and saves it', async () => {
    page(JSON.stringify({ base: '/', version: '1.2.3' }))
    wireAppearance(document)
    const skin = button('skin-toggle')
    skin.click()
    expect(document.documentElement.getAttribute('data-skin')).toBe('olive')
    expect(skin.textContent).toBe('skin: olive')
    await vi.waitFor(() => expect(calls()).toEqual([['/api/appearance', 'PUT', { skin: 'olive' }]]))
    expect(document.documentElement.getAttribute('data-theme')).toBe('auto')
  })

  it('says in the title when a save fails, and clears the mark once one succeeds', async () => {
    page(JSON.stringify({ base: '/' }))
    wireAppearance(document)
    const theme = button('theme-toggle')
    const skin = button('skin-toggle')
    fetchMock.mockImplementation(async () =>
      respond({ error: { code: 'INTERNAL', message: 'disk full' } }, 500)
    )
    theme.click()
    skin.click()
    await vi.waitFor(() => expect(theme.hasAttribute('data-save-failed')).toBe(true))
    await vi.waitFor(() => expect(skin.hasAttribute('data-save-failed')).toBe(true))
    expect(theme.title).toBe('Could not save the theme; it applies to this page only')
    expect(skin.title).toBe('Could not save the skin; it applies to this page only')
    // The page wears the new look even though it was not saved.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    fetchMock.mockImplementation(async () => respond({ skin: 'olive', theme: 'dark' }))
    theme.click()
    await vi.waitFor(() => expect(theme.hasAttribute('data-save-failed')).toBe(false))
    expect(skin.hasAttribute('data-save-failed')).toBe(true)
  })

  it('calls the API at the server root when the bootstrap names no base or is not JSON', async () => {
    for (const bootstrap of [null, '{oops', JSON.stringify({ base: 7 })]) {
      setApiBase('/elsewhere/')
      page(bootstrap)
      wireAppearance(document)
      button('theme-toggle').click()
    }
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/appearance',
      '/api/appearance',
      '/api/appearance',
    ])
  })

  it('does nothing for a page without the commands', () => {
    page(JSON.stringify({ base: '/' }))
    document.body.innerHTML = ''
    expect(() => wireAppearance(document)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the module', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('wires the page it loads on when the page has a bootstrap', async () => {
    page(JSON.stringify({ base: '/r/acme/widgets/' }))
    vi.resetModules()
    await import('./page-appearance.js')
    button('skin-toggle').click()
    expect(button('skin-toggle').textContent).toBe('skin: olive')
    await vi.waitFor(() =>
      expect(calls()).toEqual([['/r/acme/widgets/api/appearance', 'PUT', { skin: 'olive' }]])
    )
  })

  it('does nothing where there is no document', async () => {
    vi.stubGlobal('document', undefined)
    vi.resetModules()
    await expect(import('./page-appearance.js')).resolves.toHaveProperty('wireAppearance')
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('leaves a page without a bootstrap alone', async () => {
    page(null)
    vi.resetModules()
    await import('./page-appearance.js')
    button('skin-toggle').click()
    expect(button('skin-toggle').textContent).toBe('skin: github')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
