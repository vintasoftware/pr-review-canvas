// @vitest-environment node
import {
  along,
  BEAT_MS,
  clockSpeed,
  DEFAULT_PALETTE,
  ease,
  ICONS,
  isSketchState,
  makeUi,
  stageFit,
  STAGE_H,
  STAGE_W,
  tick,
} from './sketch-kit.js'

/** A p5 stand-in that records the calls a kit helper makes. */
function recorder() {
  /** @type {Array<[string, unknown[]]>} */
  const calls = []
  const dash = /** @type {number[][]} */ ([])
  const p = new Proxy(
    {
      CLOSE: 'close',
      BOLD: 'bold',
      NORMAL: 'normal',
      LEFT: 'left',
      CENTER: 'center',
      RIGHT: 'right',
      ROUND: 'round',
      drawingContext: { setLineDash: (/** @type {number[]} */ d) => dash.push(d) },
    },
    {
      get(target, name) {
        if (name in target) return /** @type {any} */ (target)[name]
        return (/** @type {unknown[]} */ ...args) => calls.push([String(name), args])
      },
    }
  )
  return { p, calls, dash }
}

const opts = {
  side: /** @type {const} */ ('a'),
  still: false,
  palette: { ...DEFAULT_PALETTE, ink: '#123456' },
}

describe('stageFit', () => {
  it('scales the stage to fit whole and centers the spare room', () => {
    expect(stageFit(STAGE_W * 2, STAGE_H * 2)).toEqual({ scale: 2, dx: 0, dy: 0 })
    // A tall frame: width decides, and the stage sits in the middle vertically.
    expect(stageFit(400, 500)).toEqual({ scale: 1, dx: 0, dy: 100 })
    // A wide frame: height decides.
    expect(stageFit(1000, 300)).toEqual({ scale: 1, dx: 300, dy: 0 })
    // A frame with no size yet never scales to zero.
    expect(stageFit(0, 0).scale).toBe(0.01)
  })
})

describe('clockSpeed and tick', () => {
  it('runs faster the harder the author leans, and crawls on the side not picked', () => {
    expect(clockSpeed('idle', 1)).toBe(1)
    expect(clockSpeed('lean', 0.5)).toBeCloseTo(1.9)
    expect(clockSpeed('lean', 7)).toBeCloseTo(2.8)
    expect(clockSpeed('other', 0)).toBe(0.25)
  })

  it('advances the clock by real time, capped so a hidden tab does not jump ahead', () => {
    const ui = makeUi(recorder().p, opts)
    const clock = { clock: 0, last: 1000, pickedAt: /** @type {number | null} */ (null) }
    tick(ui, clock, 1050)
    expect(ui.t).toBeCloseTo(0.05)
    ui.state = 'lean'
    ui.lean = 1
    tick(ui, clock, 1100)
    expect(ui.t).toBeCloseTo(0.05 + 0.05 * 2.8)
    tick(ui, clock, 60_000)
    expect(ui.t).toBeCloseTo(0.05 + 0.05 * 2.8 + 0.1 * 2.8)
    expect(ui.beat).toBe(0)
    clock.pickedAt = 60_000
    tick(ui, clock, 60_000 + BEAT_MS / 2)
    expect(ui.beat).toBeCloseTo(0.5)
    tick(ui, clock, 60_000 + BEAT_MS * 3)
    expect(ui.beat).toBe(1)
  })

  it('holds a still sketch at its representative moment', () => {
    const ui = makeUi(recorder().p, { ...opts, still: true })
    const clock = { clock: 0, last: 0, pickedAt: /** @type {number | null} */ (null) }
    tick(ui, clock, 5000)
    expect(ui.t).toBe(1.2)
    expect(clock.clock).toBe(0)
    clock.pickedAt = 5000
    tick(ui, clock, 5001)
    expect(ui.beat).toBe(1)
  })

  it('knows the states the deck page may post', () => {
    expect(['idle', 'lean', 'picked', 'other'].every(isSketchState)).toBe(true)
    expect(isSketchState('run')).toBe(false)
    expect(isSketchState(1)).toBe(false)
  })
})

describe('motion helpers', () => {
  it('walks a polyline by length, not by point count', () => {
    const path = /** @type {const} */ ([
      [0, 0],
      [100, 0],
      [100, 300],
    ])
    expect(along(path, 0)).toEqual([0, 0])
    expect(along(path, 0.25)).toEqual([100, 0])
    expect(along(path, 0.5)).toEqual([100, 100])
    expect(along(path, 2)).toEqual([100, 300])
    expect(along([], 0.5)).toEqual([0, 0])
    expect(along([[5, 5]], 0.5)).toEqual([5, 5])
    expect(
      along(
        [
          [1, 1],
          [1, 1],
          [4, 5],
        ],
        0.5
      )
    ).toEqual([2.5, 3])
  })

  it('eases in and out within 0..1', () => {
    expect([ease(-1), ease(0), ease(0.5), ease(1), ease(3)]).toEqual([0, 0, 0.5, 1, 1])
    expect(ease(0.25)).toBeLessThan(0.25)
  })

  it('loops and pulses on the side clock, negative time included', () => {
    const ui = makeUi(recorder().p, opts)
    ui.t = 3
    expect(ui.loop(2)).toBe(0.5)
    expect(ui.loop()).toBe(0.5)
    ui.t = -0.5
    expect(ui.loop(2)).toBe(0.75)
    ui.t = 0.8
    expect(ui.pulse(1.6)).toBeCloseTo(1)
    ui.t = 0
    expect(ui.pulse()).toBeCloseTo(0)
  })
})

describe('the drawing kit', () => {
  it('gives the stage, the side, and the palette', () => {
    const ui = makeUi(recorder().p, opts)
    expect([ui.w, ui.h, ui.side, ui.ink, ui.bad]).toEqual([400, 300, 'a', '#123456', DEFAULT_PALETTE.bad])
    expect(ui.icons).toEqual(Object.keys(ICONS))
  })

  it('draws a labeled box in the palette unless told otherwise', () => {
    const { p, calls, dash } = recorder()
    const ui = makeUi(p, opts)
    ui.box(10, 20, 80, 40, 'cache')
    expect(calls).toContainEqual(['rect', [10, 20, 80, 40, 8]])
    expect(calls).toContainEqual(['fill', [DEFAULT_PALETTE.paper]])
    expect(calls).toContainEqual(['text', ['cache', 50, 40]])
    expect(dash).toEqual([])
    calls.length = 0
    ui.box(0, 0, 10, 10, undefined, { fill: 'red', stroke: 'blue', dash: true, weight: 4 })
    expect(calls).toContainEqual(['fill', ['red']])
    expect(calls).toContainEqual(['stroke', ['blue']])
    expect(calls).toContainEqual(['strokeWeight', [4]])
    expect(calls.some(([name]) => name === 'text')).toBe(false)
    expect(dash).toEqual([[6, 5]])
  })

  it('moves a box label to its top or bottom edge, leaving the middle free', () => {
    const { p, calls } = recorder()
    const ui = makeUi(p, opts)
    ui.box(10, 20, 80, 100, 'top', { at: 'top' })
    ui.box(10, 20, 80, 100, 'bottom', { at: 'bottom' })
    expect(calls).toContainEqual(['text', ['top', 50, 34]])
    expect(calls).toContainEqual(['text', ['bottom', 50, 106]])
    // An edge label is a size smaller than a centered one.
    expect(calls.filter(([name, args]) => name === 'textSize' && args[0] === 13)).toHaveLength(2)
  })

  it('aligns and weights labels as asked', () => {
    const { p, calls } = recorder()
    const ui = makeUi(p, opts)
    ui.label('left', 1, 2, { align: 'left', bold: true, size: 20, color: 'green' })
    ui.label(7, 1, 2, { align: 'right' })
    expect(calls).toContainEqual(['textAlign', ['left', 'center']])
    expect(calls).toContainEqual(['textStyle', ['bold']])
    expect(calls).toContainEqual(['textSize', [20]])
    expect(calls).toContainEqual(['fill', ['green']])
    expect(calls).toContainEqual(['textAlign', ['right', 'center']])
    expect(calls).toContainEqual(['text', ['7', 1, 2]])
  })

  it('points an arrowhead along the line, or leaves it off', () => {
    const { p, calls, dash } = recorder()
    const ui = makeUi(p, opts)
    ui.arrow(0, 0, 100, 0)
    const head = calls.find(([name]) => name === 'triangle')?.[1]
    // The head's tip is the line's end, and its back corners sit behind it on both sides.
    expect(head?.slice(0, 2)).toEqual([100, 0])
    expect(Number(head?.[2])).toBeLessThan(100)
    expect(Number(head?.[3])).toBeCloseTo(-Number(head?.[5]))
    calls.length = 0
    ui.arrow(0, 0, 0, 50, { head: false, dash: true, color: 'red' })
    expect(calls.some(([name]) => name === 'triangle')).toBe(false)
    // The dash is reset before the head, so the head is always solid.
    expect(dash).toEqual([[], [6, 5], []])
  })

  it('draws dots in the side ink by default', () => {
    const { p, calls } = recorder()
    makeUi(p, opts).dot(5, 6)
    expect(calls).toContainEqual(['fill', ['#123456']])
    expect(calls).toContainEqual(['circle', [5, 6, 12]])
  })

  it('draws every icon at its size, with a fixed stroke, and falls back on an unknown name', () => {
    for (const name of Object.keys(ICONS)) {
      const { p, calls } = recorder()
      makeUi(p, opts).icon(name, 50, 60, 40, 'red')
      expect(calls[1]).toEqual(['translate', [50, 60]])
      expect(calls).toContainEqual(['scale', [40]])
      expect(calls).toContainEqual(['strokeWeight', [2.2 / 40]])
      expect(calls).toContainEqual(['stroke', ['red']])
      // Something is drawn between the setup and the pop.
      expect(calls.length).toBeGreaterThan(9)
    }
    const unknown = recorder()
    const pkg = recorder()
    makeUi(unknown.p, opts).icon('nope', 0, 0)
    makeUi(pkg.p, opts).icon('package', 0, 0)
    expect(unknown.calls).toEqual(pkg.calls)
  })
})
