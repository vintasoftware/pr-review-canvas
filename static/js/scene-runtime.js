// @ts-check
// The runtime of a scene frame. The server inlines it ahead of the scene, so it runs before the
// scene's own markup and scripts. It tells the tour page how tall the scene is, gives the scene's
// scripts `window.scene`, and reports what its scripts throw. The frame has no origin and no
// network: it hears only its tour page, and tells it only its height and its errors.
;(() => {
  const root = document.documentElement
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  /**
   * A kit color as the scene draws it now, such as `rgb(31, 136, 61)`: the tokens are CSS, and a
   * canvas or a script needs the value the skin and the theme resolve them to.
   * @param {string} name `ink`, `good`, `bad`, `warn`, `muted`, `fg`, `paper`, `line`, or `tint`
   */
  function color(name) {
    const probe = document.createElement('span')
    probe.style.color = `var(--${name.replace(/[^\w-]/g, '')})`
    probe.hidden = true
    ;(document.body ?? root).append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }

  Object.defineProperty(window, 'scene', {
    value: Object.freeze({
      /** True when the reader asked for less motion: draw the end state and stop. */
      reducedMotion,
      color,
    }),
  })

  /** @param {number} height */
  function tell(height) {
    window.parent.postMessage({ scene: 'size', height }, '*')
  }

  // A script that throws leaves what the markup shows; the tour's preview says so.
  /** @param {unknown} reason */
  const told = reason =>
    window.parent.postMessage({ scene: 'error', message: String(reason).slice(0, 200) }, '*')
  window.addEventListener('error', event => told(event.message))
  window.addEventListener('unhandledrejection', event => told(event.reason))

  /** The frame is as wide as the stage and as tall as the scene: the page sizes it from this. */
  function fit() {
    const main = /** @type {HTMLElement | null} */ (document.querySelector('.scene-root'))
    if (main === null) return
    tell(Math.ceil(main.getBoundingClientRect().height))
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return
    const data = /** @type {{ scene?: unknown, theme?: unknown } | null} */ (event.data)
    if (
      data?.scene === 'theme' &&
      (data.theme === 'light' || data.theme === 'dark' || data.theme === 'auto')
    ) {
      root.dataset['theme'] = data.theme
    }
  })

  // Text wraps with the frame's width and scripts may build the scene after it loads: fit on load
  // and whenever the scene changes size. Fitting can change the frame, so it waits for the next
  // frame instead of running inside the observer.
  let queued = false
  const refit = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      fit()
    })
  }
  window.addEventListener('load', () => {
    // The kit's CSS stops CSS motion for reduced motion; SVG's own animations it cannot, so they
    // jump to their end and hold there.
    if (reducedMotion) {
      for (const svg of document.querySelectorAll('svg')) {
        svg.setCurrentTime(3600)
        svg.pauseAnimations()
      }
    }
    fit()
    const main = document.querySelector('.scene-root')
    if (main === null || typeof ResizeObserver !== 'function') return
    new ResizeObserver(refit).observe(main)
  })
})()
