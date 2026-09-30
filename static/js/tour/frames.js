// @ts-check
// A landmark's scene or micro-world is drawn in a sandboxed frame this server serves. The frame's
// runtime tells the page how tall the scene is, and the page tells the frame the theme it wears.

/**
 * The URL of a scene frame. `headSha` names the tour on the page; a preview reads the model
 * instead. The skin and the theme ride along, so the frame is painted like the page.
 * @param {{ key: string, landmark: string, kind: 'scene' | 'micro', headSha: string, preview: boolean, skin: string, theme: string }} opts
 */
export function frameUrl(opts) {
  const params = new URLSearchParams({ skin: opts.skin, theme: opts.theme })
  if (opts.preview) {
    params.set('preview', '1')
  } else {
    params.set('headSha', opts.headSha)
  }
  return `/tour-scene/${encodeURIComponent(opts.key)}/${encodeURIComponent(opts.landmark)}/${opts.kind}?${params}`
}

/**
 * Puts a frame in every host the screen drew, sized by the runtime's messages.
 * @param {ParentNode} root
 * @param {Omit<Parameters<typeof frameUrl>[0], 'landmark' | 'kind'>} opts
 */
export function mountFrames(root, opts) {
  for (const host of root.querySelectorAll('.tour-frame-host')) {
    if (!(host instanceof HTMLElement) || host.querySelector('iframe') !== null) {
      continue
    }
    const landmark = host.dataset['landmark'] ?? ''
    const kind = host.dataset['kind'] === 'micro' ? 'micro' : 'scene'
    const frame = document.createElement('iframe')
    frame.className = 'tour-frame'
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', kind === 'micro' ? 'micro-world' : 'scene')
    frame.setAttribute('loading', 'eager')
    frame.src = frameUrl({ ...opts, landmark, kind })
    host.append(frame)
  }
}

/**
 * Listens for the frames' messages: a height sizes the frame that sent it, an error is shown
 * under it in preview and logged otherwise. Returns a way to stop listening.
 * @param {ParentNode} root
 * @param {{ preview: boolean }} opts
 */
export function listenToFrames(root, opts) {
  /** @param {MessageEvent} event */
  const onMessage = event => {
    const data = /** @type {{ scene?: unknown, height?: unknown, message?: unknown } | null} */ (event.data)
    if (data === null || typeof data !== 'object') {
      return
    }
    const frame = [...root.querySelectorAll('iframe.tour-frame')].find(
      f => f instanceof HTMLIFrameElement && f.contentWindow === event.source
    )
    if (!(frame instanceof HTMLIFrameElement)) {
      return
    }
    if (data.scene === 'size' && typeof data.height === 'number' && Number.isFinite(data.height)) {
      frame.style.height = `${Math.max(24, Math.min(4000, Math.ceil(data.height)))}px`
      frame.dataset['sized'] = 'true'
    } else if (data.scene === 'error' && typeof data.message === 'string') {
      frame.dataset['error'] = 'true'
      if (opts.preview) {
        const note = document.createElement('p')
        note.className = 'tour-frame-error'
        note.textContent = `scene error: ${data.message.slice(0, 200)}`
        frame.after(note)
      }
    }
  }
  window.addEventListener('message', onMessage)
  return { stop: () => window.removeEventListener('message', onMessage) }
}

/**
 * Tells every frame the theme the page now wears.
 * @param {ParentNode} root
 * @param {string} theme
 */
export function tellFramesTheme(root, theme) {
  for (const frame of root.querySelectorAll('iframe.tour-frame')) {
    if (frame instanceof HTMLIFrameElement) {
      frame.contentWindow?.postMessage({ scene: 'theme', theme }, '*')
    }
  }
}
