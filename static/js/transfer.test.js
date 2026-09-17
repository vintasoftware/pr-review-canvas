// @ts-check
// @vitest-environment happy-dom
// The browser side of canvas transfer: the drop zone, the export command, and the two screens
// that offer them.
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/host/capabilities.js'
import { syntheticArtifact } from '../../src/testing/synthetic.js'
import {
  ApiError,
  fetchCanvasZip,
  fetchSharedCanvas,
  filenameFromDisposition,
  importCanvas,
  uploadForm,
} from './api.js'
import { exportCanvasZip, saveBlob } from './download.js'
import {
  dropReducer,
  INITIAL_DROP_STATE,
  renderEmptyState,
  renderStaleState,
  sharedCanvasCalloutHtml,
  mergesBarHtml,
  staleBarHtml,
  staleSummary,
  validateCanvasFilename,
} from './empty-state.js'
import { dropStatusText, wireDropZone } from './import-zone.js'

/** @typedef {import('./contract-types.js').PrBundle} PrBundle */

const NOW = '2026-09-10T12:00:00.000Z'
const HEAD = 'a'.repeat(40)
const OLD = 'e'.repeat(40)

/**
 * @param {Partial<PrBundle>} [over]
 * @returns {PrBundle}
 */
function bundle(over = {}) {
  const artifact = syntheticArtifact()
  return /** @type {PrBundle} */ ({
    status: 'missing',
    pr: artifact.pr,
    files: artifact.files,
    derivable: true,
    skillCommand: '/pr-review-canvas 42',
    comments: { fetchedAt: NOW, headSha: HEAD, reviewComments: [], issueComments: [] },
    state: emptyState(NOW),
    capabilities: UNKNOWN_CAPABILITIES,
    chat: { enabled: true },
    largePr: false,
    warnings: [],
    ...over,
  })
}

describe('drop state', () => {
  it('moves through hover, upload, and failure without losing a busy upload', () => {
    let state = dropReducer(INITIAL_DROP_STATE, { type: 'enter' })
    expect(state.phase).toBe('over')
    state = dropReducer(state, { type: 'leave' })
    expect(state.phase).toBe('idle')
    state = dropReducer(state, { type: 'start' })
    expect(state).toEqual({ phase: 'busy', progress: 0, error: null })
    expect(dropReducer(state, { type: 'enter' })).toEqual(state)
    expect(dropReducer(state, { type: 'leave' })).toEqual(state)
    state = dropReducer(state, { type: 'progress', fraction: 0.5 })
    expect(state.progress).toBe(0.5)
    expect(dropReducer(state, { type: 'progress', fraction: 9 }).progress).toBe(1)
    expect(dropReducer(INITIAL_DROP_STATE, { type: 'progress', fraction: 0.5 })).toEqual(INITIAL_DROP_STATE)
    expect(dropReducer(state, { type: 'done' })).toEqual({ phase: 'idle', progress: 1, error: null })
    expect(dropReducer(state, { type: 'fail', message: 'nope' })).toEqual({
      phase: 'idle',
      progress: 0,
      error: 'nope',
    })
  })

  it('describes what the zone is doing', () => {
    expect(dropStatusText(INITIAL_DROP_STATE)).toBe('')
    expect(dropStatusText({ phase: 'over', progress: 0, error: null })).toBe('drop to import')
    expect(dropStatusText({ phase: 'busy', progress: 0.42, error: null })).toBe('importing… 42%')
  })

  it('accepts a canvas export and names the problem with anything else', () => {
    expect(validateCanvasFilename('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip', 42)).toBeNull()
    expect(validateCanvasFilename('ref-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip', 42)).toBeNull()
    expect(validateCanvasFilename('notes.pdf', 42)).toBe('that is not a zip file')
    expect(validateCanvasFilename('holiday-photos.zip', 42)).toBe('that zip is not a review canvas export')
  })

  it('names the pull request a canvas was exported for when it is not the one on screen', () => {
    const name = 'pr-99-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'
    expect(validateCanvasFilename(name, 42)).toBe('that canvas was exported for PR #99, not #42')
    expect(validateCanvasFilename(name, 99)).toBeNull()
    // A canvas made before the PR existed names none, so it joins whichever PR imports it.
    expect(validateCanvasFilename('ref-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip', 42)).toBeNull()
  })
})

describe('drop zone', () => {
  /** @param {string} html */
  function mount(html) {
    document.body.innerHTML = `<div id="root">${html}</div>`
    const root = document.getElementById('root')
    if (!root) {
      throw new Error('no root')
    }
    return root
  }

  /** @param {string} name */
  function zipFile(name) {
    return new File([new Uint8Array([1, 2, 3])], name)
  }

  it('uploads a dropped canvas, shows progress, and reports the result', async () => {
    const root = mount(renderEmptyState(bundle()))
    /** @type {Array<[number, string]>} */
    const sent = []
    const zone = wireDropZone(root, {
      prNumber: 42,
      importImpl: async (prNumber, file, opts) => {
        sent.push([prNumber, file.name])
        opts?.onProgress?.(0.5)
        return { status: 'ready', headSha: HEAD, currentHeadSha: HEAD, derivable: true, warnings: [] }
      },
      onImported: result => sent.push([0, result.status]),
    })
    expect(zone).not.toBeNull()
    await zone?.send(zipFile('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'))
    expect(sent).toEqual([
      [42, 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'],
      [0, 'ready'],
    ])
    expect(zone?.state()).toEqual({ phase: 'idle', progress: 1, error: null })
    expect(document.querySelector('.cmd-err')).toBeNull()
  })

  it('shows the server error next to the zone and stays usable', async () => {
    const root = mount(renderEmptyState(bundle()))
    const zone = wireDropZone(root, {
      prNumber: 42,
      importImpl: () =>
        Promise.reject(new ApiError({ code: 'CANVAS_INVALID', message: 'not a canvas' }, 400)),
      onImported: () => undefined,
    })
    await zone?.send(zipFile('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'))
    expect(document.querySelector('.cmd-err')?.textContent).toBe('not a canvas')
    expect(zone?.state().error).toBe('not a canvas')
    const thrown = wireDropZone(mount(renderEmptyState(bundle())), {
      prNumber: 42,
      // Something that is not an Error still has to reach the reader as text.
      importImpl: () => Promise.reject('boom'),
      onImported: () => undefined,
    })
    await thrown?.send(zipFile('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'))
    expect(document.querySelector('.cmd-err')?.textContent).toBe('boom')
  })

  it('refuses a file whose name is not a canvas export before uploading', async () => {
    const root = mount(renderEmptyState(bundle()))
    let called = 0
    const zone = wireDropZone(root, {
      prNumber: 42,
      importImpl: async () => {
        called++
        return { status: 'ready', headSha: HEAD, currentHeadSha: HEAD, derivable: true, warnings: [] }
      },
      onImported: () => undefined,
    })
    await zone?.send(zipFile('notes.pdf'))
    expect(called).toBe(0)
    expect(document.querySelector('.cmd-err')?.textContent).toBe('that is not a zip file')
    await zone?.send(zipFile('pr-99-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'))
    expect(called).toBe(0)
    expect(document.querySelector('.cmd-err')?.textContent).toBe(
      'that canvas was exported for PR #99, not #42'
    )
  })

  it('marks the zone while a file is dragged over it and sends the dropped file', async () => {
    const root = mount(renderEmptyState(bundle()))
    /** @type {string[]} */
    const sent = []
    const zone = wireDropZone(root, {
      prNumber: 42,
      importImpl: async (_pr, file) => {
        sent.push(file.name)
        return { status: 'ready', headSha: HEAD, currentHeadSha: HEAD, derivable: true, warnings: [] }
      },
      onImported: () => undefined,
    })
    const label = zone?.element
    label?.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
    expect(label?.classList.contains('over')).toBe(true)
    label?.dispatchEvent(new Event('dragleave'))
    expect(label?.classList.contains('over')).toBe(false)
    const input = document.querySelector('#zip')
    if (input instanceof HTMLInputElement) {
      const file = zipFile('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
      Object.defineProperty(input, 'files', { value: [file], configurable: true })
      input.dispatchEvent(new Event('change'))
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(sent).toEqual(['pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'])
  })

  it('sends a file dropped on the zone and ignores a drop with no file', async () => {
    const root = mount(renderEmptyState(bundle()))
    /** @type {string[]} */
    const sent = []
    const zone = wireDropZone(root, {
      prNumber: 42,
      importImpl: async (_pr, file) => {
        sent.push(file.name)
        return { status: 'ready', headSha: HEAD, currentHeadSha: HEAD, derivable: true, warnings: [] }
      },
      onImported: () => undefined,
    })
    const file = zipFile('pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip')
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    zone?.element.dispatchEvent(drop)
    await Promise.resolve()
    await Promise.resolve()
    const empty = new DragEvent('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(empty, 'dataTransfer', { value: { files: [] } })
    zone?.element.dispatchEvent(empty)
    zone?.element.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    expect(sent).toEqual(['pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip'])
  })

  it('returns null on a screen without a drop zone', () => {
    const noop = async () => ({
      status: /** @type {const} */ ('ready'),
      headSha: HEAD,
      currentHeadSha: HEAD,
      derivable: true,
      warnings: [],
    })
    expect(
      wireDropZone(mount('<p>nothing</p>'), { prNumber: 42, importImpl: noop, onImported: () => undefined })
    ).toBeNull()
  })
})

describe('merges bar', () => {
  it('says the canvas still applies and which commits it spans', () => {
    document.body.innerHTML = mergesBarHtml({ canvasHeadSha: OLD, currentHeadSha: HEAD, commitsBehind: 1 })
    const bar = document.querySelector('.stale-bar.merges-bar')
    expect(bar?.getAttribute('role')).toBe('status')
    expect(bar?.textContent).toContain('Canvas still applies.')
    expect(bar?.textContent).toContain(
      'generated for eeeeeee; the head aaaaaaa only merged the base branch in since (1 commit, no conflicts)'
    )
    expect(bar?.querySelector('#stale-generate')?.textContent).toBe('regenerate anyway')
    expect(mergesBarHtml({ canvasHeadSha: OLD, currentHeadSha: HEAD, commitsBehind: 4 })).toContain(
      '(4 commits,'
    )
  })
})

describe('stale screen', () => {
  it('says how far behind the canvas is, in both relations', () => {
    expect(
      staleSummary({ canvasHeadSha: OLD, currentHeadSha: HEAD, relation: 'ancestor', commitsBehind: 1 })
    ).toBe('The canvas is for eeeeeee, 1 commit behind the head aaaaaaa.')
    expect(
      staleSummary({ canvasHeadSha: OLD, currentHeadSha: HEAD, relation: 'ancestor', commitsBehind: 4 })
    ).toBe('The canvas is for eeeeeee, 4 commits behind the head aaaaaaa.')
    expect(staleSummary({ canvasHeadSha: OLD, currentHeadSha: HEAD, relation: 'ancestor' })).toContain(
      '0 commits'
    )
    expect(staleSummary({ canvasHeadSha: OLD, currentHeadSha: HEAD, relation: 'unrelated' })).toBe(
      'The canvas is for eeeeeee, which is not in this branch any more; the head is aaaaaaa.'
    )
  })

  it('offers both ways forward, the skill command, and the drop zone', () => {
    document.body.innerHTML = renderStaleState(
      bundle({
        status: 'stale',
        artifact: syntheticArtifact(),
        stale: { canvasHeadSha: OLD, currentHeadSha: HEAD, relation: 'ancestor', commitsBehind: 2 },
      })
    )
    expect(document.querySelector('#es-h')?.textContent).toBe('Canvas is outdated')
    expect(document.querySelector('#view-stale')?.textContent).toBe('view stale canvas')
    expect(document.querySelector('#stale-generate')?.textContent).toBe('generate for current head')
    expect(document.querySelector('.hint')?.textContent).toContain('2 commits behind')
    expect(document.querySelector('.drop')).not.toBeNull()
    expect(document.querySelector('.cmdbox code')?.textContent).toBe('/pr-review-canvas 42')
  })

  it('renders the persistent bar with its own generate command', () => {
    document.body.innerHTML = staleBarHtml({
      canvasHeadSha: OLD,
      currentHeadSha: HEAD,
      relation: 'unrelated',
    })
    const bar = document.querySelector('.stale-bar')
    expect(bar?.getAttribute('role')).toBe('status')
    expect(bar?.querySelector('strong')?.textContent).toBe('Canvas is outdated.')
    expect(bar?.textContent).toContain('older commit')
    expect(bar?.querySelector('#stale-generate')).not.toBeNull()
  })

  it('says a canvas of another pull request cannot be used, without offering to drop it', () => {
    const shared = {
      url: 'https://github.com/user-attachments/files/9/pr-99-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      name: 'pr-99-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      matchesHead: true,
      downloadable: false,
      reason: /** @type {const} */ ('pr-mismatch'),
    }
    document.body.innerHTML = sharedCanvasCalloutHtml(bundle({ sharedCanvas: shared }))
    const callout = document.querySelector('.callout.warn')
    expect(callout?.textContent).toContain('exported for another pull request')
    expect(callout?.querySelector('a')).toBeNull()
    expect(document.querySelector('#fetch-shared')).not.toBeNull()
    document.body.innerHTML = sharedCanvasCalloutHtml(
      bundle({ sharedCanvas: { ...shared, reason: 'name-mismatch' } })
    )
    expect(document.querySelector('.callout.warn')?.textContent).toContain('exported from another repository')
  })

  it('offers to fetch the shared canvas again when the download failed', () => {
    const shared = {
      url: 'https://github.com/user-attachments/files/1/pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      name: 'pr-42-20260910T110000Z-aaaaaaaa-acme-widgets-canvas.zip',
      matchesHead: true,
      downloadable: false,
      reason: /** @type {const} */ ('auth-required'),
    }
    document.body.innerHTML = sharedCanvasCalloutHtml(bundle({ sharedCanvas: shared }))
    expect(document.querySelector('#fetch-shared')?.textContent).toBe('fetch again')
    expect(document.querySelector('.callout a')?.getAttribute('href')).toBe(shared.url)
  })
})

/**
 * A minimal XMLHttpRequest stand-in: it records the call and answers on demand. The assertion at
 * each call site is the browser-API boundary: XMLHttpRequest cannot be implemented in part, and
 * uploadForm needs a real one in the browser.
 * @param {number} status
 * @param {string} responseText
 */
function fakeXhr(status, responseText) {
  /** @type {{ onprogress: ((e: { lengthComputable: boolean, loaded: number, total: number }) => void) | null }} */
  const upload = { onprogress: null }
  const xhr = {
    status,
    statusText: 'Bad Request',
    responseText,
    /** @type {Record<string, string>} */
    headers: {},
    /** @type {FormData | null} */
    sent: null,
    method: '',
    url: '',
    upload,
    /** @type {(() => void) | null} */
    onload: null,
    /** @type {(() => void) | null} */
    onerror: null,
    /**
     * @param {string} method
     * @param {string} url
     */
    open(method, url) {
      xhr.method = method
      xhr.url = url
    },
    /**
     * @param {string} name
     * @param {string} value
     */
    setRequestHeader(name, value) {
      xhr.headers[name] = value
    },
    /** @param {FormData} body */
    send(body) {
      xhr.sent = body
      xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 })
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 })
      xhr.onload?.()
    },
  }
  return xhr
}

describe('upload and download', () => {
  it('posts the file with its progress and resolves with the server JSON', async () => {
    const xhr = fakeXhr(200, JSON.stringify({ status: 'ready' }))
    /** @type {number[]} */
    const progress = []
    const result = await importCanvas(42, new File([new Uint8Array([1])], 'c.zip'), {
      force: true,
      onProgress: f => progress.push(f),
      xhrImpl: () => /** @type {XMLHttpRequest} */ (/** @type {unknown} */ (xhr)),
    })
    expect(result).toEqual({ status: 'ready' })
    expect([xhr.method, xhr.url]).toEqual(['POST', '/api/prs/42/import'])
    expect(xhr.sent?.get('force')).toBe('1')
    expect(progress).toEqual([0.5])
  })

  it('turns the error envelope, a body that is not JSON, and a transport failure into ApiError', async () => {
    const enveloped = fakeXhr(400, JSON.stringify({ error: { code: 'CANVAS_INVALID', message: 'nope' } }))
    await expect(
      uploadForm('/api/prs/42/import', new FormData(), { xhrImpl: () => /** @type {never} */ (enveloped) })
    ).rejects.toMatchObject({ code: 'CANVAS_INVALID', status: 400 })
    const plain = fakeXhr(413, 'too big')
    await expect(
      uploadForm('/api/prs/42/import', new FormData(), { xhrImpl: () => /** @type {never} */ (plain) })
    ).rejects.toMatchObject({ code: 'INTERNAL', status: 413 })
    const broken = fakeXhr(0, '')
    broken.send = () => {
      broken.onerror?.()
    }
    await expect(
      uploadForm('/api/prs/42/import', new FormData(), { xhrImpl: () => /** @type {never} */ (broken) })
    ).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('asks the server to look for the attachment again', async () => {
    /** @type {string[]} */
    const urls = []
    const fetchImpl = async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
      urls.push(`${init.method} ${url}`)
      return new Response(
        JSON.stringify({ imported: false, status: 'missing', sharedCanvas: null, warnings: [] })
      )
    }
    const body = await fetchSharedCanvas(42, { fetchImpl: /** @type {never} */ (fetchImpl) })
    expect(body.status).toBe('missing')
    expect(urls).toEqual(['POST /api/prs/42/shared-canvas/fetch'])
  })

  it('reads the file name from the response, with a fallback', () => {
    expect(filenameFromDisposition('attachment; filename="a.zip"')).toBe('a.zip')
    expect(filenameFromDisposition(null)).toBe('pr-review-canvas.zip')
    expect(filenameFromDisposition('attachment')).toBe('pr-review-canvas.zip')
  })

  it('fetches the zip and hands it to the browser', async () => {
    document.body.innerHTML = ''
    /** @type {string[]} */
    const clicked = []
    // A real anchor in a real page: the listener records what the browser was asked to save.
    document.addEventListener('click', event => {
      const link = event.target
      if (link instanceof HTMLAnchorElement) {
        clicked.push(link.download)
      }
    })
    const urls = { createObjectURL: () => 'blob:1', revokeObjectURL: () => undefined }
    /** @type {typeof fetch} */
    const fetchImpl = async () =>
      new Response(new Uint8Array([1, 2]).buffer, {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="canvas.zip"' },
      })
    const name = await exportCanvasZip(42, { headSha: HEAD, fetchImpl, doc: document, urls })
    expect(name).toBe('canvas.zip')
    expect(clicked).toEqual(['canvas.zip'])
    expect(document.querySelector('a')).toBeNull()
  })

  it('reports the envelope of a failed export', async () => {
    /** @type {typeof fetch} */
    const fetchImpl = async () =>
      new Response(JSON.stringify({ error: { code: 'CANVAS_NOT_FOUND', message: 'no canvas' } }), {
        status: 404,
      })
    await expect(fetchCanvasZip(42, { fetchImpl })).rejects.toMatchObject({ code: 'CANVAS_NOT_FOUND' })
    /** @type {typeof fetch} */
    const plain = async () => new Response('boom', { status: 500 })
    await expect(fetchCanvasZip(42, { fetchImpl: plain })).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('saves a blob through the page it is given by default', async () => {
    document.body.innerHTML = ''
    saveBlob(new Blob(['x']), 'a.zip')
    expect(document.querySelector('a')).toBeNull()
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(new Uint8Array([1]), {
        headers: { 'content-disposition': 'attachment; filename="b.zip"' },
      })
    try {
      expect(await exportCanvasZip(42)).toBe('b.zip')
    } finally {
      globalThis.fetch = original
    }
  })

  it('posts without a progress listener when the caller wants none', async () => {
    const xhr = fakeXhr(200, JSON.stringify({ ok: true }))
    const result = await uploadForm('/api/prs/42/import', new FormData(), {
      xhrImpl: () => /** @type {never} */ (xhr),
    })
    expect(result).toEqual({ ok: true })
  })
})

it('uses the browser upload transport without forcing a cross-repository import', async () => {
  const xhr = fakeXhr(200, JSON.stringify({ status: 'ready' }))
  vi.stubGlobal('XMLHttpRequest', function () {
    return xhr
  })
  try {
    expect(await importCanvas(42, new File(['zip'], 'canvas.zip'))).toEqual({ status: 'ready' })
    expect(xhr.sent?.get('force')).toBeNull()
    expect(xhr.url).toBe('/api/prs/42/import')
  } finally {
    vi.unstubAllGlobals()
  }
})
