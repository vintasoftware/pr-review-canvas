// @ts-check
// What a card's sketch draws with besides p5 itself: the `ui` object. It fixes a 400×300 stage
// the frame scales to fit, carries the palette and the animation state the deck page posts in,
// and offers a small kit (boxes, arrows, labels, icons, motion helpers) so a generated sketch
// stays short and every card looks like it belongs to the same deck. Runs inside the sandboxed
// sketch frame only.

export const STAGE_W = 400
export const STAGE_H = 300

/** How long, in milliseconds, the picked side's payoff plays before the card flies off. */
export const BEAT_MS = 700

/** @typedef {'idle' | 'lean' | 'picked' | 'other'} SketchState */
/**
 * @typedef {{ ink: string, fg: string, muted: string, paper: string, line: string, good: string,
 *   bad: string, warn: string }} Palette
 */

/** @type {Palette} */
export const DEFAULT_PALETTE = {
  ink: '#364fc7',
  fg: '#1f2328',
  muted: '#656d76',
  paper: '#ffffff',
  line: '#d0d7de',
  good: '#1a7f37',
  bad: '#cf222e',
  warn: '#9a6700',
}

const STATES = new Set(['idle', 'lean', 'picked', 'other'])

/** @param {unknown} v */
export function isSketchState(v) {
  return typeof v === 'string' && STATES.has(v)
}

/**
 * Where the stage sits in a frame of `w`×`h` pixels: scaled to fit whole, and centered.
 * @param {number} w
 * @param {number} h
 */
export function stageFit(w, h) {
  const scale = Math.max(0.01, Math.min(w / STAGE_W, h / STAGE_H))
  return { scale, dx: (w - STAGE_W * scale) / 2, dy: (h - STAGE_H * scale) / 2 }
}

/**
 * How fast a side's clock runs: a lean speeds it up, the side not picked slows to a crawl.
 * @param {SketchState} state
 * @param {number} lean 0..1
 */
export function clockSpeed(state, lean) {
  if (state === 'lean') return 1 + 1.8 * Math.min(1, Math.max(0, lean))
  if (state === 'other') return 0.25
  return 1
}

/**
 * The point `f` (0..1) of the way along a polyline, by length.
 * @param {ReadonlyArray<readonly [number, number]>} points
 * @param {number} f
 * @returns {[number, number]}
 */
export function along(points, f) {
  const first = points[0]
  if (first === undefined) return [0, 0]
  const lengths = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const a = /** @type {readonly [number, number]} */ (points[i - 1])
    const b = /** @type {readonly [number, number]} */ (points[i])
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    lengths.push(d)
    total += d
  }
  if (total === 0) return [first[0], first[1]]
  let left = Math.min(1, Math.max(0, f)) * total
  for (let i = 0; i < lengths.length; i++) {
    const d = /** @type {number} */ (lengths[i])
    const a = /** @type {readonly [number, number]} */ (points[i])
    const b = /** @type {readonly [number, number]} */ (points[i + 1])
    if (left <= d || i === lengths.length - 1) {
      const t = d === 0 ? 0 : Math.min(1, left / d)
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
    }
    left -= d
  }
  return [first[0], first[1]]
}

/** @param {number} f */
export function ease(f) {
  const x = Math.min(1, Math.max(0, f))
  return x * x * (3 - 2 * x)
}

/**
 * Icons in a unit box centered on the origin, drawn with strokes. Each is a list of p5 calls, so
 * the kit can draw them at any size and in any color.
 * @type {Record<string, (p: any) => void>}
 */
export const ICONS = {
  user: p => {
    p.circle(0, -0.18, 0.3)
    p.arc(0, 0.42, 0.62, 0.6, Math.PI, 0)
  },
  users: p => {
    p.circle(-0.16, -0.16, 0.24)
    p.arc(-0.16, 0.36, 0.48, 0.5, Math.PI, 0)
    p.circle(0.2, -0.2, 0.22)
    p.arc(0.2, 0.3, 0.44, 0.46, Math.PI, -0.3)
  },
  server: p => {
    p.rect(-0.36, -0.4, 0.72, 0.34, 0.06)
    p.rect(-0.36, 0.06, 0.72, 0.34, 0.06)
    p.point(0.22, -0.23)
    p.point(0.22, 0.23)
  },
  db: p => {
    p.ellipse(0, -0.3, 0.64, 0.2)
    p.line(-0.32, -0.3, -0.32, 0.3)
    p.line(0.32, -0.3, 0.32, 0.3)
    p.arc(0, 0.3, 0.64, 0.2, 0, Math.PI)
    p.arc(0, 0, 0.64, 0.2, 0, Math.PI)
  },
  file: p => {
    p.beginShape()
    p.vertex(-0.28, -0.4)
    p.vertex(0.12, -0.4)
    p.vertex(0.28, -0.24)
    p.vertex(0.28, 0.4)
    p.vertex(-0.28, 0.4)
    p.endShape(p.CLOSE)
    p.line(-0.14, -0.05, 0.14, -0.05)
    p.line(-0.14, 0.12, 0.14, 0.12)
  },
  lock: p => {
    p.rect(-0.3, -0.04, 0.6, 0.44, 0.06)
    p.arc(0, -0.04, 0.4, 0.56, Math.PI, 0)
  },
  unlock: p => {
    p.rect(-0.3, -0.04, 0.6, 0.44, 0.06)
    p.arc(0.2, -0.14, 0.4, 0.46, Math.PI, -0.2)
  },
  key: p => {
    p.circle(-0.2, 0, 0.3)
    p.line(-0.05, 0, 0.38, 0)
    p.line(0.28, 0, 0.28, 0.14)
    p.line(0.16, 0, 0.16, 0.1)
  },
  clock: p => {
    p.circle(0, 0, 0.78)
    p.line(0, 0, 0, -0.24)
    p.line(0, 0, 0.18, 0.1)
  },
  check: p => {
    p.line(-0.3, 0.02, -0.08, 0.26)
    p.line(-0.08, 0.26, 0.32, -0.24)
  },
  cross: p => {
    p.line(-0.26, -0.26, 0.26, 0.26)
    p.line(0.26, -0.26, -0.26, 0.26)
  },
  warn: p => {
    p.triangle(0, -0.38, 0.4, 0.34, -0.4, 0.34)
    p.line(0, -0.1, 0, 0.1)
    p.point(0, 0.22)
  },
  bug: p => {
    p.ellipse(0, 0.06, 0.36, 0.5)
    p.circle(0, -0.26, 0.18)
    for (const y of [-0.06, 0.08, 0.22]) {
      p.line(-0.18, y, -0.34, y - 0.06)
      p.line(0.18, y, 0.34, y - 0.06)
    }
  },
  gear: p => {
    p.circle(0, 0, 0.44)
    p.circle(0, 0, 0.14)
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4
      p.line(Math.cos(a) * 0.22, Math.sin(a) * 0.22, Math.cos(a) * 0.36, Math.sin(a) * 0.36)
    }
  },
  cloud: p => {
    p.arc(-0.14, 0.04, 0.34, 0.34, Math.PI * 0.9, Math.PI * 1.9)
    p.arc(0.1, -0.04, 0.44, 0.44, Math.PI * 1.1, Math.PI * 2.05)
    p.arc(0.28, 0.1, 0.24, 0.24, Math.PI * 1.5, Math.PI * 2.5)
    p.line(-0.3, 0.22, 0.3, 0.22)
    p.arc(-0.3, 0.1, 0.24, 0.24, Math.PI * 0.5, Math.PI * 1.3)
  },
  bolt: p => {
    p.beginShape()
    p.vertex(0.08, -0.4)
    p.vertex(-0.2, 0.06)
    p.vertex(0.02, 0.06)
    p.vertex(-0.08, 0.4)
    p.vertex(0.22, -0.08)
    p.vertex(0, -0.08)
    p.endShape(p.CLOSE)
  },
  eye: p => {
    p.arc(0, 0.12, 0.8, 0.56, Math.PI, 0)
    p.arc(0, -0.12, 0.8, 0.56, 0, Math.PI)
    p.circle(0, 0, 0.2)
  },
  trash: p => {
    p.line(-0.32, -0.26, 0.32, -0.26)
    p.rect(-0.1, -0.38, 0.2, 0.12)
    p.beginShape()
    p.vertex(-0.24, -0.26)
    p.vertex(-0.18, 0.38)
    p.vertex(0.18, 0.38)
    p.vertex(0.24, -0.26)
    p.endShape()
  },
  shield: p => {
    p.beginShape()
    p.vertex(0, -0.4)
    p.vertex(0.32, -0.26)
    p.vertex(0.28, 0.1)
    p.vertex(0, 0.4)
    p.vertex(-0.28, 0.1)
    p.vertex(-0.32, -0.26)
    p.endShape(p.CLOSE)
  },
  list: p => {
    for (const y of [-0.24, 0, 0.24]) {
      p.point(-0.28, y)
      p.line(-0.14, y, 0.32, y)
    }
  },
  package: p => {
    p.rect(-0.34, -0.26, 0.68, 0.6, 0.04)
    p.line(-0.34, -0.06, 0.34, -0.06)
    p.line(0, -0.26, 0, 0.34)
  },
  branch: p => {
    p.circle(-0.18, -0.3, 0.14)
    p.circle(-0.18, 0.3, 0.14)
    p.circle(0.2, -0.12, 0.14)
    p.line(-0.18, -0.23, -0.18, 0.23)
    p.bezier(0.2, -0.05, 0.2, 0.12, -0.18, 0.06, -0.18, 0.2)
  },
  chat: p => {
    p.rect(-0.36, -0.3, 0.72, 0.46, 0.1)
    p.triangle(-0.18, 0.16, -0.02, 0.16, -0.22, 0.34)
  },
  flag: p => {
    p.line(-0.26, -0.38, -0.26, 0.4)
    p.beginShape()
    p.vertex(-0.26, -0.36)
    p.vertex(0.3, -0.24)
    p.vertex(-0.26, -0.04)
    p.endShape(p.CLOSE)
  },
  hourglass: p => {
    p.line(-0.24, -0.38, 0.24, -0.38)
    p.line(-0.24, 0.38, 0.24, 0.38)
    p.beginShape()
    p.vertex(-0.2, -0.38)
    p.vertex(0.2, 0.38)
    p.vertex(-0.2, 0.38)
    p.vertex(0.2, -0.38)
    p.endShape(p.CLOSE)
  },
}

/**
 * The `ui` a sketch gets: the stage, the palette, the animation state (updated every frame by
 * the frame's clock), and the drawing kit. Colors a kit call takes are CSS color strings.
 * @param {any} p the p5 instance
 * @param {{ side: 'a' | 'b', still: boolean, palette: Palette }} opts
 */
export function makeUi(p, opts) {
  const pal = opts.palette
  const ui = {
    w: STAGE_W,
    h: STAGE_H,
    side: opts.side,
    still: opts.still,
    ...pal,
    /** @type {SketchState} */
    state: 'idle',
    /** How hard the author leans toward this side, 0..1. */
    lean: 0,
    /** Seconds on this side's clock, which leans speed up. */
    t: 0,
    /** The picked side's payoff, 0..1 over BEAT_MS; 0 until picked. */
    beat: 0,
    /** 0..1, repeating every `period` seconds. */
    loop: (period = 2) => (((ui.t % period) + period) % period) / period,
    /** A smooth 0..1..0 wave every `period` seconds. */
    pulse: (period = 1.6) => 0.5 - 0.5 * Math.cos((ui.t / period) * Math.PI * 2),
    ease,
    along,
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} w
     * @param {number} h
     * @param {string} [label]
     * @param {{ fill?: string, stroke?: string, color?: string, weight?: number, dash?: boolean,
     *   at?: 'center' | 'top' | 'bottom' }} [o] `at` puts the label at the box's top or bottom edge,
     *   leaving the middle for what the box holds
     */
    box: (x, y, w, h, label, o = {}) => {
      p.push()
      p.stroke(o.stroke ?? pal.fg)
      p.strokeWeight(o.weight ?? 2)
      if (o.dash === true) p.drawingContext.setLineDash([6, 5])
      p.fill(o.fill ?? pal.paper)
      p.rect(x, y, w, h, 8)
      p.pop()
      if (label === undefined) return
      const ly = o.at === 'top' ? y + 14 : o.at === 'bottom' ? y + h - 14 : y + h / 2
      ui.label(label, x + w / 2, ly, { color: o.color ?? pal.fg, size: o.at === undefined ? 14 : 13 })
    },
    /**
     * @param {string | number} text
     * @param {number} x
     * @param {number} y
     * @param {{ size?: number, color?: string, align?: 'left' | 'center' | 'right', bold?: boolean }} [o]
     */
    label: (text, x, y, o = {}) => {
      p.push()
      p.noStroke()
      p.fill(o.color ?? pal.fg)
      p.textSize(o.size ?? 14)
      p.textStyle(o.bold === true ? p.BOLD : p.NORMAL)
      const align = o.align ?? 'center'
      p.textAlign(align === 'left' ? p.LEFT : align === 'right' ? p.RIGHT : p.CENTER, p.CENTER)
      p.text(String(text), x, y)
      p.pop()
    },
    /**
     * @param {number} x1
     * @param {number} y1
     * @param {number} x2
     * @param {number} y2
     * @param {{ color?: string, weight?: number, dash?: boolean, head?: boolean }} [o]
     */
    arrow: (x1, y1, x2, y2, o = {}) => {
      const color = o.color ?? pal.fg
      const a = Math.atan2(y2 - y1, x2 - x1)
      p.push()
      p.stroke(color)
      p.strokeWeight(o.weight ?? 2)
      if (o.dash === true) p.drawingContext.setLineDash([6, 5])
      p.line(x1, y1, x2, y2)
      p.drawingContext.setLineDash([])
      if (o.head !== false) {
        p.noStroke()
        p.fill(color)
        p.triangle(
          x2,
          y2,
          x2 - 10 * Math.cos(a - 0.45),
          y2 - 10 * Math.sin(a - 0.45),
          x2 - 10 * Math.cos(a + 0.45),
          y2 - 10 * Math.sin(a + 0.45)
        )
      }
      p.pop()
    },
    /**
     * @param {number} x
     * @param {number} y
     * @param {number} [r]
     * @param {string} [color]
     */
    dot: (x, y, r = 6, color) => {
      p.push()
      p.noStroke()
      p.fill(color ?? pal.ink)
      p.circle(x, y, r * 2)
      p.pop()
    },
    /**
     * @param {string} name one of `ui.icons`
     * @param {number} x
     * @param {number} y
     * @param {number} [size]
     * @param {string} [color]
     */
    icon: (name, x, y, size = 32, color) => {
      const draw = /** @type {(p: any) => void} */ (ICONS[name] ?? ICONS['package'])
      p.push()
      p.translate(x, y)
      p.scale(size)
      p.noFill()
      p.stroke(color ?? pal.fg)
      p.strokeWeight(2.2 / size)
      p.strokeCap(p.ROUND)
      p.strokeJoin(p.ROUND)
      draw(p)
      p.pop()
    },
    icons: Object.keys(ICONS),
  }
  return ui
}

/**
 * Moves a side's clock one frame on. Still sketches keep a fixed, representative moment.
 * @param {ReturnType<typeof makeUi>} ui
 * @param {{ clock: number, last: number, pickedAt: number | null }} clock
 * @param {number} now milliseconds
 */
export function tick(ui, clock, now) {
  const dt = Math.min(0.1, Math.max(0, (now - clock.last) / 1000))
  clock.last = now
  if (!ui.still) clock.clock += dt * clockSpeed(ui.state, ui.lean)
  ui.t = ui.still ? 1.2 : clock.clock
  ui.beat = clock.pickedAt === null ? 0 : ui.still ? 1 : Math.min(1, (now - clock.pickedAt) / BEAT_MS)
}
