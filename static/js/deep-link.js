// @ts-check
// Canvas links as navigation. The markdown, the diagrams and the chat all write links in the
// canvas scheme (#layer:, #file:, #chunk:, #line:), and the same string works as a URL fragment,
// so `…/review/278#line:path/to/file.ts:40` opens the page on that line and a click on a link
// leaves a URL the reader can share. The jump itself is `jumpTo` in anchors.js; this module
// decides when it runs.
import { cssEscape, drawCardOf, jumpTo, keyFromPath, nearestRow } from './anchors.js'
import { flash, scrollIntoViewSafe } from './dom.js'
import { fileAnchorId, layerAnchorId } from './keys.js'
import { parseLink } from './links.js'
import { markRailCurrent } from './scroll-spy.js'

/**
 * The fragment with its percent escapes resolved, for a browser that hands back an encoded hash.
 * A path holds `/`, `:` and `-`, which the parser reads raw, and a malformed escape is left as
 * written rather than throwing.
 * @param {string} hash
 * @returns {string}
 */
export function decodeHash(hash) {
  try {
    return decodeURIComponent(hash)
  } catch {
    return hash
  }
}

/**
 * Follows one canvas link: scrolls to its target and highlights it. A line whose row is folded
 * as noise or missing lands on the nearest row instead, marked `is-approx` the way the point and
 * thread rows are. Returns false when the link does not parse or has no target on the page.
 *
 * The string is tried as written first, so a path that holds a literal `%` keeps it, and then
 * with its escapes resolved, which is how the same link comes back out of the URL bar.
 * @param {string} href
 * @param {ParentNode} [root]
 * @returns {boolean}
 */
export function followLink(href, root = document) {
  if (jumpToTarget(href, root)) {
    return true
  }
  const decoded = decodeHash(href)
  return decoded !== href && jumpToTarget(decoded, root)
}

/**
 * @param {string} target
 * @param {ParentNode} root
 * @returns {boolean}
 */
function jumpToTarget(target, root) {
  const link = parseLink(target)
  if (link === null) {
    return false
  }
  if (link.kind === 'line') {
    return jumpToLine(root, link)
  }
  if (!jumpTo(target, root)) {
    return false
  }
  if (link.kind === 'layer') {
    markRailCurrent(root, layerAnchorId(link.layerKey))
  }
  return true
}

/**
 * The row of a line link, or the closest one when that line is folded away as noise or is not
 * among the rows on screen.
 * @param {ParentNode} root
 * @param {{ path: string, start: number, side: 'new' | 'old' }} link
 * @returns {boolean}
 */
function jumpToLine(root, link) {
  const key = keyFromPath(link.path)
  drawCardOf(root, link.path)
  const card = root.querySelector(`#${cssEscape(fileAnchorId(key))}`)
  const near = nearestRow(card ?? root, key, link.side, link.start)
  if (near === null) {
    return false
  }
  const body = near.row.closest('.file')?.querySelector('.file-body')
  if (body instanceof HTMLElement && body.hidden) {
    body.hidden = false
  }
  if (near.approx) {
    near.row.classList.add('is-approx')
  }
  scrollIntoViewSafe(near.row)
  flash(near.row)
  return true
}

/**
 * A plain left click the page is free to take over. A modified click is the reader asking the
 * browser for a new tab or window.
 * @param {MouseEvent} event
 */
function plainClick(event) {
  return (
    !event.defaultPrevented &&
    (event.button === undefined || event.button === 0) &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/**
 * Wires canvas links for one screen: clicks on the anchors the renderers wrote, the fragment the
 * page was opened with, and every later `hashchange`. `stop` removes all of it, so a re-render
 * never leaves two sets of listeners behind.
 * @param {HTMLElement | Document} root
 * @param {{ view?: Window, jumpOnInit?: boolean }} [opts]
 * @returns {{ stop: () => void, follow: (href: string) => boolean, followHash: () => boolean }}
 */
export function initDeepLinks(root, opts = {}) {
  const view = opts.view ?? window
  const listeners = new AbortController()

  const followHash = () => followLink(view.location.hash, root)

  root.addEventListener(
    'click',
    event => {
      const mouse = /** @type {MouseEvent} */ (event)
      const el = event.target instanceof Element ? event.target.closest('a[data-link], a[href^="#"]') : null
      if (el === null || !plainClick(mouse)) {
        return
      }
      const href = el.getAttribute('data-link') ?? el.getAttribute('href') ?? ''
      if (parseLink(href) === null) {
        return
      }
      event.preventDefault()
      followLink(href, root)
      // The URL stays shareable, and no second jump follows: replaceState fires no hashchange.
      try {
        view.history.replaceState(null, '', href)
      } catch {
        // A view without session history keeps the URL it had; the jump already happened.
      }
    },
    { signal: listeners.signal }
  )

  view.addEventListener('hashchange', () => void followHash(), { signal: listeners.signal })
  if (opts.jumpOnInit !== false) {
    followHash()
  }

  return {
    stop: () => listeners.abort(),
    follow: href => followLink(href, root),
    followHash,
  }
}
