// @ts-check
// @vitest-environment-options { "settings": { "disableIframePageLoading": true } }
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { frameUrl, listenToFrames, mountFrames, tellFramesTheme } from './frames.js'

const OPTS = {
  key: '42',
  headSha: 'a'.repeat(40),
  preview: false,
  skin: 'github',
  theme: 'dark',
}

/**
 * A frame's window, as the page sees it: what the runtime posts from and what the page posts to.
 * @param {HTMLIFrameElement} frame
 */
function fakeWindow(frame) {
  const win = { postMessage: vi.fn() }
  Object.defineProperty(frame, 'contentWindow', { value: win, configurable: true })
  return win
}

/**
 * @param {unknown} data
 * @param {unknown} source
 */
function message(data, source) {
  const event = new MessageEvent('message', { data })
  Object.defineProperty(event, 'source', { value: source })
  window.dispatchEvent(event)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('frameUrl', () => {
  it('names the tour by its commit, or the preview, with the look the page wears', () => {
    expect(frameUrl({ ...OPTS, landmark: 'world', kind: 'scene' })).toBe(
      `/tour-scene/42/world/scene?skin=github&theme=dark&headSha=${'a'.repeat(40)}`
    )
    expect(frameUrl({ ...OPTS, preview: true, key: 'branch', landmark: 'l 1', kind: 'micro' })).toBe(
      '/tour-scene/branch/l%201/micro?skin=github&theme=dark&preview=1'
    )
  })
})

describe('mountFrames', () => {
  it('puts a sandboxed frame in every host once', () => {
    document.body.innerHTML =
      '<div class="tour-frame-host" data-landmark="world" data-kind="scene"></div>' +
      '<div class="tour-frame-host" data-landmark="world" data-kind="micro"></div>'
    mountFrames(document.body, OPTS)
    mountFrames(document.body, OPTS)
    const frames = document.querySelectorAll('iframe.tour-frame')
    expect(frames).toHaveLength(2)
    expect(frames[0]?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frames[0]?.getAttribute('title')).toBe('scene')
    expect(frames[1]?.getAttribute('title')).toBe('micro-world')
    expect(frames[1]?.getAttribute('src')).toContain('/tour-scene/42/world/micro?')
    document.body.innerHTML = '<div class="tour-frame-host"></div>'
    mountFrames(document.body, OPTS)
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('/tour-scene/42//scene?')
  })
})

describe('listenToFrames', () => {
  it('sizes the frame that spoke, within reason, and ignores anyone else', () => {
    document.body.innerHTML = '<iframe class="tour-frame"></iframe><iframe class="tour-frame"></iframe>'
    const [first, second] = document.querySelectorAll('iframe')
    if (!(first instanceof HTMLIFrameElement && second instanceof HTMLIFrameElement)) {
      throw new Error('no frames')
    }
    const win = fakeWindow(first)
    fakeWindow(second)
    const listener = listenToFrames(document.body, { preview: false })
    message({ scene: 'size', height: 321.2 }, win)
    expect(first.style.height).toBe('322px')
    expect(first.dataset['sized']).toBe('true')
    expect(second.style.height).toBe('')
    message({ scene: 'size', height: 99999 }, win)
    expect(first.style.height).toBe('4000px')
    message({ scene: 'size', height: -5 }, win)
    expect(first.style.height).toBe('24px')
    message({ scene: 'size', height: 'tall' }, win)
    message({ scene: 'size', height: 100 }, { postMessage: () => undefined })
    message('junk', win)
    message(null, win)
    expect(first.style.height).toBe('24px')
    listener.stop()
    message({ scene: 'size', height: 500 }, win)
    expect(first.style.height).toBe('24px')
  })

  it('shows a scene error in preview and only marks it otherwise', () => {
    document.body.innerHTML = '<iframe class="tour-frame"></iframe>'
    const frame = document.querySelector('iframe')
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error('no frame')
    }
    const win = fakeWindow(frame)
    const quiet = listenToFrames(document.body, { preview: false })
    message({ scene: 'error', message: 'boom' }, win)
    expect(frame.dataset['error']).toBe('true')
    expect(document.querySelector('.tour-frame-error')).toBeNull()
    quiet.stop()
    const loud = listenToFrames(document.body, { preview: true })
    message({ scene: 'error', message: 'x'.repeat(300) }, win)
    expect(document.querySelector('.tour-frame-error')?.textContent).toBe(`scene error: ${'x'.repeat(200)}`)
    loud.stop()
  })
})

describe('tellFramesTheme', () => {
  it('posts the theme to every frame', () => {
    document.body.innerHTML = '<iframe class="tour-frame"></iframe><iframe></iframe>'
    const frame = document.querySelector('iframe.tour-frame')
    if (!(frame instanceof HTMLIFrameElement)) {
      throw new Error('no frame')
    }
    const win = fakeWindow(frame)
    const empty = document.createElement('iframe')
    empty.className = 'tour-frame'
    Object.defineProperty(empty, 'contentWindow', { value: null })
    document.body.append(empty)
    tellFramesTheme(document.body, 'dark')
    expect(win.postMessage).toHaveBeenCalledWith({ scene: 'theme', theme: 'dark' }, '*')
  })
})
