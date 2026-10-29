// @ts-check
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADVANCE_MS,
  boardToolsHtml,
  boundsOf,
  clampZoom,
  edgePath,
  FAR_ZOOM,
  fitZoom,
  initBoard,
  layoutTree,
  MAX_ZOOM,
  MIN_ZOOM,
  MOVE_MS,
  POINT_ZOOM,
  readOffsets,
  TREE,
  wheelZoom,
  writeOffsets,
  zoomLabel,
} from './board.js'
import { followLink } from './deep-link.js'

// The deep links scroll a page this test has no layout for; the board's use of them is what counts.
vi.mock('./deep-link.js', async original => ({
  .../** @type {object} */ (await original()),
  followLink: vi.fn(),
}))

/** @type {HTMLElement} */
let root
/** @type {ReturnType<typeof initBoard> | undefined} */
let board
/** @type {FrameRequestCallback | null} */
let pendingFrame
/** @type {(() => void) | null} */
let resized
/** @type {Map<string, string>} */
let stored

const PAGE = `
    <header><div class="hdr-bar"></div><div class="hdr-title"><div class="title"><h1><span class="mono num">#42</span>Fix the widget</h1><a class="cmd" href="https://example.test/pull/42">github</a></div><p class="meta"><span>by ana</span></p></div></header>
    <div class="layout">
      <main id="main">
        <div class="stale-bar outdated-bar">outdated</div>
        <section class="panel" id="overview"><div class="panel-h"><h2>Overview</h2></div><div class="body">summary</div></section>
        <pr-layer><section class="layer" id="layer-auth" data-layer="auth">
          <div class="layer-h"><button class="chev" type="button" data-act="toggle-card"></button><h2 id="layer-auth-h"><span class="lbl">Layer 1 of 2</span>Auth</h2><label class="chk"><input type="checkbox"> reviewed</label></div>
          <div class="layer-body"><div class="body"><div class="rationale prose">why</div><div class="judgment">decided</div></div>
            <div class="layer-points"><ol class="findings">
              <li class="finding" id="point-a" data-point="a" data-status="open"><div><div class="f-title"><span class="p-title">Check A</span><a class="loc" href="#line:src/auth.ts:4">src/auth.ts:4</a></div><div class="prose">body</div></div></li>
              <li class="finding" id="point-gone" data-point="gone" data-status="resolved" hidden><div><div class="f-title">Resolved</div></div></li>
            </ol></div>
            <div class="files"><pr-file><article class="file" id="file-auth" data-path="src/auth/login.ts"><div class="file-h"><span class="chev"></span><h3 class="path">src/auth/login.ts</h3></div><div class="file-body"><table><tr id="row-4"><td>row</td></tr></table></div></article></pr-file></div>
          </div>
        </section></pr-layer>
        <pr-layer><section class="layer" id="layer-store" data-layer="store">
          <div class="layer-h"><h2>Store</h2></div>
          <div class="layer-body" hidden><div class="files"><pr-file><article class="file" id="file-store" data-path="store.ts"><div class="file-h"><h3 class="path">store.ts</h3></div><div class="file-body"></div></article></pr-file></div></div>
        </section></pr-layer>
      </main>
    </div>`

/**
 * Sizes for the boxes happy-dom does not lay out: each kind of node, open or closed.
 * @param {HTMLElement} el
 * @param {'w' | 'h'} side
 */
function size(el, side) {
  if (el.hidden) return 0
  const open = el.classList.contains('is-open')
  if (el.matches('.board-viewport')) return side === 'w' ? 600 : 400
  if (el.matches('.b-filepanel')) return side === 'w' ? 100 : 400
  if (el.matches('.b-root')) return side === 'w' ? (open ? 760 : 560) : open ? 300 : 80
  if (el.matches('.b-layer')) {
    const shut = el.querySelector('.layer-body')?.hasAttribute('hidden')
    return side === 'w' ? (shut ? 300 : 560) : 60
  }
  if (el.matches('.b-point')) {
    if (el.querySelector('li[hidden]')) return 0
    return side === 'w' ? (open ? 760 : 300) : open ? 120 : 50
  }
  return 0
}

/**
 * @param {'offsetWidth' | 'offsetHeight' | 'offsetLeft' | 'offsetTop' | 'clientWidth' | 'clientHeight'} prop
 * @param {(el: HTMLElement) => number} read
 */
const fake = (prop, read) =>
  vi.spyOn(HTMLElement.prototype, prop, 'get').mockImplementation(
    /** @this {HTMLElement} */ function () {
      return read(this)
    }
  )

beforeEach(() => {
  root = document.createElement('pr-app')
  root.innerHTML = PAGE
  document.body.replaceChildren(root)
  pendingFrame = null
  resized = null
  stored = new Map()
  fake('offsetWidth', el => size(el, 'w'))
  fake('offsetHeight', el => size(el, 'h'))
  fake('offsetLeft', el => Number.parseFloat(el.style.left) || 0)
  fake('offsetTop', el => Number.parseFloat(el.style.top) || 0)
  fake('clientWidth', el => (el.matches('.board-viewport') ? 600 : 0))
  fake('clientHeight', el => (el.matches('.board-viewport') ? 400 : 0))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    /** @this {Element} */ function () {
      if (this.matches('.board-viewport')) return new DOMRect(0, 100, 600, 400)
      if (this.matches('#main, .layout')) return new DOMRect(0, 60, 1000, 800)
      return new DOMRect(0, 0, 0, 0)
    }
  )
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    pendingFrame = callback
    return 7
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(/** @type {() => void} */ callback) {
        resized = callback
      }
      observe() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  board?.stop()
  board = undefined
  window.location.hash = ''
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

/** A Storage over the test's map. */
const storage = () => /** @type {Storage} */ (
  /** @type {unknown} */ ({
    getItem: (/** @type {string} */ key) => stored.get(key) ?? null,
    setItem: (/** @type {string} */ key, /** @type {string} */ value) => void stored.set(key, value),
    removeItem: (/** @type {string} */ key) => void stored.delete(key),
  })
)
const KEY = () => `pr-review.board:${window.location.pathname}`
/** @param {import('./layer-views.js').LayerView} view */
const open = view => initBoard(root, { view, storage: storage(), smooth: false })
/** Waits for the observers' callbacks and the timers they start. @param {number} [ms] */
const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms + 5))
const main = () => /** @type {HTMLElement} */ (root.querySelector('#main'))
const viewport = () => /** @type {HTMLElement} */ (root.querySelector('.board-viewport'))
/** @param {string} id */
const node = id => /** @type {HTMLElement} */ (root.querySelector(`.bnode[data-node="${id}"]`))
/**
 * @param {HTMLElement} el
 * @returns {[number, number]}
 */
const at = el => [Number.parseFloat(el.style.left), Number.parseFloat(el.style.top)]
/**
 * Where a node is from the root. A drag past the tree's edge moves the room around it, so a
 * node is placed against the root, which stays put.
 * @param {string} id
 * @returns {[number, number]}
 */
const fromRoot = id => {
  const [x, y] = at(node(id))
  const [rx, ry] = at(node('root'))
  return [x - rx, y - ry]
}
const readout = () => root.querySelector('.board-zoom')?.textContent
/** @param {string} what */
const press = what =>
  root.querySelector(`[data-board="${what}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
/** @param {Element | null | undefined} el */
const click = el => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  el?.dispatchEvent(event)
  return event
}
/**
 * A wheel event as a browser sends it. happy-dom's WheelEvent leaves out the keys and the point.
 * @param {WheelEventInit} init
 */
const wheel = init => {
  const event = new WheelEvent('wheel', { cancelable: true, ...init })
  for (const key of /** @type {const} */ (['ctrlKey', 'metaKey', 'clientX', 'clientY'])) {
    Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) })
  }
  return event
}
/**
 * @param {string} type
 * @param {Element | null | undefined} target
 * @param {PointerEventInit} init
 */
const pointer = (type, target, init) =>
  target?.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init })
  )
/** Opens the first layer, so its points are on the board. */
const openAuth = () => click(node('layer-auth').querySelector('.layer-h h2'))
/** @param {string} id */
const bodyOf = id =>
  /** @type {HTMLElement} */ (root.querySelector(`#${id} > .file-body, #${id} > .layer-body`))

describe('the board helpers', () => {
  it('keeps a zoom between the least and the most the board allows', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM)
    expect(clampZoom(9)).toBe(MAX_ZOOM)
    expect(clampZoom(0.5)).toBe(0.5)
  })

  it('zooms in for a wheel turned up and out for one turned down, in pixels, lines, or pages', () => {
    expect(wheelZoom(1, new WheelEvent('wheel', { deltaY: -100 }))).toBeGreaterThan(1)
    expect(wheelZoom(1, new WheelEvent('wheel', { deltaY: 100 }))).toBeLessThan(1)
    const pixels = wheelZoom(1, new WheelEvent('wheel', { deltaY: 16 }))
    expect(wheelZoom(1, new WheelEvent('wheel', { deltaY: 1, deltaMode: 1 }))).toBeCloseTo(pixels)
    expect(wheelZoom(1, new WheelEvent('wheel', { deltaY: 10, deltaMode: 2 }))).toBe(MIN_ZOOM)
  })

  it('fits content in the viewport with a margin, and never zooms past full size', () => {
    expect(fitZoom({ width: 2000, height: 500 }, { width: 1064, height: 800 })).toBeCloseTo(0.5)
    expect(fitZoom({ width: 500, height: 2000 }, { width: 1000, height: 1064 })).toBeCloseTo(0.5)
    expect(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 800 })).toBe(1)
    expect(fitZoom({ width: 0, height: 100 }, { width: 1000, height: 800 })).toBe(1)
    expect(fitZoom({ width: 100, height: 0 }, { width: 1000, height: 800 })).toBe(1)
  })

  it('writes the zoom as a percentage, and names every command', () => {
    expect(zoomLabel(0.456)).toBe('46%')
    for (const what of ['zoom-out', 'zoom-in', 'fit', 'tidy']) {
      expect(boardToolsHtml()).toContain(`data-board="${what}"`)
    }
  })

  it('lays the layers out in a row under the root, and their leaves down each column', () => {
    const tree = {
      id: 'r',
      w: 200,
      h: 50,
      children: [
        {
          id: 'a',
          w: 100,
          h: 40,
          children: [
            { id: 'a1', w: 150, h: 20, children: [] },
            { id: 'gone', w: 0, h: 0, children: [] },
            { id: 'a2', w: 80, h: 30, children: [] },
          ],
        },
        { id: 'b', w: 120, h: 40, children: [] },
        { id: 'empty', w: 0, h: 0, children: [] },
      ],
    }
    const boxes = layoutTree(tree)
    const row = TREE.indent + 150 + TREE.columnGap + 120
    expect(boxes.get('r')).toEqual({ x: (row - 200) / 2, y: 0, w: 200, h: 50 })
    const y = 50 + TREE.rootGap
    expect(boxes.get('a')).toEqual({ x: 0, y, w: 100, h: 40 })
    expect(boxes.get('a1')).toEqual({ x: TREE.indent, y: y + 40 + TREE.leafGap, w: 150, h: 20 })
    // A leaf of no height takes no room.
    expect(boxes.has('gone')).toBe(false)
    expect(boxes.get('a2')?.y).toBe(y + 40 + TREE.leafGap + 20 + TREE.leafGap)
    expect(boxes.get('b')?.x).toBe(TREE.indent + 150 + TREE.columnGap)
    expect(boxes.has('empty')).toBe(false)
  })

  it('centers a row narrower than the root under it, and moves a node and what hangs from it', () => {
    const tree = {
      id: 'r',
      w: 600,
      h: 50,
      children: [{ id: 'a', w: 100, h: 40, children: [{ id: 'a1', w: 50, h: 20, children: [] }] }],
    }
    const plain = layoutTree(tree)
    expect(plain.get('r')?.x).toBe(0)
    expect(plain.get('a')?.x).toBe(250)
    const moved = layoutTree(
      tree,
      new Map([
        ['r', { dx: 10, dy: 5 }],
        ['a', { dx: 100, dy: 0 }],
        ['a1', { dx: 0, dy: 30 }],
      ])
    )
    expect(moved.get('r')?.x).toBe(10)
    expect(moved.get('a')?.x).toBe(360)
    expect(moved.get('a1')?.x).toBe(360 + TREE.indent)
    expect(moved.get('a1')?.y).toBe((plain.get('a1')?.y ?? 0) + 35)
  })

  it('draws a line down from the root to a layer, and across from a layer to a leaf', () => {
    expect(edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 200, y: 100, w: 60, h: 20 }, true)).toBe(
      'M50 40V70H230V100'
    )
    expect(edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 28, y: 50, w: 60, h: 100 }, false)).toBe(
      `M${TREE.indent / 2} 40V68H28`
    )
    expect(edgePath({ x: 0, y: 0, w: 100, h: 40 }, { x: 28, y: 50, w: 60, h: 20 }, false)).toBe(
      `M${TREE.indent / 2} 40V60H28`
    )
  })

  it('finds the box around boxes, or none for no box', () => {
    expect(
      boundsOf([
        { x: 10, y: 20, w: 100, h: 50 },
        { x: -5, y: 40, w: 50, h: 100 },
      ])
    ).toEqual({ left: -5, top: 20, right: 110, bottom: 140 })
    expect(boundsOf([])).toBeNull()
  })

  it('reads back the offsets it wrote, and nothing it cannot read', () => {
    const s = storage()
    writeOffsets(s, '/r/a', new Map([['n', { dx: 1, dy: 2 }]]))
    expect(readOffsets(s, '/r/a')).toEqual(new Map([['n', { dx: 1, dy: 2 }]]))
    writeOffsets(s, '/r/a', new Map())
    expect(stored.size).toBe(0)
    stored.set('pr-review.board:/bad', '{nope')
    expect(readOffsets(s, '/bad').size).toBe(0)
    stored.set(
      'pr-review.board:/junk',
      JSON.stringify({ a: { dx: 'x', dy: 1 }, b: null, c: { dx: 3, dy: 4 } })
    )
    expect(readOffsets(s, '/junk')).toEqual(new Map([['c', { dx: 3, dy: 4 }]]))
    stored.set('pr-review.board:/number', '7')
    expect(readOffsets(s, '/number').size).toBe(0)
    expect(readOffsets(null, '/r/a').size).toBe(0)
    const broken = /** @type {Storage} */ (
      /** @type {unknown} */ ({
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      })
    )
    expect(readOffsets(broken, '/r/a').size).toBe(0)
    expect(() => writeOffsets(broken, '/r/a', new Map([['n', { dx: 1, dy: 2 }]]))).not.toThrow()
  })
})

describe('initBoard', () => {
  it('does nothing in the other views', () => {
    board = open('all')
    expect(root.querySelector('.board-plane')).toBeNull()
    board.setZoom(0.5)
    expect(board.zoom()).toBe(1)
  })

  it('puts the review on a tree: the pull request at the root, its layers, and their points', () => {
    board = open('board')
    expect(main().classList.contains('board')).toBe(true)
    expect(Array.from(main().children, el => el.className)).toEqual([
      'stale-bar outdated-bar',
      'board-viewport',
      'board-tools',
      'b-filepanel',
    ])
    // Files have no nodes: the reader reviews the points.
    const nodes = Array.from(root.querySelectorAll('.bnode'), el => el.getAttribute('data-node'))
    expect(nodes).toEqual(['root', 'layer-auth', 'point-a', 'point-gone', 'layer-store'])
    // The header's title block moves onto the root, and the header keeps its bar.
    expect(node('root').querySelector('.hdr-title h1')?.textContent).toBe('#42Fix the widget')
    expect(node('root').querySelector('.hdr-title .meta')?.textContent).toBe('by ana')
    expect(root.querySelector('header .hdr-title')).toBeNull()
    expect(root.querySelector('header .hdr-bar')).not.toBeNull()
    expect(node('root').querySelector('#overview')).not.toBeNull()
    // On the root the overview's heading is the Details that open the rest of it.
    expect(node('root').querySelector('#overview > .panel-h h2')?.textContent).toBe('Details')
    expect(node('layer-auth').querySelector('pr-layer #layer-auth')).not.toBeNull()
    expect(node('point-a').querySelector('ol.findings > #point-a')).not.toBeNull()
    expect(node('layer-auth').querySelector('.files #file-auth')).not.toBeNull()
    // Every node starts as its title; a layer shows its rationale under it too.
    expect(bodyOf('file-auth').hidden).toBe(true)
    expect(bodyOf('layer-auth').hidden).toBe(true)
    expect(root.querySelector('#layer-auth > .layer-h + .rationale')?.textContent).toBe('why')
    expect(root.querySelector('#layer-auth .layer-body .judgment')).not.toBeNull()
    // A line from the root to each layer. A closed layer keeps its points off the board.
    expect(root.querySelectorAll('.board-lines .b-trunk')).toHaveLength(2)
    expect(root.querySelectorAll('.board-lines .b-edge:not(.b-trunk)')).toHaveLength(0)
    expect(node('point-a').hidden).toBe(true)
    // Opened, a layer shows them, with a line to each that shows.
    openAuth()
    expect(node('point-a').hidden).toBe(false)
    expect(root.querySelectorAll('.board-lines .b-edge:not(.b-trunk)')).toHaveLength(1)
    // The page is as tall as the window, also after the window resizes.
    const layout = /** @type {HTMLElement} */ (root.querySelector('.layout'))
    layout.style.removeProperty('--board-h')
    window.dispatchEvent(new Event('resize'))
    expect(layout.style.getPropertyValue('--board-h')).not.toBe('')
  })

  it('opens on the root, in the middle of the window, also when the URL names a target', () => {
    board = open('board')
    // The root is 560 by 80; the window's room is 600 by 400 less 32 on each side.
    const fitted = board.zoom()
    expect(fitted).toBeCloseTo((600 - 64) / 560)
    const [rx, ry] = at(node('root'))
    expect(viewport().scrollLeft).toBeCloseTo((rx + 280) * fitted - 300)
    expect(viewport().scrollTop).toBeCloseTo((ry + 40) * fitted - 200)
    const scroll = [viewport().scrollLeft, viewport().scrollTop]
    board.stop()
    // The deep links take the reader on to the target after this; the board starts the same.
    window.location.hash = '#layer-auth'
    board = open('board')
    expect(board.zoom()).toBe(fitted)
    expect([viewport().scrollLeft, viewport().scrollTop]).toEqual(scroll)
    // A link to something outside every layer is the same.
    board.stop()
    window.location.hash = '#overview'
    board = open('board')
    expect(board.zoom()).toBe(fitted)
  })

  it('leaves a screen with no overview alone, and a page with no main', () => {
    main().innerHTML = '<section id="empty-state"></section>'
    board = open('board')
    expect(root.querySelector('.board-plane')).toBeNull()
    board.stop()
    main().remove()
    board = open('board')
    expect(root.querySelector('.board-plane')).toBeNull()
  })

  it('names a layer that has no section by its place, and builds a root with no title block', () => {
    root.querySelector('header')?.remove()
    root.querySelector('#overview > .panel-h')?.remove()
    main().insertAdjacentHTML('beforeend', '<pr-layer></pr-layer>')
    board = open('board')
    expect(node('layer-2')).not.toBeNull()
    expect(node('root').querySelector('.hdr-title')).toBeNull()
    expect(node('root').querySelector('#overview')).not.toBeNull()
  })

  it('zooms with its buttons, and tidies what the reader moved', () => {
    window.location.hash = '#layer-auth'
    stored.set(KEY(), JSON.stringify({ 'layer-store': { dx: 50, dy: 0 } }))
    board = open('board')
    board.setZoom(1)
    const moved = at(node('layer-store'))[0]
    press('zoom-out')
    expect(board.zoom()).toBeCloseTo(0.8)
    expect(readout()).toBe('80%')
    press('zoom-in')
    expect(board.zoom()).toBeCloseTo(1)
    press('fit')
    expect(board.zoom()).toBeLessThan(1)
    board.setZoom(1)
    press('tidy')
    expect(at(node('layer-store'))[0]).toBe(moved - 50)
    expect(stored.size).toBe(0)
    // A click on the toolbar but on no button changes nothing.
    root.querySelector('.board-tools')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(board.zoom()).toBe(1)
  })

  it('zooms only for a wheel with the control or command key, and leaves a plain wheel to scroll', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    board.setZoom(1)
    const plain = wheel({ deltaY: 100 })
    viewport().dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(false)
    expect(board.zoom()).toBe(1)
    const pinch = wheel({ deltaY: 100, metaKey: true, clientX: 500, clientY: 500 })
    viewport().dispatchEvent(pinch)
    expect(pinch.defaultPrevented).toBe(true)
    expect(board.zoom()).toBeLessThan(1)
    viewport().dispatchEvent(wheel({ deltaY: -100, ctrlKey: true, clientX: 500, clientY: 500 }))
    expect(board.zoom()).toBeCloseTo(1, 1)
  })

  it('opens the root, a layer, and a point in place on a click, and the tree makes room', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    expect(bodyOf('layer-auth').hidden).toBe(false)
    const storeX = at(node('layer-store'))[0]
    click(node('root').querySelector('.hdr-title h1'))
    expect(node('root').classList.contains('is-open')).toBe(true)
    // The links in the title block go where they lead, and open nothing.
    click(node('root').querySelector('.hdr-title a'))
    expect(node('root').classList.contains('is-open')).toBe(true)
    click(node('root').querySelector('#overview .panel-h'))
    expect(node('root').classList.contains('is-open')).toBe(false)
    click(node('point-a').querySelector('.p-title'))
    expect(node('point-a').classList.contains('is-open')).toBe(true)
    // A link in a point goes where it leads, and opens nothing.
    click(node('point-a').querySelector('.loc'))
    expect(node('point-a').classList.contains('is-open')).toBe(true)
    resized?.()
    pendingFrame?.(0)
    // The open point is 760 wide, so the next column moves over.
    expect(at(node('layer-store'))[0]).toBeGreaterThan(storeX)
    // A click on the body of a node opens nothing more, nor does one on the empty plane.
    click(node('point-a').querySelector('.prose'))
    click(root.querySelector('.board-plane'))
    expect(node('point-a').classList.contains('is-open')).toBe(true)
  })

  it('brings a layer it opens into view at full size, centered, and does not move it when it closes', () => {
    board = open('board')
    const clicked = vi.fn()
    root.addEventListener('click', clicked)
    // The layer is 560 by 60 and its point 300 by 50: 560 by 120 with the gap.
    const event = openAuth()
    expect(event.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    expect(bodyOf('layer-auth').hidden).toBe(false)
    expect(board.zoom()).toBe(1)
    const z = board.zoom()
    const [lx, ly] = at(node('layer-auth'))
    // 120 high fits the 400 of the window, so it is centered down; 560 wide does not fit the 600
    // with the margins, so it starts at its left.
    expect(viewport().scrollTop).toBeCloseTo(ly + 60 - 200)
    expect(viewport().scrollLeft).toBeCloseTo(lx - 32)
    // Closed again, it stays where it is.
    const scroll = [viewport().scrollLeft, viewport().scrollTop]
    openAuth()
    expect(bodyOf('layer-auth').hidden).toBe(true)
    expect(board.zoom()).toBe(z)
    expect([viewport().scrollLeft, viewport().scrollTop]).toEqual(scroll)
  })

  it('brings a layer too big for the window into view from its top left, still at full size', () => {
    board = open('board')
    node('point-a').classList.add('is-open')
    // The chevron opens the layer too. With its point open it is 788 by 190.
    click(node('layer-auth').querySelector('.layer-h > .chev'))
    expect(bodyOf('layer-auth').hidden).toBe(false)
    expect(board.zoom()).toBe(1)
    const [lx, ly] = at(node('layer-auth'))
    expect(viewport().scrollLeft).toBeCloseTo(lx - 32)
    expect(viewport().scrollTop).toBeCloseTo(ly + 95 - 200)
  })

  it('brings the Other layer into view once its details open, and nothing else that toggles', () => {
    main().insertAdjacentHTML(
      'beforeend',
      '<pr-layer><section class="panel" id="layer-other"><details><summary>Other</summary><div class="body"><details id="inner"><summary>more</summary></details></div></details></section></pr-layer>'
    )
    board = open('board')
    board.setZoom(0.3)
    const inner = /** @type {HTMLDetailsElement} */ (root.querySelector('#inner'))
    inner.open = true
    inner.dispatchEvent(new Event('toggle'))
    expect(board.zoom()).toBeCloseTo(0.3)
    const details = /** @type {HTMLDetailsElement} */ (root.querySelector('#layer-other > details'))
    details.open = false
    details.dispatchEvent(new Event('toggle'))
    expect(board.zoom()).toBeCloseTo(0.3)
    details.open = true
    details.dispatchEvent(new Event('toggle'))
    expect(board.zoom()).toBe(1)
    // A toggle outside every layer changes nothing.
    board.setZoom(0.3)
    const loose = document.createElement('details')
    root.querySelector('.board-plane')?.append(loose)
    loose.open = true
    loose.dispatchEvent(new Event('toggle'))
    expect(board.zoom()).toBeCloseTo(0.3)
  })

  it('zooms in to a node clicked while zoomed out, and the click does nothing else', () => {
    board = open('board')
    board.setZoom(FAR_ZOOM / 2)
    const clicked = vi.fn()
    root.addEventListener('click', clicked)
    const event = click(node('root').querySelector('.hdr-title h1'))
    expect(event.defaultPrevented).toBe(true)
    expect(clicked).not.toHaveBeenCalled()
    expect(board.zoom()).toBe(1)
    expect(node('root').classList.contains('is-open')).toBe(false)
    expect(viewport().scrollLeft).toBe(at(node('root'))[0] - 24)
    // A click on a layer's title opens the layer even from far out, and brings it into view.
    board.setZoom(FAR_ZOOM / 2)
    openAuth()
    expect(bodyOf('layer-auth').hidden).toBe(false)
    expect(board.zoom()).toBe(1)
  })

  it('drags a layer with its points, saves where it went, and eats the click that ends it', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    board.setZoom(1)
    const handle = node('layer-auth').querySelector('.layer-h h2')
    const [lx, ly] = fromRoot('layer-auth')
    const [px] = fromRoot('point-a')
    const [sx] = fromRoot('layer-store')
    const scroll = viewport().scrollLeft
    pointer('pointerdown', handle, { clientX: 100, clientY: 100 })
    // A small wobble is still a click.
    pointer('pointermove', handle, { clientX: 102, clientY: 101 })
    expect(main().classList.contains('is-dragging')).toBe(false)
    // Another pointer moves nothing.
    pointer('pointermove', handle, { pointerId: 2, clientX: 900, clientY: 900 })
    pointer('pointermove', handle, { clientX: 140, clientY: 160 })
    expect(main().classList.contains('is-dragging')).toBe(true)
    expect(fromRoot('layer-auth')).toEqual([lx + 40, ly + 60])
    expect(fromRoot('point-a')[0]).toBe(px + 40)
    expect(fromRoot('layer-store')[0]).toBe(sx)
    // The tree's left edge moved right, so the room around it shrank, and the scroll with it.
    expect(viewport().scrollLeft).toBe(scroll - 40)
    pointer('pointerup', handle, { pointerId: 2 })
    expect(main().classList.contains('is-dragging')).toBe(true)
    pointer('pointerup', handle, { clientX: 140, clientY: 160 })
    expect(main().classList.contains('is-dragging')).toBe(false)
    expect(JSON.parse(stored.get(KEY()) ?? '{}')).toEqual({ 'layer-auth': { dx: 40, dy: 60 } })
    // The click that ends the drag does not close the layer; the next one does.
    expect(click(handle).defaultPrevented).toBe(true)
    expect(bodyOf('layer-auth').hidden).toBe(false)
    click(handle)
    expect(bodyOf('layer-auth').hidden).toBe(true)
  })

  it('drags a leaf alone, and not from its controls or its body; a cancelled drag eats no click', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    board.setZoom(1)
    const [px] = fromRoot('point-a')
    const [lx, ly] = fromRoot('layer-auth')
    const title = node('point-a').querySelector('.f-title')
    pointer('pointerdown', title, { clientX: 0, clientY: 0 })
    pointer('pointermove', title, { clientX: 30, clientY: 0 })
    pointer('pointercancel', title, {})
    expect(fromRoot('point-a')[0]).toBe(px + 30)
    expect(fromRoot('layer-auth')).toEqual([lx, ly])
    const clicked = vi.fn()
    root.addEventListener('click', clicked)
    click(title)
    expect(clicked).toHaveBeenCalledTimes(1)
    // A press on the checkbox in a layer's title bar is the checkbox's.
    const box = node('layer-auth').querySelector('input')
    pointer('pointerdown', box, { clientX: 0, clientY: 0 })
    pointer('pointermove', box, { clientX: 50, clientY: 0 })
    expect(main().classList.contains('is-dragging')).toBe(false)
    pointer('pointerup', box, {})
    // A press on a node's body, outside its title bar, does not drag either.
    const prose = node('point-a').querySelector('.prose')
    pointer('pointerdown', prose, { clientX: 0, clientY: 0 })
    pointer('pointermove', prose, { clientX: 50, clientY: 0 })
    expect(main().classList.contains('is-dragging')).toBe(false)
  })

  it('pans with a drag on the empty board, or with the middle button anywhere', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    const vp = viewport()
    vp.scrollLeft = 500
    vp.scrollTop = 300
    pointer('pointerdown', root.querySelector('.board-plane'), { clientX: 400, clientY: 400 })
    expect(main().classList.contains('is-panning')).toBe(true)
    pointer('pointermove', vp, { clientX: 300, clientY: 350 })
    expect([vp.scrollLeft, vp.scrollTop]).toEqual([600, 350])
    pointer('pointerup', vp, {})
    expect(main().classList.contains('is-panning')).toBe(false)
    pointer('pointermove', vp, { clientX: 0, clientY: 0 })
    expect([vp.scrollLeft, vp.scrollTop]).toEqual([600, 350])
    pointer('pointerdown', node('point-a').querySelector('.prose'), { button: 1, clientX: 0, clientY: 0 })
    expect(main().classList.contains('is-panning')).toBe(true)
    pointer('pointerup', vp, {})
  })

  it('opens a point a scroll lands on, and a file in the side panel, zoomed in first', () => {
    board = open('board')
    board.setZoom(FAR_ZOOM / 2)
    root.querySelector('#point-a')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(board.zoom()).toBeGreaterThan(FAR_ZOOM)
    // The closed layer opens, so the point is on the board, and the point opens.
    expect(bodyOf('layer-auth').hidden).toBe(false)
    expect(node('point-a').classList.contains('is-open')).toBe(true)
    // A point in an open layer leaves the layer open.
    root.querySelector('#point-a')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(bodyOf('layer-auth').hidden).toBe(false)
    // A file has no node: a scroll to a row opens its card in the panel, open to the row.
    const panel = /** @type {HTMLElement} */ (root.querySelector('.b-filepanel'))
    expect(panel.hidden).toBe(true)
    board.setZoom(FAR_ZOOM / 2)
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    // Zoomed back in, and the point in focus as far as it fits beside the panel.
    expect(board.zoom()).toBeGreaterThan(FAR_ZOOM)
    expect(panel.hidden).toBe(false)
    expect(panel.querySelector('#file-auth')).not.toBeNull()
    expect(bodyOf('file-auth').hidden).toBe(false)
    // Another scroll into the panel's file keeps it there.
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(panel.querySelector('#file-auth')).not.toBeNull()
    // Another file takes its place; the first goes back to its layer.
    root.querySelector('#file-store')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(panel.querySelector('#file-store')).not.toBeNull()
    expect(bodyOf('file-store').hidden).toBe(false)
    expect(root.querySelector('#layer-auth .files > pr-file > #file-auth')).not.toBeNull()
    // Closing the panel puts its file back.
    press('close-file')
    expect(panel.hidden).toBe(true)
    expect(root.querySelector('#layer-store .files > pr-file > #file-store')).not.toBeNull()
    // A scroll to something off the board changes nothing.
    board.setZoom(0.2)
    root.querySelector('.stale-bar')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(board.zoom()).toBeCloseTo(0.2)
    // The point the scroll landed on is in focus, until the board goes.
    expect(main().classList.contains('has-focus')).toBe(true)
    board.setView('all')
    expect(main().classList.contains('has-focus')).toBe(false)
  })

  it('lays the tree out again on the next frame after a node changes size', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    const storeX = at(node('layer-store'))[0]
    node('point-a').classList.add('is-open')
    const frames = vi.mocked(window.requestAnimationFrame).mock.calls.length
    resized?.()
    resized?.()
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(frames + 1)
    pendingFrame?.(0)
    expect(at(node('layer-store'))[0]).toBeGreaterThan(storeX)
    // A frame that waited past the board going away changes nothing.
    resized?.()
    board.setView('all')
    expect(() => pendingFrame?.(0)).not.toThrow()
  })

  it('opens the details of the Other layer for a scroll to one of its points', () => {
    main().insertAdjacentHTML(
      'beforeend',
      '<pr-layer><section class="panel" id="layer-other"><details><summary>Other</summary><ol class="findings"><li class="finding" id="point-o" data-point="o" data-status="open"><div><div class="f-title">O</div></div></li></ol></details></section></pr-layer>'
    )
    board = open('board')
    expect(node('point-o').hidden).toBe(true)
    root.querySelector('#point-o')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(/** @type {HTMLDetailsElement} */ (root.querySelector('#layer-other details')).open).toBe(true)
    expect(node('point-o').hidden).toBe(false)
  })

  it('puts everything back for another view, and says the board changed', () => {
    const changes = vi.fn()
    root.addEventListener('board-change', changes)
    board = open('board')
    expect(changes).toHaveBeenCalledTimes(1)
    board.setView('one')
    expect(changes).toHaveBeenCalledTimes(2)
    expect(root.querySelector('.board-viewport')).toBeNull()
    expect(Array.from(main().children, el => el.id || el.tagName.toLowerCase())).toEqual([
      'div',
      'overview',
      'pr-layer',
      'pr-layer',
    ])
    expect(root.querySelector('#layer-auth .findings > #point-a')).not.toBeNull()
    expect(root.querySelector('#layer-auth .findings > #point-gone')).not.toBeNull()
    expect(root.querySelector('#layer-auth .files > pr-file > #file-auth')).not.toBeNull()
    expect(root.querySelector('.b-progress, .b-filepanel')).toBeNull()
    expect(root.querySelector('#layer-auth > .layer-body > .body > .rationale + .judgment')).not.toBeNull()
    expect(root.querySelector('header > .hdr-bar + .hdr-title')).not.toBeNull()
    expect(root.querySelector('#overview > .panel-h h2')?.textContent).toBe('Overview')
    // What the reader had open opens again; what was closed stays closed.
    expect(bodyOf('file-auth').hidden).toBe(false)
    expect(bodyOf('layer-auth').hidden).toBe(false)
    expect(bodyOf('layer-store').hidden).toBe(true)
    expect(main().className).toBe('')
    expect(root.querySelector('.layout')?.getAttribute('style') ?? '').not.toContain('--board-h')
    board.setView('one')
    board.setView('board')
    expect(root.querySelectorAll('.bnode')).toHaveLength(5)
    board.setView('board')
    expect(root.querySelectorAll('.board-viewport')).toHaveLength(1)
  })

  it('puts a new render on a new tree, at the zoom and place the reader left', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    board.setZoom(0.8)
    viewport().scrollLeft = 400
    viewport().dispatchEvent(new Event('scroll'))
    root.innerHTML = PAGE
    board.redraw()
    expect(root.querySelectorAll('.bnode')).toHaveLength(5)
    expect(board.zoom()).toBeCloseTo(0.8)
    expect(viewport().scrollLeft).toBeCloseTo(400)
    const before = viewport()
    board.redraw()
    expect(viewport()).toBe(before)
  })

  it('works without ResizeObserver, and stops listening once stopped', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    board = open('board')
    expect(root.querySelectorAll('.bnode')).toHaveLength(5)
    board.stop()
    expect(root.querySelector('.board-plane')).toBeNull()
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    board = undefined
  })

  it('reads the browser storage when it is not given one', () => {
    window.localStorage.setItem(KEY(), JSON.stringify({ 'layer-store': { dx: 70, dy: 0 } }))
    window.location.hash = '#layer-auth'
    board = initBoard(root, { view: 'board' })
    const moved = at(node('layer-store'))[0]
    press('tidy')
    expect(at(node('layer-store'))[0]).toBeCloseTo(moved - 70)
    expect(window.localStorage.getItem(KEY())).toBeNull()
  })
})

describe('the points a layer is reviewed through', () => {
  it('counts the points done in each layer, and marks a layer with none open as done', async () => {
    board = open('board')
    const progress = () => Array.from(root.querySelectorAll('.b-progress'), el => el.textContent)
    // Auth has an open point and a resolved one; Store has none, and keeps its own reviewed box.
    expect(progress()).toEqual(['1/2 points', 'no attention points'])
    expect(node('layer-auth').classList.contains('is-done')).toBe(false)
    expect(node('layer-store').classList.contains('no-points')).toBe(true)
    // Dismissing the open point finishes the layer, on the next frame after the status changes.
    root.querySelector('#point-a')?.setAttribute('data-status', 'dismissed')
    await settle()
    pendingFrame?.(0)
    expect(progress()[0]).toBe('2/2 points')
    expect(node('layer-auth').classList.contains('is-done')).toBe(true)
  })

  it('counts a point with no status as open', () => {
    root.querySelector('#point-a')?.removeAttribute('data-status')
    board = open('board')
    expect(root.querySelector('.b-progress')?.textContent).toBe('1/2 points')
  })
})

describe('the point in focus', () => {
  /** @returns {boolean} */
  const focused = () => main().classList.contains('has-focus')

  it('fades the rest of the board while a point is open, and ends on a close or a click elsewhere', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    const title = node('point-a').querySelector('.p-title')
    click(title)
    expect(focused()).toBe(true)
    expect(node('point-a').classList.contains('is-focus')).toBe(true)
    // A click inside the point keeps the focus.
    click(node('point-a').querySelector('.prose'))
    expect(focused()).toBe(true)
    // Closing the point ends it.
    click(title)
    expect(focused()).toBe(false)
    expect(node('point-a').classList.contains('is-focus')).toBe(false)
    // So does a click on another node, which still does what it does.
    click(title)
    click(node('root').querySelector('.hdr-title h1'))
    expect(focused()).toBe(false)
    expect(node('root').classList.contains('is-open')).toBe(true)
    // And a click on the empty board.
    click(title)
    click(title)
    expect(focused()).toBe(true)
    click(root.querySelector('.board-plane'))
    expect(focused()).toBe(false)
  })

  it('ends on Escape, and keeps through a pan of the board', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    const plane = root.querySelector('.board-plane')
    pointer('pointerdown', plane, { clientX: 400, clientY: 400 })
    pointer('pointermove', viewport(), { clientX: 300, clientY: 350 })
    pointer('pointerup', viewport(), {})
    click(plane)
    expect(focused()).toBe(true)
    // A key other than Escape changes nothing.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(focused()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(focused()).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(focused()).toBe(false)
  })
})

describe('a scroll to a layer', () => {
  it('brings the layer into view on the next frame, as when the reader opens it', () => {
    board = open('board')
    const fitted = board.zoom()
    expect(fitted).toBeLessThan(1)
    root.querySelector('#layer-auth')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    pendingFrame?.(0)
    expect(board.zoom()).toBe(1)
    const [lx, ly] = at(node('layer-auth'))
    // Closed, it is 300 by 60: it fits the window, so it is centered both ways.
    expect(viewport().scrollLeft).toBeCloseTo(lx + 150 - 300)
    expect(viewport().scrollTop).toBeCloseTo(ly + 30 - 200)
    // Once the board is gone, the frame does nothing.
    root.querySelector('#layer-auth')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    board.setView('all')
    expect(() => pendingFrame?.(0)).not.toThrow()
    expect(root.querySelector('.board-viewport')).toBeNull()
  })
})

describe('the moves the board makes', () => {
  it('glides to a layer it opens: the zoom and the view step there over a few frames', () => {
    window.location.hash = '#layer-auth'
    board = initBoard(root, { view: 'board', storage: storage(), smooth: true })
    board.setZoom(0.4)
    const scroll = viewport().scrollLeft
    openAuth()
    // The move starts where the board was, and the board says it is moving.
    expect(board.zoom()).toBeCloseTo(0.4)
    expect(viewport().scrollLeft).toBeCloseTo(scroll)
    expect(main().classList.contains('is-moving')).toBe(true)
    pendingFrame?.(1000)
    expect(board.zoom()).toBeCloseTo(0.4)
    pendingFrame?.(1000 + MOVE_MS / 2)
    expect(board.zoom()).toBeGreaterThan(0.4)
    expect(board.zoom()).toBeLessThan(1)
    pendingFrame?.(1000 + MOVE_MS)
    expect(board.zoom()).toBe(1)
    expect(main().classList.contains('is-moving')).toBe(false)
    // It ends where the jump would have.
    const [lx] = at(node('layer-auth'))
    expect(viewport().scrollLeft).toBeCloseTo(lx - 32)
  })

  it('stops a move when the reader turns the wheel or presses on the board', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    board = initBoard(root, { view: 'board', storage: storage(), smooth: true })
    press('fit')
    viewport().dispatchEvent(wheel({ deltaY: 10 }))
    expect(cancel).toHaveBeenCalledWith(7)
    cancel.mockClear()
    press('fit')
    pointer('pointerdown', root.querySelector('.board-plane'), { clientX: 0, clientY: 0 })
    expect(cancel).toHaveBeenCalledWith(7)
    pointer('pointerup', viewport(), {})
    // With no move under way, there is nothing to stop.
    cancel.mockClear()
    viewport().dispatchEvent(wheel({ deltaY: 10 }))
    expect(cancel).not.toHaveBeenCalled()
  })

  it('jumps for a reader who asked for less motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(/** @type {MediaQueryList} */ ({ matches: true }))
    board = initBoard(root, { view: 'board', storage: storage() })
    board.setZoom(0.4)
    openAuth()
    expect(board.zoom()).toBe(1)
  })

  it('glides by default when the browser has no motion setting to read', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(/** @type {MediaQueryList} */ ({ matches: false }))
    board = initBoard(root, { view: 'board', storage: storage() })
    board.setZoom(0.4)
    openAuth()
    expect(board.zoom()).toBeCloseTo(0.4)
  })

  it('brings a point it opens into the middle of the board, zoomed in a little', () => {
    // A window wide enough for the point at the point's zoom.
    fake('clientWidth', el => (el.matches('.board-viewport') ? 2000 : 0))
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    board.setZoom(0.8)
    click(node('point-a').querySelector('.p-title'))
    expect(board.zoom()).toBeCloseTo(POINT_ZOOM)
    // Open, the point is 760 by 120, which fits at that zoom: it is centered.
    const [px, py] = at(node('point-a'))
    expect(viewport().scrollLeft).toBeCloseTo((px + 380) * POINT_ZOOM - 1000)
    expect(viewport().scrollTop).toBeCloseTo((py + 60) * POINT_ZOOM - 200)
    // A reader zoomed in further stays as close.
    click(node('point-a').querySelector('.p-title'))
    board.setZoom(1.6)
    click(node('point-a').querySelector('.p-title'))
    expect(board.zoom()).toBeCloseTo(1.6)
  })

  it('zooms a point in only as far as it fits the window', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    // 760 wide in the 536 of room.
    expect(board.zoom()).toBeCloseTo(536 / 760)
  })

  it('stops a move when a render replaces the board, and when the board goes', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    board = initBoard(root, { view: 'board', storage: storage(), smooth: true })
    press('fit')
    root.innerHTML = PAGE
    board.redraw()
    expect(cancel).toHaveBeenCalledWith(7)
    cancel.mockClear()
    press('fit')
    board.setView('all')
    expect(cancel).toHaveBeenCalledWith(7)
  })
})

describe('moving on after the reader acts on a point', () => {
  /** Two more open points: one after A in Auth, and one in Store. */
  const morePoints = () => {
    root
      .querySelector('#point-a')
      ?.insertAdjacentHTML(
        'afterend',
        '<li class="finding" id="point-b" data-point="b" data-status="open"><div><div class="f-title"><span class="p-title">Check B</span></div></div></li>'
      )
    root
      .querySelector('#layer-store .layer-body')
      ?.insertAdjacentHTML(
        'afterbegin',
        '<div class="layer-points"><ol class="findings"><li class="finding" id="point-c" data-point="c" data-status="open"><div><div class="f-title"><span class="p-title">Check C</span></div></div></li></ol></div>'
      )
  }
  /** @param {string} id @param {string} status */
  const mark = (id, status) => root.querySelector(`#${id}`)?.setAttribute('data-status', status)
  const focusedId = () => root.querySelector('.bnode.is-focus')?.getAttribute('data-node') ?? null

  it('opens the next open point in the layer, then the first in the next layer, closing the one done', async () => {
    morePoints()
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 0 })
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    expect(focusedId()).toBe('point-a')
    mark('point-a', 'dismissed')
    await settle()
    expect(focusedId()).toBe('point-b')
    expect(node('point-a').classList.contains('is-open')).toBe(false)
    expect(node('point-b').classList.contains('is-open')).toBe(true)
    // The last point of Auth done, Auth closes and Store opens on its point.
    mark('point-b', 'queued')
    await settle()
    expect(focusedId()).toBe('point-c')
    expect(bodyOf('layer-auth').hidden).toBe(true)
    expect(bodyOf('layer-store').hidden).toBe(false)
    expect(node('point-c').hidden).toBe(false)
  })

  it('says so and shows the whole tree once no point is left open', async () => {
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 0 })
    openAuth()
    board.setZoom(1)
    click(node('point-a').querySelector('.p-title'))
    mark('point-a', 'posted')
    await settle()
    expect(focusedId()).toBeNull()
    expect(main().classList.contains('has-focus')).toBe(false)
    expect(root.querySelector('.toast')?.textContent).toContain('Every attention point is reviewed')
    expect(board.zoom()).toBeLessThan(1)
  })

  it('goes back to a point the reader skipped, and closes the Other layer it leaves', async () => {
    main().insertAdjacentHTML(
      'beforeend',
      '<pr-layer><section class="panel" id="layer-other"><details><summary>Other</summary><ol class="findings"><li class="finding" id="point-o" data-point="o" data-status="open"><div><div class="f-title">O</div></div></li></ol></details></section></pr-layer>'
    )
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 0 })
    root.querySelector('#point-o')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(focusedId()).toBe('point-o')
    mark('point-o', 'dismissed')
    await settle()
    expect(focusedId()).toBe('point-a')
    expect(/** @type {HTMLDetailsElement} */ (root.querySelector('#layer-other details')).open).toBe(false)
    expect(bodyOf('layer-auth').hidden).toBe(false)
  })

  it('stays put for a change to another point, for a point reopened, or once the reader moved on', async () => {
    morePoints()
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 20 })
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    // A point not in focus.
    mark('point-b', 'dismissed')
    await settle()
    expect(focusedId()).toBe('point-a')
    // Back to open is no action on it.
    mark('point-b', 'open')
    await settle()
    expect(focusedId()).toBe('point-a')
    // The reader leaves the point before the board moves on.
    mark('point-a', 'dismissed')
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle(20)
    expect(focusedId()).toBeNull()
    expect(node('point-b').classList.contains('is-open')).toBe(false)
  })

  it('moves on after the default pause', async () => {
    morePoints()
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false })
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    mark('point-a', 'dismissed')
    await settle()
    expect(focusedId()).toBe('point-a')
    await settle(ADVANCE_MS)
    expect(focusedId()).toBe('point-b')
  })

  it('does nothing once the board is gone', async () => {
    morePoints()
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 10 })
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    mark('point-a', 'dismissed')
    await settle()
    board.setView('all')
    await settle(10)
    expect(root.querySelector('.bnode')).toBeNull()
  })
})

describe('the root while the board opens', () => {
  /** @param {number} height */
  const rootHeight = height => fake('offsetHeight', el => (el.matches('.b-root') ? height : size(el, 'h')))

  it('stays in view as it grows, until the reader moves the board', () => {
    board = open('board')
    const z = board.zoom()
    // A diagram drawn late makes the root taller than the window: it then shows from its top.
    rootHeight(900)
    resized?.()
    pendingFrame?.(0)
    const [, ry] = at(node('root'))
    expect(viewport().scrollTop).toBeCloseTo(ry * z - 32)
    // Once the reader turns the wheel, a change of size leaves the view where it is.
    viewport().dispatchEvent(wheel({ deltaY: 40 }))
    viewport().scrollTop = 5
    rootHeight(1200)
    resized?.()
    pendingFrame?.(0)
    expect(viewport().scrollTop).toBe(5)
  })

  it('is left where it is once the reader presses on the board, a key, or a zoom button', () => {
    for (const touch of [
      () => pointer('pointerdown', root.querySelector('.board-plane'), { clientX: 0, clientY: 0 }),
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })),
      () => press('zoom-in'),
    ]) {
      board?.stop()
      root.innerHTML = PAGE
      board = open('board')
      touch()
      pointer('pointerup', viewport(), {})
      viewport().scrollTop = 7
      resized?.()
      pendingFrame?.(0)
      expect(viewport().scrollTop).toBe(7)
    }
  })

  it('zooms the root down only for its width, never for its height', () => {
    rootHeight(5000)
    board = open('board')
    expect(board.zoom()).toBeCloseTo((600 - 64) / 560)
  })
})

describe('a layer whose points are all done', () => {
  /** The reviewed box of Auth's title bar, as the page draws it, and what a click on it saves. */
  const reviewedBox = () => {
    root
      .querySelector('#layer-auth .layer-h')
      ?.insertAdjacentHTML(
        'beforeend',
        '<div class="layer-ctl"><label class="chk"><input type="checkbox" data-reviewed-id="layer:auth"> reviewed</label></div>'
      )
    const box = /** @type {HTMLInputElement} */ (root.querySelector('[data-reviewed-id="layer:auth"]'))
    const changes = vi.fn()
    box.addEventListener('change', () => changes(box.checked))
    return { box, changes }
  }

  it('marks the layer reviewed, and clears the mark when a point opens again', async () => {
    const { box, changes } = reviewedBox()
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false, advanceMs: 10_000 })
    expect(box.checked).toBe(false)
    root.querySelector('#point-a')?.setAttribute('data-status', 'dismissed')
    await settle()
    pendingFrame?.(0)
    expect(box.checked).toBe(true)
    expect(changes).toHaveBeenLastCalledWith(true)
    // Drawn again with the box checked, the board does not click it twice.
    resized?.()
    pendingFrame?.(0)
    expect(changes).toHaveBeenCalledTimes(1)
    root.querySelector('#point-a')?.setAttribute('data-status', 'open')
    await settle()
    pendingFrame?.(0)
    expect(box.checked).toBe(false)
    expect(changes).toHaveBeenLastCalledWith(false)
  })

  it('leaves alone a mark the reader set themself', async () => {
    const { box, changes } = reviewedBox()
    box.checked = true
    board = initBoard(root, { view: 'board', storage: storage(), smooth: false })
    await settle()
    expect(box.checked).toBe(true)
    expect(changes).not.toHaveBeenCalled()
  })
})

describe('the side panel beside a point', () => {
  it('moves the point in focus beside the panel, into the part of the board it leaves free', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    // The panel takes 100 of the 600: the point zooms to fit the 436 of room left of it, and its
    // right edge stays clear of the panel.
    expect(root.querySelector('.b-filepanel')?.hasAttribute('hidden')).toBe(false)
    expect(board.zoom()).toBeCloseTo(436 / 760)
    const [px] = at(node('point-a'))
    const right = (px + 760) * board.zoom() - viewport().scrollLeft
    expect(right).toBeLessThanOrEqual(500)
  })

  it('leaves the board where it is when no point is in focus', () => {
    window.location.hash = '#layer-auth'
    board = open('board')
    viewport().scrollLeft = 123
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    expect(viewport().scrollLeft).toBe(123)
  })
})

describe('the points in the side panel', () => {
  it('fold to their titles: a click on one opens it, and closing the panel folds them again', () => {
    const point = document.createElement('tr')
    point.className = 'ifind'
    point.innerHTML =
      '<td class="code x"><div class="x-in"><div class="f-title"><span class="p-title">Check A</span><a class="loc" href="#line:src/auth.ts:4">src/auth.ts:4</a></div><div class="prose">body</div></div></td>'
    root.querySelector('#row-4')?.after(point)
    board = open('board')
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    const row = /** @type {HTMLElement} */ (root.querySelector('.b-filepanel tr.ifind'))
    expect(row.classList.contains('b-open')).toBe(false)
    click(row.querySelector('.p-title'))
    expect(row.classList.contains('b-open')).toBe(true)
    // A link in the title goes where it leads, and a click on the body folds nothing.
    click(row.querySelector('.loc'))
    click(row.querySelector('.prose'))
    expect(row.classList.contains('b-open')).toBe(true)
    click(row.querySelector('.p-title'))
    expect(row.classList.contains('b-open')).toBe(false)
    click(row.querySelector('.p-title'))
    press('close-file')
    expect(row.classList.contains('b-open')).toBe(false)
    // A click in the panel outside any point changes nothing.
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    click(root.querySelector('.b-filepanel-h'))
    expect(row.classList.contains('b-open')).toBe(false)
  })
})

describe('the file of the point in focus', () => {
  it('opens in the side panel at the point line, and closes once no point is in focus', () => {
    vi.mocked(followLink).mockClear()
    window.location.hash = '#layer-auth'
    board = open('board')
    openAuth()
    click(node('point-a').querySelector('.p-title'))
    expect(followLink).toHaveBeenCalledWith('#line:src/auth.ts:4', root)
    // The deep link lands on the row, which opens the panel; here it is raised by hand.
    root.querySelector('#row-4')?.dispatchEvent(new Event('reveal-code', { bubbles: true }))
    const panel = /** @type {HTMLElement} */ (root.querySelector('.b-filepanel'))
    expect(panel.hidden).toBe(false)
    // Focus held by the same point opens nothing again.
    click(node('point-a').querySelector('.prose'))
    expect(followLink).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(panel.hidden).toBe(true)
    expect(root.querySelector('#layer-auth .files > pr-file > #file-auth')).not.toBeNull()
  })
})
