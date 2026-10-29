// @ts-check
// The board. With `layerView: board` the review is a tree on a plane the reader pans and zooms:
// the pull request at the root, its layers in a row under it, and under an open layer its
// attention points. Every node starts closed, as a title; a click opens it in place, and the tree
// makes room. A file has no node: it opens in a side panel. A drag moves a node and what hangs
// from it, and the board keeps where the reader put it. The nodes hold the page's own elements
// (the overview, the layer sections, the point cards), moved onto the plane, so every command on
// them works as in the other views; leaving the board puts each one back where the render put it.
// The plane is a scroll container, so a scroll into view lands on a node, and the zoom is CSS
// `zoom`, so text is laid out again at each zoom and stays sharp. With `all` and `one` this module
// does nothing.
import { toast } from './commands.js'
import { followLink } from './deep-link.js'
import { dotColor, setCardCollapsed } from './layers.js'

/** @typedef {import('./layer-views.js').LayerView} LayerView */
/** @typedef {'root' | 'layer' | 'point'} NodeKind */
/**
 * A node of the tree as the layout reads it: its size at zoom 1, and its children.
 * @typedef {{ id: string, w: number, h: number, children: TreeNode[] }} TreeNode
 */
/** @typedef {{ x: number, y: number, w: number, h: number }} Box */
/** @typedef {{ dx: number, dy: number }} Offset */
/**
 * A node on the page.
 * @typedef {{ id: string, kind: NodeKind, el: HTMLElement, children: PageNode[] }} PageNode
 */
/**
 * The parts of a board on the page, and what to put back when it goes.
 * @typedef {{ main: HTMLElement, layout: HTMLElement, viewport: HTMLElement, plane: HTMLElement, lines: SVGSVGElement, tools: HTMLElement, panel: HTMLElement, shown: [Comment, Element] | null, focus: HTMLElement | null, move: number, untouched: boolean, watcher: MutationObserver | null, tree: PageNode, nodes: Map<Element, PageNode>, frames: Element[], added: Element[], renamed: Array<[Element, string]>, moved: Array<[Comment, Element]>, collapsed: Array<[Element, boolean]>, origin: { x: number, y: number }, pad: { x: number, y: number }, size: { w: number, h: number }, listeners: AbortController, observer: ResizeObserver | null }} Mounted
 */

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 2
/** Below this zoom a click on a node zooms in to it: the reader cannot read it at that size. */
export const FAR_ZOOM = 0.5
/** How long the board waits, once the reader acts on the point in focus, before the next one. */
export const ADVANCE_MS = 500
/** How long the board takes to move to what the reader opened, in milliseconds. */
export const MOVE_MS = 300
/** The zoom an opened point is brought to, a little closer than the rest of the board. */
export const POINT_ZOOM = 1.15
/** The room left around an opened layer brought into view, in screen pixels. */
const FOCUS_MARGIN = 32
/** How much one press of a zoom button changes the zoom. */
export const ZOOM_STEP = 1.25
/** The spacing of the tree, in plane pixels. */
export const TREE = /** @type {const} */ ({ rootGap: 72, columnGap: 40, leafGap: 10, indent: 28 })
/**
 * The least room around the tree, so the reader can pan past its edges. The room is at least a
 * window too, so the tree can sit in the middle of the window at any zoom.
 */
const PAD = 480
/** The room left above and left of what the board zooms to, in screen pixels. */
const FRAME_MARGIN = 24
/** How far a pointer moves before a press on a node becomes a drag. */
const DRAG_START = 4
/** Where a press starts a drag: a node's title bar, outside its controls. */
const HANDLE_SELECTOR = '.b-root .hdr-title, .layer-h, pr-layer summary, .f-title'
const CONTROL_SELECTOR = 'a, button, input, select, textarea, label, .chk'
const STORAGE_PREFIX = 'pr-review.board:'
/** The classes of each kind of node, written out whole so the CSS check finds them. */
const NODE_CLASSES = /** @type {const} */ ({
  root: 'bnode b-root',
  layer: 'bnode b-layer',
  point: 'bnode b-point',
})
const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * @param {number} zoom
 * @returns {number}
 */
export function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The zoom a wheel turn leads to. A pinch on a trackpad arrives as a wheel with the control key.
 * @param {number} zoom
 * @param {WheelEvent} event
 * @returns {number}
 */
export function wheelZoom(zoom, event) {
  const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1
  return clampZoom(zoom * Math.exp(-event.deltaY * lines * 0.002))
}

/**
 * The zoom that fits a box of this size, at zoom 1, in the viewport, never above 1.
 * @param {{ width: number, height: number }} content
 * @param {{ width: number, height: number }} viewport
 * @param {number} [margin] the room to leave on each side, in screen pixels
 * @returns {number}
 */
export function fitZoom(content, viewport, margin = 32) {
  if (content.width <= 0 || content.height <= 0) {
    return 1
  }
  const across = (viewport.width - 2 * margin) / content.width
  const down = (viewport.height - 2 * margin) / content.height
  return clampZoom(Math.min(1, across, down))
}

/**
 * The text of the zoom readout.
 * @param {number} zoom
 */
export function zoomLabel(zoom) {
  return `${Math.round(zoom * 100)}%`
}

/** The zoom controls in the corner of the board. */
export function boardToolsHtml() {
  return (
    '<div class="board-tools" role="toolbar" aria-label="Board">' +
    '<button class="cmd" type="button" data-board="zoom-out" title="Zoom out" aria-label="Zoom out">&minus;</button>' +
    '<output class="board-zoom" aria-live="polite">100%</output>' +
    '<button class="cmd" type="button" data-board="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>' +
    '<button class="cmd" type="button" data-board="fit" title="Fit the tree in the window">fit</button>' +
    '<button class="cmd" type="button" data-board="tidy" title="Put every node back in its place">tidy</button>' +
    '</div>'
  )
}

/**
 * Where each node of the tree goes, at zoom 1. The root sits above a row of layers, centered on
 * it; each layer heads a column, and its points stack down the column, indented, so a layer with
 * many points grows down and not across. A node of no height (a point the page hides)
 * takes no room. An offset moves a node from its place, and what hangs from it with it.
 * @param {TreeNode} root
 * @param {ReadonlyMap<string, Offset>} [offsets]
 * @returns {Map<string, Box>}
 */
export function layoutTree(root, offsets = new Map()) {
  /** @param {string} id */
  const offset = id => offsets.get(id) ?? { dx: 0, dy: 0 }
  /** @type {Map<string, Box>} */
  const at = new Map()
  const columns = root.children
    .filter(layer => layer.h > 0)
    .map(layer => ({
      layer,
      width: Math.max(
        layer.w,
        ...layer.children.filter(leaf => leaf.h > 0).map(leaf => TREE.indent + leaf.w)
      ),
    }))
  const row =
    columns.reduce((sum, column) => sum + column.width, 0) + TREE.columnGap * Math.max(0, columns.length - 1)
  const ro = offset(root.id)
  at.set(root.id, { x: Math.max(0, (row - root.w) / 2) + ro.dx, y: ro.dy, w: root.w, h: root.h })
  let x = Math.max(0, (root.w - row) / 2)
  for (const { layer, width } of columns) {
    const lo = offset(layer.id)
    const lx = x + ro.dx + lo.dx
    const ly = root.h + TREE.rootGap + ro.dy + lo.dy
    at.set(layer.id, { x: lx, y: ly, w: layer.w, h: layer.h })
    let y = ly + layer.h + TREE.leafGap
    for (const leaf of layer.children) {
      if (leaf.h > 0) {
        const o = offset(leaf.id)
        at.set(leaf.id, { x: lx + TREE.indent + o.dx, y: y + o.dy, w: leaf.w, h: leaf.h })
        y += leaf.h + TREE.leafGap
      }
    }
    x += width + TREE.columnGap
  }
  return at
}

/**
 * The line from a node to one of its children: from the bottom of the root down to the top of a
 * layer, or from a layer's trunk at the left of its column across to a point.
 * @param {Box} parent
 * @param {Box} child
 * @param {boolean} fromRoot
 * @returns {string} an SVG path
 */
export function edgePath(parent, child, fromRoot) {
  const bottom = parent.y + parent.h
  if (fromRoot) {
    const px = parent.x + parent.w / 2
    const cx = child.x + child.w / 2
    const mid = (bottom + child.y) / 2
    return `M${px} ${bottom}V${mid}H${cx}V${child.y}`
  }
  const trunk = parent.x + TREE.indent / 2
  const y = child.y + Math.min(child.h / 2, 18)
  return `M${trunk} ${bottom}V${y}H${child.x}`
}

/**
 * The box around boxes, or null for none.
 * @param {Iterable<Box>} boxes
 * @returns {{ left: number, top: number, right: number, bottom: number } | null}
 */
export function boundsOf(boxes) {
  /** @type {{ left: number, top: number, right: number, bottom: number } | null} */
  let out = null
  for (const b of boxes) {
    out =
      out === null
        ? { left: b.x, top: b.y, right: b.x + b.w, bottom: b.y + b.h }
        : {
            left: Math.min(out.left, b.x),
            top: Math.min(out.top, b.y),
            right: Math.max(out.right, b.x + b.w),
            bottom: Math.max(out.bottom, b.y + b.h),
          }
  }
  return out
}

/**
 * The offsets the reader left on this page, or none when the browser keeps nothing.
 * @param {Storage | null} storage
 * @param {string} key
 * @returns {Map<string, Offset>}
 */
export function readOffsets(storage, key) {
  try {
    const raw = storage?.getItem(STORAGE_PREFIX + key)
    const parsed = raw ? JSON.parse(raw) : null
    /** @type {Map<string, Offset>} */
    const out = new Map()
    if (parsed !== null && typeof parsed === 'object') {
      for (const [id, o] of Object.entries(parsed)) {
        if (Number.isFinite(o?.dx) && Number.isFinite(o?.dy)) out.set(id, { dx: o.dx, dy: o.dy })
      }
    }
    return out
  } catch {
    return new Map()
  }
}

/**
 * @param {Storage | null} storage
 * @param {string} key
 * @param {ReadonlyMap<string, Offset>} offsets
 */
export function writeOffsets(storage, key, offsets) {
  try {
    if (offsets.size === 0) storage?.removeItem(STORAGE_PREFIX + key)
    else storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(Object.fromEntries(offsets)))
  } catch {
    // A browser that keeps nothing loses the layout on reload; the board still works.
  }
}

/**
 * Sends the pointer's next events to the board, so a drag goes on past the node it started on. A
 * pointer the browser no longer tracks cannot be captured, and the drag goes on without it.
 * @param {Element} el
 * @param {number} pointerId
 */
function capture(el, pointerId) {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    // Nothing to capture.
  }
}

/**
 * Whether a layer node shows its body: a layer section's, or the Other layer's details.
 * @param {Element} el
 */
function layerOpen(el) {
  return el.querySelector('.layer-body:not([hidden]), details[open]') !== null
}

/**
 * Opens a layer section, or the Other layer's details.
 * @param {Element} section
 */
function openLayer(section) {
  const details = section.querySelector(':scope > details')
  if (details instanceof HTMLDetailsElement) details.open = true
  else setCardCollapsed(section, false)
}

/** @returns {Storage | null} */
function browserStorage() {
  try {
    return localStorage
  } catch {
    return null
  }
}

/**
 * Puts the page's review on a tree while the view is `board`, and takes it off again for the other
 * views. Made once for the app element; `redraw` runs after every render, which puts the new
 * render on a new tree at the zoom and place the reader left.
 * @param {HTMLElement} root
 * @param {{ view: LayerView, win?: Window, storage?: Storage | null, smooth?: boolean, advanceMs?: number }} opts
 * @returns {{ stop: () => void, setView: (view: LayerView) => void, redraw: () => void, zoom: () => number, setZoom: (zoom: number) => void }}
 */
export function initBoard(root, opts) {
  const win = opts.win ?? window
  const doc = root.ownerDocument
  const storage = opts.storage === undefined ? browserStorage() : opts.storage
  // The board glides to what the reader opens, unless the reader asked for less motion.
  const smooth = opts.smooth ?? !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const storageKey = win.location.pathname
  let view = opts.view
  let zoom = 1
  let offsets = readOffsets(storage, storageKey)
  /**
   * Where the reader was, in plane pixels at zoom 1, kept across renders; null until the board
   * first shows, which fits it in the window.
   * @type {{ x: number, y: number } | null}
   */
  let place = null
  /** @type {Mounted | null} */
  let mounted = null
  /** The layers the board marked reviewed on this page, which it may clear again. */
  const marked = new Set()
  let frame = 0

  /** @param {Mounted} m */
  const remember = m => {
    place = { x: m.viewport.scrollLeft / zoom - m.origin.x, y: m.viewport.scrollTop / zoom - m.origin.y }
  }

  /**
   * @param {Mounted} m
   * @param {number} next
   */
  const paint = (m, next) => {
    zoom = clampZoom(next)
    m.plane.style.setProperty('zoom', String(zoom))
    m.main.classList.toggle('is-far', zoom < FAR_ZOOM)
    const readout = m.tools.querySelector('.board-zoom')
    if (readout !== null) readout.textContent = zoomLabel(zoom)
  }

  /**
   * The tree with each node's size now. A node the page hides measures nothing.
   * @param {PageNode} node
   * @returns {TreeNode}
   */
  const measure = node => ({
    id: node.id,
    w: node.el.offsetWidth,
    h: node.el.offsetHeight,
    children: node.children.map(measure),
  })

  /**
   * Places every node and draws the lines between them. The plane grows to the tree and the room
   * around it; when the tree's left or top edge moves, the scroll moves with it, so nothing on
   * screen jumps.
   * @param {Mounted} m
   */
  const arrange = m => {
    // A layer's points hang under it only while it is open; closed, it is its title. Its title bar
    // counts the points the reader has acted on, and the layer is done once none is open.
    for (const layer of m.tree.children) {
      const shut = !layerOpen(layer.el)
      for (const leaf of layer.children) leaf.el.hidden = shut
      const total = layer.children.length
      const done = layer.children.filter(
        leaf => (leaf.el.querySelector('[data-point]')?.getAttribute('data-status') ?? 'open') !== 'open'
      ).length
      const progress = layer.el.querySelector('.b-progress')
      if (progress !== null)
        progress.textContent = total === 0 ? 'no attention points' : `${done}/${total} points`
      const finished = total > 0 && done === total
      layer.el.classList.toggle('is-done', finished)
      layer.el.classList.toggle('no-points', total === 0)
      // A layer whose points are all done counts as reviewed, as its files would in the other
      // views: the board checks its reviewed box, and clears only a mark it set itself.
      // The box changes without a click, which would end the focus on the point the reader is on.
      const box = layer.el.querySelector('.layer-ctl input[data-reviewed-id]')
      const flip = (/** @type {HTMLInputElement} */ input) => {
        input.checked = !input.checked
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
      if (box instanceof HTMLInputElement && total > 0) {
        if (finished && !box.checked) {
          flip(box)
          marked.add(layer.id)
        } else if (!finished && box.checked && marked.delete(layer.id)) {
          flip(box)
        }
      }
    }
    const at = layoutTree(measure(m.tree), offsets)
    // The root always shows, so there is a box.
    const bounds = /** @type {NonNullable<ReturnType<typeof boundsOf>>} */ (boundsOf(at.values()))
    const pad = {
      x: Math.max(PAD, m.viewport.clientWidth / zoom),
      y: Math.max(PAD, m.viewport.clientHeight / zoom),
    }
    const origin = { x: pad.x - bounds.left, y: pad.y - bounds.top }
    m.viewport.scrollLeft += (origin.x - m.origin.x) * zoom
    m.viewport.scrollTop += (origin.y - m.origin.y) * zoom
    m.origin = origin
    m.pad = pad
    m.size = { w: bounds.right - bounds.left, h: bounds.bottom - bounds.top }
    const width = m.size.w + 2 * pad.x
    const height = m.size.h + 2 * pad.y
    m.plane.style.width = `${width}px`
    m.plane.style.height = `${height}px`
    m.lines.setAttribute('width', String(width))
    m.lines.setAttribute('height', String(height))
    /** @type {string[]} */
    const paths = []
    /**
     * @param {PageNode} node
     * @param {PageNode | null} parent
     * @param {string} color
     */
    const put = (node, parent, color) => {
      const box = at.get(node.id)
      // A node the page hides measures nothing and takes no place; it keeps watching for its size.
      if (box === undefined) return
      node.el.style.left = `${box.x + origin.x}px`
      node.el.style.top = `${box.y + origin.y}px`
      const parentBox = parent === null ? undefined : at.get(parent.id)
      if (parentBox !== undefined) {
        const d = edgePath(
          { ...parentBox, x: parentBox.x + origin.x, y: parentBox.y + origin.y },
          { ...box, x: box.x + origin.x, y: box.y + origin.y },
          parent?.kind === 'root'
        )
        paths.push(
          `<path class="b-edge${parent?.kind === 'root' ? ' b-trunk' : ''}" d="${d}" style="--dc:${color}"/>`
        )
      }
      node.children.forEach((child, i) => put(child, node, node.kind === 'root' ? dotColor(i) : color))
    }
    put(m.tree, null, '')
    m.lines.innerHTML = paths.join('')
  }

  /** @param {Mounted} m */
  const schedule = m => {
    if (frame === 0) {
      frame = win.requestAnimationFrame(() => {
        frame = 0
        if (mounted !== m) return
        arrange(m)
        // The root grows once its diagram is drawn; until the reader moves, it stays in view.
        if (m.untouched) showRoot(m)
      })
    }
  }

  /**
   * Shows the pull request, the root, where the reader looks first: at full size, or smaller only
   * when it is wider than the window; centered when it fits, from its title when it is taller.
   * @param {Mounted} m
   */
  const showRoot = m => {
    const room = { width: m.viewport.clientWidth, height: m.viewport.clientHeight }
    // A height of 1 always fits, so only the width sets the zoom.
    const next = fitZoom({ width: m.tree.el.offsetWidth, height: 1 }, room, FOCUS_MARGIN)
    moveTo(m, next, mm => scrollToShow(mm, boxOf([mm.tree]), FOCUS_MARGIN), { instant: true })
  }

  /**
   * Zooms so the point under (x, y) on screen stays where it is.
   * @param {Mounted} m
   * @param {number} next
   * @param {number} [x]
   * @param {number} [y]
   */
  const zoomAt = (m, next, x, y) => {
    const vr = m.viewport.getBoundingClientRect()
    const px = (x ?? vr.left + vr.width / 2) - vr.left
    const py = (y ?? vr.top + vr.height / 2) - vr.top
    // The point under the pointer, in tree pixels, which do not move when the room around does.
    const treeX = (m.viewport.scrollLeft + px) / zoom - m.origin.x
    const treeY = (m.viewport.scrollTop + py) / zoom - m.origin.y
    paint(m, next)
    arrange(m)
    m.viewport.scrollLeft = (treeX + m.origin.x) * zoom - px
    m.viewport.scrollTop = (treeY + m.origin.y) * zoom - py
    remember(m)
  }

  /** @param {Mounted} m */
  const stopMove = m => {
    if (m.move !== 0) {
      win.cancelAnimationFrame(m.move)
      m.move = 0
    }
    m.main.classList.remove('is-moving')
  }

  /**
   * Moves the board to a zoom and the scroll `where` gives for it, once the tree is laid out at
   * that zoom. The move glides: the zoom and the middle of the view go from where they are to
   * where they end over MOVE_MS, and the tree is laid out again at each step, since the room
   * around it follows the zoom. A move with `instant`, or for a reader who asked for less motion,
   * jumps.
   * @param {Mounted} m
   * @param {number} next
   * @param {(m: Mounted) => { left: number, top: number }} where
   * @param {{ instant?: boolean }} [how]
   */
  const moveTo = (m, next, where, how = {}) => {
    stopMove(m)
    if (how.instant !== true) m.untouched = false
    const { viewport } = m
    const half = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
    const from = zoom
    /** The middle of the view, in tree pixels, which do not move when the room around does. */
    const middle = () => ({
      x: (viewport.scrollLeft + half.x) / zoom - m.origin.x,
      y: (viewport.scrollTop + half.y) / zoom - m.origin.y,
    })
    /** @param {{ x: number, y: number }} c */
    const center = c => {
      viewport.scrollLeft = (c.x + m.origin.x) * zoom - half.x
      viewport.scrollTop = (c.y + m.origin.y) * zoom - half.y
    }
    const start = middle()
    paint(m, next)
    arrange(m)
    const to = zoom
    const end = where(m)
    viewport.scrollLeft = end.left
    viewport.scrollTop = end.top
    if (how.instant === true || !smooth) {
      remember(m)
      return
    }
    const target = middle()
    // Back where the board was, so the move starts there.
    paint(m, from)
    arrange(m)
    center(start)
    /** @type {number | null} */
    let began = null
    /** @param {number} now */
    const step = now => {
      began ??= now
      const t = Math.min(1, (now - began) / MOVE_MS)
      const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2
      paint(m, from * (to / from) ** e)
      arrange(m)
      center({ x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e })
      if (t < 1) {
        m.move = win.requestAnimationFrame(step)
      } else {
        m.move = 0
        m.main.classList.remove('is-moving')
        remember(m)
      }
    }
    // `is-moving` on `#main` says a move is under way, for whatever waits for the board to settle.
    m.main.classList.add('is-moving')
    m.move = win.requestAnimationFrame(step)
  }

  /**
   * The width of the board the file panel leaves free, at its left; what the board shows goes there.
   * @param {Mounted} m
   */
  const freeWidth = m => m.viewport.clientWidth - (m.panel.hidden ? 0 : m.panel.offsetWidth)

  /**
   * The scroll that shows a box: centered where it fits the window, from its top left where not.
   * @param {Mounted} m
   * @param {{ left: number, top: number, right: number, bottom: number }} b in plane pixels
   * @param {number} margin
   */
  const scrollToShow = (m, b, margin) => {
    /**
     * @param {number} start
     * @param {number} length
     * @param {number} space
     */
    const scrollFor = (start, length, space) =>
      length * zoom <= space - 2 * margin ? (start + length / 2) * zoom - space / 2 : start * zoom - margin
    return {
      left: scrollFor(b.left, b.right - b.left, Math.max(0, freeWidth(m))),
      top: scrollFor(b.top, b.bottom - b.top, m.viewport.clientHeight),
    }
  }

  /**
   * The box of nodes on the plane, leaving out the ones the page hides.
   * @param {PageNode[]} nodes
   */
  const boxOf = nodes =>
    /** @type {NonNullable<ReturnType<typeof boundsOf>>} */ (
      boundsOf(
        nodes
          .map(n => ({ x: n.el.offsetLeft, y: n.el.offsetTop, w: n.el.offsetWidth, h: n.el.offsetHeight }))
          .filter(box => box.h > 0)
      )
    )

  /**
   * Zooms out until the whole tree shows, and centers it.
   * @param {Mounted} m
   */
  const fit = m => {
    const { w, h } = m.size
    const room = { width: m.viewport.clientWidth, height: m.viewport.clientHeight }
    moveTo(m, fitZoom({ width: w, height: h }, room), mm => ({
      left: (mm.pad.x + w / 2) * zoom - room.width / 2,
      top: mm.pad.y * zoom - Math.max(FRAME_MARGIN, (room.height - h * zoom) / 2),
    }))
  }

  /**
   * Zooms in to full size on a node and brings it to the top left of the board.
   * @param {Mounted} m
   * @param {HTMLElement} el
   */
  const zoomTo = (m, el) => {
    moveTo(m, 1, () => ({ left: el.offsetLeft - FRAME_MARGIN, top: el.offsetTop - FRAME_MARGIN }))
  }

  /**
   * Brings an open layer and its points into view at full size, so the reader can read it at
   * once. What fits the window is centered; what does not starts at the top left, where the
   * layer's title is, and the reader scrolls for the rest: a layer shrunk to fit is too small to
   * read.
   * @param {Mounted} m
   * @param {PageNode} layer
   */
  const focusLayer = (m, layer) => {
    moveTo(m, 1, mm => scrollToShow(mm, boxOf([layer, ...layer.children]), FOCUS_MARGIN))
  }

  /**
   * Brings an opened point into the middle of the board, zoomed in a little so it reads well, or
   * more if the reader is zoomed in further. Beside the file panel the point zooms only as far as
   * it still fits the room the panel leaves.
   * @param {Mounted} m
   * @param {PageNode} point
   */
  const focusPoint = (m, point) => {
    const room = freeWidth(m) - 2 * FOCUS_MARGIN
    const width = point.el.offsetWidth
    const fits = width > 0 ? room / width : POINT_ZOOM
    moveTo(m, Math.min(Math.max(zoom, POINT_ZOOM), Math.max(fits, FAR_ZOOM)), mm =>
      scrollToShow(mm, boxOf([point]), FOCUS_MARGIN)
    )
  }

  /**
   * Makes the layout as tall as the window leaves it between the header and the footer, so the
   * page itself never scrolls: a scroll into view then moves the board only.
   * @param {Mounted} m
   */
  const placeLayout = m => {
    const top = m.main.getBoundingClientRect().top + win.scrollY
    const below = doc.documentElement.scrollHeight - (m.layout.getBoundingClientRect().bottom + win.scrollY)
    m.layout.style.setProperty('--board-h', `${Math.round(win.innerHeight - top - below)}px`)
  }

  /**
   * @param {NodeKind} kind
   * @param {string} id
   * @param {...Node} content
   * @returns {HTMLElement}
   */
  const makeNode = (kind, id, ...content) => {
    const el = doc.createElement('div')
    el.className = NODE_CLASSES[kind]
    el.setAttribute('data-node', id)
    el.append(...content)
    return el
  }

  /**
   * Moves an element into a node, leaving a marker where it was so it can go back.
   * @param {Array<[Comment, Element]>} moved
   * @param {Element} el
   */
  const lift = (moved, el) => {
    const marker = doc.createComment('board')
    el.before(marker)
    moved.push([marker, el])
    return el
  }

  /** @param {HTMLElement} main */
  const mount = main => {
    const overview = main.querySelector(':scope > #overview')
    const layers = Array.from(main.querySelectorAll(':scope > pr-layer'))
    const layout = main.parentElement
    if (overview === null || layout === null) {
      return
    }
    const frames = [overview, ...layers]
    /** @type {Array<[Comment, Element]>} */
    const moved = []
    /** @type {Array<[Element, boolean]>} */
    const collapsed = []
    /** @type {Array<[Element, string]>} */
    const renamed = []
    // Every node starts as its title; the other views get back what the reader had open.
    for (const body of main.querySelectorAll('.file-body, .layer-body')) {
      collapsed.push([body, body.hasAttribute('hidden')])
      setCardCollapsed(body, true)
    }
    // The root is the pull request: the header's title block (its number and title, author,
    // branches, state, and size) moves onto it, and the overview opens under it.
    const title = root.querySelector('header .hdr-title')
    const rootContent = title === null ? [overview] : [lift(moved, title), overview]
    // On the root, the overview's heading opens the rest of it, under the summary: its Details.
    const heading = overview.querySelector(':scope > .panel-h h2')
    if (heading !== null) {
      renamed.push([heading, heading.textContent ?? ''])
      heading.textContent = 'Details'
    }
    /** @type {Element[]} */
    const added = []
    /** @type {PageNode} */
    const tree = { id: 'root', kind: 'root', el: makeNode('root', 'root', ...rootContent), children: [] }
    for (const layer of layers) {
      const section = layer.querySelector(':scope > section')
      const id = section?.id ?? `layer-${tree.children.length}`
      /** @type {PageNode[]} */
      const leaves = []
      for (const point of layer.querySelectorAll('.findings > li[data-point]')) {
        const list = doc.createElement('ol')
        list.className = 'findings'
        list.append(lift(moved, point))
        leaves.push({ id: point.id, kind: 'point', el: makeNode('point', point.id, list), children: [] })
      }
      // The layer's rationale shows under its title while the layer is closed, so the reader
      // knows what the layer is about before opening it.
      const rationale = section?.querySelector(':scope > .layer-body > .body > .rationale')
      const head = section?.querySelector(':scope > .layer-h')
      if (rationale && head) head.after(lift(moved, rationale))
      // The reader reviews a layer through its points: its title bar counts the ones done.
      const progress = doc.createElement('span')
      progress.className = 'b-progress'
      head?.querySelector(':scope > h2')?.after(progress)
      added.push(progress)
      const layerNode = makeNode('layer', id)
      layerNode.style.setProperty('--dc', dotColor(tree.children.length))
      tree.children.push({ id, kind: 'layer', el: layerNode, children: leaves })
    }
    // The layers go in after their points are lifted out, so each marker stays in its layer's list
    // for the trip back.
    tree.children.forEach((node, i) => node.el.append(/** @type {Element} */ (layers[i])))

    const viewport = doc.createElement('div')
    viewport.className = 'board-viewport'
    const plane = doc.createElement('div')
    plane.className = 'board-plane'
    const lines = doc.createElementNS(SVG_NS, 'svg')
    lines.setAttribute('class', 'board-lines')
    lines.setAttribute('aria-hidden', 'true')
    plane.append(lines)
    /**
     * Each node by its element, for what the reader presses or clicks on.
     * @type {Map<Element, PageNode>}
     */
    const nodes = new Map()
    /** @param {PageNode} node */
    const addNode = node => {
      plane.append(node.el)
      nodes.set(node.el, node)
      node.children.forEach(addNode)
    }
    addNode(tree)
    viewport.append(plane)
    main.append(viewport)
    main.insertAdjacentHTML('beforeend', boardToolsHtml())
    const tools = /** @type {HTMLElement} */ (main.lastElementChild)
    main.classList.add('board')
    const listeners = new AbortController()
    const { signal } = listeners
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule(m))
    // A point the reader acts on changes its status, and its layer's count with it.
    // Once the reader acts on the point in focus, the board takes them on to the next one.
    const watcher =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(records => {
            schedule(m)
            for (const record of records) {
              const el = /** @type {Element} */ (record.target)
              if (
                record.oldValue === 'open' &&
                el.getAttribute('data-status') !== 'open' &&
                m.focus?.contains(el)
              ) {
                const from = m.focus
                win.setTimeout(() => {
                  if (mounted === m && m.focus === from) advance(m, from)
                }, opts.advanceMs ?? ADVANCE_MS)
              }
            }
          })
    watcher?.observe(plane, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-status'],
      attributeOldValue: true,
    })
    // A file has no node: a link into one opens it here, beside the board, with its whole diff.
    main.insertAdjacentHTML(
      'beforeend',
      '<aside class="b-filepanel" aria-label="File" hidden><div class="b-filepanel-h"><button class="cmd" type="button" data-board="close-file">close</button></div><div class="b-filepanel-body"></div></aside>'
    )
    const panel = /** @type {HTMLElement} */ (main.lastElementChild)
    /** @type {Mounted} */
    const m = {
      main,
      layout,
      viewport,
      plane,
      lines,
      tools,
      panel,
      shown: null,
      focus: null,
      move: 0,
      untouched: true,
      watcher,
      tree,
      nodes,
      frames,
      added,
      renamed,
      moved,
      collapsed,
      origin: { x: PAD, y: PAD },
      pad: { x: PAD, y: PAD },
      size: { w: 0, h: 0 },
      listeners,
      observer,
    }
    mounted = m
    placeLayout(m)
    paint(m, zoom)
    arrange(m)
    for (const el of nodes.keys()) observer?.observe(el)
    if (place !== null) {
      viewport.scrollLeft = (place.x + m.origin.x) * zoom
      viewport.scrollTop = (place.y + m.origin.y) * zoom
    } else {
      // The board opens on the pull request: the root in the middle of the window, at full size
      // when it fits, so the reader reads it first. A link in the URL then takes the reader to its
      // target: the deep links scroll to it next. A plain fragment that names a layer, as the
      // other views write, is the browser's own scroll; on the next frame the board brings that
      // layer into view instead.
      showRoot(m)
      const id = win.location.hash.slice(1)
      const named = id === '' ? null : doc.getElementById(decodeURIComponent(id))
      const layer = named === null ? undefined : m.tree.children.find(l => l.el.contains(named))
      if (layer !== undefined) {
        win.requestAnimationFrame(() => {
          if (mounted === m) focusLayer(m, layer)
        })
      }
    }
    // The chat pane floats over the board instead of taking a column beside it.
    root.dispatchEvent(new Event('board-change'))
    wire(m, signal)
  }

  /**
   * @param {Mounted} m
   * @param {AbortSignal} signal
   */
  const wire = (m, signal) => {
    const { main, viewport, plane, tools } = m
    win.addEventListener('resize', () => placeLayout(m), { signal })

    tools.addEventListener(
      'click',
      event => {
        const what = /** @type {Element} */ (event.target).closest('[data-board]')?.getAttribute('data-board')
        if (what) m.untouched = false
        if (what === 'zoom-in') zoomAt(m, zoom * ZOOM_STEP)
        else if (what === 'zoom-out') zoomAt(m, zoom / ZOOM_STEP)
        else if (what === 'fit') fit(m)
        else if (what === 'tidy') {
          offsets = new Map()
          writeOffsets(storage, storageKey, offsets)
          arrange(m)
        }
      },
      { signal }
    )

    m.panel
      .querySelector('[data-board="close-file"]')
      ?.addEventListener('click', () => hideFile(m), { signal })
    // In the panel, the points in the diff are one line each; a click on one's title opens it.
    m.panel.addEventListener(
      'click',
      event => {
        const target = /** @type {Element} */ (event.target)
        const row = target.closest('tr.ifind')
        if (
          row !== null &&
          target.closest('.f-title') !== null &&
          target.closest(CONTROL_SELECTOR) === null
        ) {
          row.classList.toggle('b-open')
        }
      },
      { signal }
    )

    viewport.addEventListener(
      'wheel',
      event => {
        stopMove(m)
        m.untouched = false
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          zoomAt(m, wheelZoom(zoom, event), event.clientX, event.clientY)
        }
      },
      { passive: false, signal }
    )
    viewport.addEventListener('scroll', () => remember(m), { passive: true, signal })

    // A press on the empty board pans it, and so does the middle button anywhere. A press on a
    // node's title bar drags the node once the pointer moves; a press that does not move is a click.
    /** @type {{ id: number, x: number, y: number, node: PageNode | null, start: Offset, dragging: boolean } | null} */
    let press = null
    let swallowClick = false
    viewport.addEventListener(
      'pointerdown',
      event => {
        // A press of the reader's own stops a move the board is making, and the board leaves the
        // view to the reader from then on.
        stopMove(m)
        m.untouched = false
        // Events reach the viewport from elements on it only.
        const target = /** @type {Element} */ (event.target)
        const empty = target === viewport || target === plane
        const handle = target.closest(HANDLE_SELECTOR)
        const nodeEl = handle?.closest('.bnode')
        const node = nodeEl ? m.nodes.get(nodeEl) : undefined
        const draggable =
          event.button === 0 && node !== undefined && target.closest(CONTROL_SELECTOR) === null
        if (!((event.button === 0 && empty) || event.button === 1 || draggable)) {
          return
        }
        swallowClick = false
        const start = draggable ? (offsets.get(node.id) ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 }
        press = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          node: draggable ? node : null,
          start,
          dragging: false,
        }
        // A press on a node takes the pointer only once it drags, so a plain click still reaches
        // what it was on.
        if (!draggable) {
          event.preventDefault()
          main.classList.add('is-panning')
          capture(viewport, event.pointerId)
        }
      },
      { signal }
    )
    viewport.addEventListener(
      'pointermove',
      event => {
        if (press === null || event.pointerId !== press.id) {
          return
        }
        const node = press.node
        if (node === null) {
          viewport.scrollLeft -= event.clientX - press.x
          viewport.scrollTop -= event.clientY - press.y
          // A pan that moved ends in no click, so it keeps the point in focus.
          press = { ...press, x: event.clientX, y: event.clientY, dragging: true }
          return
        }
        const dx = event.clientX - press.x
        const dy = event.clientY - press.y
        if (!press.dragging && Math.hypot(dx, dy) < DRAG_START) {
          return
        }
        if (!press.dragging) {
          press = { ...press, dragging: true }
          main.classList.add('is-dragging')
          doc.getSelection()?.removeAllRanges()
          capture(viewport, event.pointerId)
        }
        offsets.set(node.id, { dx: press.start.dx + dx / zoom, dy: press.start.dy + dy / zoom })
        arrange(m)
      },
      { signal }
    )
    /** @param {PointerEvent} event */
    const endPress = event => {
      if (press === null || event.pointerId !== press.id) {
        return
      }
      if (press.dragging) {
        if (press.node !== null) writeOffsets(storage, storageKey, offsets)
        swallowClick = event.type === 'pointerup'
      }
      press = null
      main.classList.remove('is-panning', 'is-dragging')
    }
    viewport.addEventListener('pointerup', endPress, { signal })
    viewport.addEventListener('pointercancel', endPress, { signal })

    // On the viewport, which a drag takes the pointer to, so the click that ends a drag lands here.
    viewport.addEventListener(
      'click',
      event => {
        const target = /** @type {Element} */ (event.target)
        const nodeEl = target.closest('.bnode')
        // The click at the end of a drag is not a click on what the drag started on.
        if (swallowClick) {
          swallowClick = false
          event.preventDefault()
          event.stopPropagation()
          return
        }
        // A click anywhere but on the point in focus ends the focus, and still does what it does.
        if (m.focus !== null && !m.focus.contains(target)) setFocus(m, null)
        if (!(nodeEl instanceof HTMLElement)) {
          return
        }
        // A click on a layer's title or chevron opens it, and brings it and what hangs from it
        // into view at a zoom the reader can read; the board does the toggle, so it can follow it.
        const layer = m.tree.children.find(l => l.el === nodeEl)
        if (layer !== undefined && target.closest('.layer-h h2, .layer-h > .chev') !== null) {
          event.preventDefault()
          event.stopPropagation()
          if (setCardCollapsed(target) === false) focusLayer(m, layer)
          else arrange(m)
          return
        }
        // Zoomed out, a click zooms in to the node instead of acting on what it hit.
        if (zoom < FAR_ZOOM) {
          event.preventDefault()
          event.stopPropagation()
          zoomTo(m, nodeEl)
          return
        }
        if (target.closest(CONTROL_SELECTOR) !== null) {
          return
        }
        // The root and a point open on a click on their title bar; a layer on its title.
        if (target.closest('.b-root .hdr-title, .b-root .panel-h, .b-point .f-title') !== null) {
          const opened = nodeEl.classList.toggle('is-open')
          // An opened point takes the focus: the rest of the board fades behind it.
          if (nodeEl.matches('.b-point')) setFocus(m, opened ? nodeEl : null)
          const point = opened ? m.nodes.get(nodeEl) : undefined
          if (point?.kind === 'point') focusPoint(m, point)
        }
      },
      { capture: true, signal }
    )

    doc.addEventListener(
      'keydown',
      event => {
        m.untouched = false
        if (event.key === 'Escape' && m.focus !== null) setFocus(m, null)
      },
      { signal }
    )

    // The Other layer opens as details, on its own; the board follows it once it has.
    plane.addEventListener(
      'toggle',
      event => {
        const details = /** @type {HTMLDetailsElement} */ (event.target)
        const layer = m.tree.children.find(l => l.el.contains(details))
        if (layer !== undefined && details.open && details.matches('pr-layer > section > details')) {
          focusLayer(m, layer)
        }
      },
      { capture: true, signal }
    )
  }

  /**
   * Takes the reader from a point they acted on to the next one still open: on in its layer, then
   * in the layers after it, then from the first layer for one they skipped. A layer left behind
   * closes, done, and the next one opens. With none left the board says so and shows the tree.
   * @param {Mounted} m
   * @param {HTMLElement} from
   */
  const advance = (m, from) => {
    const points = m.tree.children.flatMap(layer => layer.children.map(point => ({ layer, point })))
    const at = points.findIndex(({ point }) => point.el === from)
    const isOpen = /** @param {PageNode} point */ point =>
      point.el.querySelector('[data-point]')?.getAttribute('data-status') === 'open'
    const next = [...points.slice(at + 1), ...points.slice(0, at)].find(({ point }) => isOpen(point))
    from.classList.remove('is-open')
    setFocus(m, null)
    const here = points[at]?.layer
    if (next === undefined) {
      arrange(m)
      toast(root, 'Every attention point is reviewed.')
      fit(m)
      return
    }
    if (here !== undefined && here !== next.layer) {
      const section = here.el.querySelector('pr-layer > section')
      const details = section?.querySelector(':scope > details')
      if (details instanceof HTMLDetailsElement) details.open = false
      else if (section) setCardCollapsed(section, true)
    }
    const section = next.layer.el.querySelector('pr-layer > section')
    if (section && !layerOpen(next.layer.el)) openLayer(section)
    next.point.el.classList.add('is-open')
    setFocus(m, next.point.el)
    focusPoint(m, next.point)
  }

  /**
   * Puts one point in focus, or none: the rest of the board fades, so the reader reads that point.
   * @param {Mounted} m
   * @param {HTMLElement | null} el
   */
  const setFocus = (m, el) => {
    if (el === m.focus) {
      return
    }
    m.focus?.classList.remove('is-focus')
    m.focus = el
    el?.classList.add('is-focus')
    m.main.classList.toggle('has-focus', el !== null)
    // The point's file opens in the side panel at the point's line, the way its link does; the
    // panel closes once no point is in focus.
    const link = el?.querySelector('[data-point] .f-title .loc')?.getAttribute('href') ?? null
    if (link === null) hideFile(m)
    else followLink(link, root)
  }

  /**
   * Opens a file card in the side panel, and puts the one it held back in its layer.
   * @param {Mounted} m
   * @param {Element} article
   */
  const showFile = (m, article) => {
    const file = /** @type {Element} */ (article.closest('pr-file'))
    if (m.panel.contains(file)) {
      return
    }
    hideFile(m)
    const marker = doc.createComment('board')
    file.before(marker)
    m.shown = [marker, file]
    m.panel.querySelector('.b-filepanel-body')?.append(file)
    m.panel.hidden = false
    // The point the reader opened the file from moves beside the panel, so both stay in view.
    const point = m.focus === null ? undefined : m.nodes.get(m.focus)
    if (point !== undefined) focusPoint(m, point)
  }

  /**
   * Closes the side panel; its file card goes back in its layer.
   * @param {Mounted} m
   */
  const hideFile = m => {
    if (m.shown !== null) {
      for (const row of m.shown[1].querySelectorAll('tr.ifind.b-open')) row.classList.remove('b-open')
      m.shown[0].replaceWith(m.shown[1])
      m.shown = null
    }
    m.panel.hidden = true
  }

  /**
   * Stops what a board listens to and the move it makes.
   * @param {Mounted} m
   */
  const release = m => {
    m.listeners.abort()
    m.observer?.disconnect()
    m.watcher?.disconnect()
    stopMove(m)
  }

  const unmount = () => {
    if (mounted === null) {
      return
    }
    const { main, layout, viewport, tools, panel, frames, added, moved, collapsed } = mounted
    release(mounted)
    hideFile(mounted)
    panel.remove()
    for (const el of added) el.remove()
    for (const [el, text] of mounted.renamed) el.textContent = text
    // Each element the board lifted goes back where its marker is, each frame after the bars.
    for (const [marker, el] of moved) marker.replaceWith(el)
    main.append(...frames)
    for (const [body, wasHidden] of collapsed) setCardCollapsed(body, wasHidden)
    viewport.remove()
    tools.remove()
    main.classList.remove('board', 'is-far', 'is-panning', 'is-dragging', 'has-focus')
    layout.style.removeProperty('--board-h')
    mounted = null
    root.dispatchEvent(new Event('board-change'))
  }

  const redraw = () => {
    const main = root.querySelector('#main')
    if (view !== 'board' || !(main instanceof HTMLElement)) {
      unmount()
      return
    }
    if (mounted === null || mounted.main !== main || !main.contains(mounted.viewport)) {
      // A render replaced `#main`, or its content: the old board went with it.
      if (mounted !== null) release(mounted)
      mounted = null
      mount(main)
    }
  }

  const rootListeners = new AbortController()
  // Whatever scrolls to a card or a line raises `reveal-code` on it first. The node that holds it
  // opens, and the tree makes room at once, before the scroll measures where to go.
  root.addEventListener(
    'reveal-code',
    event => {
      const m = mounted
      const target = /** @type {Element} */ (event.target)
      if (m === null || !(m.plane.contains(target) || m.panel.contains(target))) {
        return
      }
      if (zoom < FAR_ZOOM) paint(m, 1)
      // A file has no node on the board: a link into one opens it in the side panel.
      const file = target.closest('article.file')
      if (file !== null) {
        showFile(m, file)
        setCardCollapsed(file, false)
        return
      }
      // A scroll to a layer, from a link or a key, puts it at the top left; on the next frame the
      // board brings it into view the way it does a layer the reader opens.
      const toLayer = target.matches('pr-layer > section')
        ? m.tree.children.find(l => l.el.contains(target))
        : undefined
      if (toLayer !== undefined) {
        win.requestAnimationFrame(() => {
          if (mounted === m) focusLayer(m, toLayer)
        })
      }
      // A target under a closed layer opens the layer, so its node is on the board.
      const leaf = target.closest('.b-point')
      const layer = m.tree.children.find(l => l.children.some(child => child.el === leaf))
      const section = layer?.el.querySelector('pr-layer > section')
      if (layer !== undefined && section && !layerOpen(layer.el)) openLayer(section)
      const opened = target.closest('.b-point, .b-root')
      if (opened instanceof HTMLElement) {
        opened.classList.add('is-open')
        if (opened.matches('.b-point')) setFocus(m, opened)
      }
      arrange(m)
    },
    { signal: rootListeners.signal }
  )

  redraw()

  return {
    stop() {
      rootListeners.abort()
      unmount()
      win.cancelAnimationFrame(frame)
      frame = 0
    },
    setView(next) {
      if (next !== view) {
        view = next
        redraw()
      }
    },
    redraw,
    zoom: () => zoom,
    setZoom: next => {
      if (mounted !== null) zoomAt(mounted, next)
    },
  }
}
