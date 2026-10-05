// @ts-check
// @vitest-environment happy-dom
// The project list's remove commands.
import { setApiBase } from './api.js'
import { wireRemove } from './projects-page.js'

/** @type {import('vitest').Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>} */
let fetchMock
/** @type {import('vitest').MockInstance<() => void>} */
let reload

/** @param {unknown} body @param {number} [status] */
function respond(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The list as the server renders it, one remove command per project. */
function list() {
  document.body.innerHTML =
    '<ul class="plain body">' +
    '<li><a href="/r/acme/widgets/">acme/widgets</a> <button class="cmd project-remove" type="button" data-remove="/r/acme/widgets/">remove</button></li>' +
    '<li><a href="/r/acme/gadgets/">acme/gadgets</a> <button class="cmd project-remove" type="button" data-remove="/r/acme/gadgets/">remove</button></li>' +
    '</ul>'
}

/** @param {string} basePath */
function removeButton(basePath) {
  const el = document.querySelector(`button[data-remove="${basePath}"]`)
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`no remove command for ${basePath}`)
  }
  return el
}

/** @param {HTMLButtonElement} button */
function noteAfter(button) {
  return button.parentElement?.querySelectorAll('.project-error') ?? []
}

beforeEach(() => {
  fetchMock = vi.fn(async () => respond({ removed: true }))
  reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setApiBase('/')
  document.body.innerHTML = ''
})

describe('wireRemove', () => {
  it('posts the project path, disables the command while it waits, and reloads the list', async () => {
    list()
    wireRemove(document, fetchMock)
    const button = removeButton('/r/acme/gadgets/')
    button.click()
    expect(button.disabled).toBe(true)
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))])
    ).toEqual([['/api/projects/remove', 'POST', { basePath: '/r/acme/gadgets/' }]])
    expect(removeButton('/r/acme/widgets/').disabled).toBe(false)
  })

  it('uses the page fetch when given none', async () => {
    vi.stubGlobal('fetch', fetchMock)
    list()
    wireRemove(document)
    removeButton('/r/acme/widgets/').click()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal next to its command, enables it again, and replaces the note on a retry', async () => {
    list()
    fetchMock.mockImplementation(async () =>
      respond(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'acme/widgets has a chat turn or a generation running',
            hint: 'remove it once that ends',
          },
        },
        409
      )
    )
    wireRemove(document, fetchMock)
    const button = removeButton('/r/acme/widgets/')
    button.click()
    await vi.waitFor(() => expect(noteAfter(button)).toHaveLength(1))
    const note = button.nextElementSibling
    expect(note?.className).toBe('project-error')
    expect(note?.getAttribute('role')).toBe('status')
    expect(note?.textContent).toBe('acme/widgets has a chat turn or a generation running')
    expect(button.disabled).toBe(false)
    expect(reload).not.toHaveBeenCalled()
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch')
    })
    button.click()
    // The old note goes as soon as the command runs again.
    expect(noteAfter(button)).toHaveLength(0)
    await vi.waitFor(() => expect(noteAfter(button)).toHaveLength(1))
    expect(button.nextElementSibling?.textContent).toBe('Failed to fetch')
    expect(removeButton('/r/acme/gadgets/').nextElementSibling).toBeNull()
  })

  it('shows a failure that is not an Error as text', async () => {
    list()
    fetchMock.mockImplementation(() => Promise.reject('offline'))
    wireRemove(document, fetchMock)
    const button = removeButton('/r/acme/widgets/')
    button.click()
    await vi.waitFor(() => expect(button.nextElementSibling?.textContent).toBe('offline'))
  })

  it('copes with a command taken off the page and a document with no window', async () => {
    list()
    const detached = removeButton('/r/acme/widgets/')
    wireRemove(document, fetchMock)
    detached.remove()
    detached.click()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    const doc = document.implementation.createHTMLDocument('list')
    doc.body.innerHTML = '<button type="button" data-remove="/r/acme/widgets/">remove</button>'
    wireRemove(doc, fetchMock)
    doc.querySelector('button')?.click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // Let the answer settle: with no window there is nothing to reload, and nothing throws.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(doc.querySelector('.project-error')).toBeNull()
  })

  it('skips a match that is not a button', () => {
    const div = document.createElement('div')
    const listen = vi.spyOn(div, 'addEventListener')
    const doc = /** @type {Document} */ (/** @type {unknown} */ ({ querySelectorAll: () => [div] }))
    wireRemove(doc, fetchMock)
    expect(listen).not.toHaveBeenCalled()
  })
})

describe('the module', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('wires the page it loads on', async () => {
    vi.stubGlobal('fetch', fetchMock)
    list()
    vi.resetModules()
    await import('./projects-page.js')
    removeButton('/r/acme/widgets/').click()
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('does nothing where there is no document', async () => {
    vi.stubGlobal('document', undefined)
    vi.resetModules()
    await expect(import('./projects-page.js')).resolves.toHaveProperty('wireRemove')
  })
})
