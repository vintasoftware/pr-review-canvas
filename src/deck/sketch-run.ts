// Runs a side's sketch without a browser, to catch what the static checks cannot: a sketch that
// throws, loops forever, or draws labels a reader cannot read. The sketch runs against a
// recording stand-in for p5 and the real drawing kit, both defined inside a fresh vm context, so
// nothing of this process is reachable from the sketch; only a JSON string of what it drew comes
// back. The generator that wrote the sketch already runs on this machine, so this adds no reach
// it lacked, and the timeout keeps a runaway loop from hanging validation.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { STATIC_DIR } from '../paths.js'

/** The moments a sketch is drawn at: its idle loop, a lean, the still frame, and the payoff. */
const FRAMES = [
  { t: 0, state: 'idle', beat: 0, lean: 0 },
  { t: 0.6, state: 'lean', beat: 0, lean: 1 },
  { t: 1.2, state: 'idle', beat: 0, lean: 0 },
  { t: 2.5, state: 'idle', beat: 0, lean: 0 },
  { t: 1.2, state: 'picked', beat: 0.5, lean: 0 },
  { t: 1.4, state: 'picked', beat: 1, lean: 0 },
  { t: 1.2, state: 'other', beat: 0, lean: 0 },
] as const

/** The smallest label a reader can take in at a glance, in stage units. */
export const MIN_LABEL_SIZE = 12

const RUN_TIMEOUT_MS = 1500

export interface DrawnText {
  text: string
  x: number
  y: number
  w: number
  h: number
  size: number
  /** Drawn under a rotation, where its box is not axis-aligned: skipped by the layout checks. */
  rotated: boolean
  order: number
}

/** A shape's box in stage units; under a rotation, the box around its turned corners. */
export interface DrawnShape {
  kind: string
  x: number
  y: number
  w: number
  h: number
  filled: boolean
  rotated: boolean
  order: number
}

/** A straight stroke, as drawn: its two ends and its width, in stage units. */
export interface DrawnStroke {
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  order: number
}

export interface DrawnFrame {
  texts: DrawnText[]
  shapes: DrawnShape[]
  strokes: DrawnStroke[]
}

export type SketchRun = { ok: true; frames: DrawnFrame[] } | { ok: false; error: string }

let kitSource: string | null = null

/** The drawing kit's source, as a plain script: its exports become declarations. */
function kit(): string {
  kitSource ??= readFileSync(path.join(STATIC_DIR, 'js', 'sketch-kit.js'), 'utf8').replace(/^export /gm, '')
  return kitSource
}

/**
 * The p5 stand-in, as source evaluated inside the context. It tracks the full transform (translate,
 * scale, rotate) and the fill, stroke weight, and text state across push and pop, and records, in
 * stage units, the box of every shape, every straight stroke as a segment with its width, and
 * every text. Calls it does not know are no-ops that return 0, so a sketch using some other p5
 * function still runs.
 */
const RECORDER = String.raw`
function makeRecorder() {
  const frame = { texts: [], shapes: [], strokes: [] }
  let order = 0
  const fresh = () => ({ m: [1, 0, 0, 1, 0, 0], fill: true, weight: 1, textSize: 12, alignX: 'left', alignY: 'baseline' })
  let st = fresh()
  const stack = []
  // x' = a x + c y + e, y' = b x + d y + f
  const pt = (x, y) => { const [a, b, c, d, e, f] = st.m; return [a * x + c * y + e, b * x + d * y + f] }
  const mul = (a2, b2, c2, d2, e2, f2) => {
    const [a, b, c, d, e, f] = st.m
    st.m = [a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2, a * e2 + c * f2 + e, b * e2 + d * f2 + f]
  }
  const unit = () => Math.sqrt(Math.abs(st.m[0] * st.m[3] - st.m[1] * st.m[2]))
  const rotated = () => Math.abs(st.m[1]) > 1e-6 || Math.abs(st.m[2]) > 1e-6
  const shape = (kind, corners) => {
    const pts = corners.map(([x, y]) => pt(x, y))
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
    const x = Math.min(...xs), y = Math.min(...ys)
    frame.shapes.push({ kind, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, filled: st.fill, rotated: rotated(), order: order++ })
  }
  const box = (kind, x0, y0, x1, y1) => shape(kind, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
  const stroke = (x1, y1, x2, y2) => {
    const [ax, ay] = pt(x1, y1), [bx, by] = pt(x2, y2)
    frame.strokes.push({ x1: ax, y1: ay, x2: bx, y2: by, w: st.weight * unit(), order: order++ })
  }
  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0)
  let seed = 1
  let vertices = null
  const known = {
    CLOSE: 'close', BOLD: 'bold', NORMAL: 'normal', ITALIC: 'italic', LEFT: 'left', CENTER: 'center',
    RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom', BASELINE: 'baseline', ROUND: 'round', SQUARE: 'square',
    PROJECT: 'project', MITER: 'miter', BEVEL: 'bevel', CORNER: 'corner', CORNERS: 'corners', RADIUS: 'radius',
    PI: Math.PI, TWO_PI: Math.PI * 2, HALF_PI: Math.PI / 2, QUARTER_PI: Math.PI / 4, TAU: Math.PI * 2,
    DEGREES: 'degrees', RADIANS: 'radians', PIE: 'pie', CHORD: 'chord', OPEN: 'open',
    width: 400, height: 300, frameCount: 1, deltaTime: 33, mouseX: 0, mouseY: 0,
    drawingContext: { setLineDash() {}, globalAlpha: 1 },
    push() { stack.push({ ...st, m: [...st.m] }) },
    pop() { st = stack.pop() ?? st },
    translate(x, y) { mul(1, 0, 0, 1, num(x), num(y)) },
    scale(x, y) { const sx = num(x) || 1; mul(sx, 0, 0, y === undefined ? sx : num(y) || 1, 0, 0) },
    rotate(a) { const r = num(a), c = Math.cos(r), s = Math.sin(r); mul(c, s, -s, c, 0, 0) },
    resetMatrix() { st.m = [1, 0, 0, 1, 0, 0] },
    fill() { st.fill = true },
    noFill() { st.fill = false },
    strokeWeight(w) { st.weight = num(w) },
    textSize(s) { st.textSize = num(s) },
    textAlign(x, y) { st.alignX = x ?? 'left'; st.alignY = y ?? 'baseline' },
    text(s, x, y) {
      const str = String(s)
      const size = st.textSize * unit()
      const w = str.length * size * 0.56
      const h = size * 1.2
      const [px, py] = pt(num(x), num(y))
      const left = st.alignX === 'center' ? px - w / 2 : st.alignX === 'right' ? px - w : px
      const top = st.alignY === 'center' ? py - h / 2 : st.alignY === 'top' ? py : st.alignY === 'bottom' ? py - h : py - size
      frame.texts.push({ text: str, x: left, y: top, w, h, size, rotated: rotated(), order: order++ })
    },
    line(a, b, c, d) { stroke(num(a), num(b), num(c), num(d)) },
    bezier(a, b, c, d, e, f, g, h) {
      // Eight straight pieces follow the curve closely enough to say what it crosses.
      let [px, py] = [num(a), num(b)]
      for (let i = 1; i <= 8; i++) {
        const t = i / 8, u = 1 - t
        const x = u * u * u * num(a) + 3 * u * u * t * num(c) + 3 * u * t * t * num(e) + t * t * t * num(g)
        const y = u * u * u * num(b) + 3 * u * u * t * num(d) + 3 * u * t * t * num(f) + t * t * t * num(h)
        stroke(px, py, x, y)
        ;[px, py] = [x, y]
      }
    },
    rect(x, y, w, h) { box('rect', num(x), num(y), num(x) + num(w), num(y) + num(h ?? w)) },
    square(x, y, s) { box('rect', num(x), num(y), num(x) + num(s), num(y) + num(s)) },
    circle(x, y, d) { const r = num(d) / 2; box('circle', num(x) - r, num(y) - r, num(x) + r, num(y) + r) },
    ellipse(x, y, w, h) { const rw = num(w) / 2, rh = num(h ?? w) / 2; box('ellipse', num(x) - rw, num(y) - rh, num(x) + rw, num(y) + rh) },
    arc(x, y, w, h) { const rw = num(w) / 2, rh = num(h) / 2; box('arc', num(x) - rw, num(y) - rh, num(x) + rw, num(y) + rh) },
    triangle(a, b, c, d, e, f) { shape('triangle', [[num(a), num(b)], [num(c), num(d)], [num(e), num(f)]]) },
    quad(a, b, c, d, e, f, g, h) { shape('quad', [[num(a), num(b)], [num(c), num(d)], [num(e), num(f)], [num(g), num(h)]]) },
    beginShape() { vertices = [] },
    vertex(x, y) { vertices?.push([num(x), num(y)]) },
    endShape() {
      if (vertices && vertices.length > 0) {
        shape('shape', vertices)
      }
      vertices = null
    },
    random(a, b) {
      seed = (seed * 16807) % 2147483647
      const r = (seed - 1) / 2147483646
      if (Array.isArray(a)) return a[Math.floor(r * a.length)]
      if (a === undefined) return r
      if (b === undefined) return r * a
      return a + r * (b - a)
    },
    randomSeed(s) { seed = Math.max(1, Math.floor(num(s)) % 2147483647) },
    noise() { return 0.5 },
    lerp(a, b, t) { return a + (b - a) * t },
    map(v, a, b, c, d) { return c + ((v - a) * (d - c)) / (b - a) },
    constrain(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) },
    dist(a, b, c, d) { return Math.hypot(c - a, d - b) },
    mag(a, b) { return Math.hypot(a, b) },
    norm(v, a, b) { return (v - a) / (b - a) },
    sq(v) { return v * v },
    radians(d) { return (d * Math.PI) / 180 },
    degrees(r) { return (r * 180) / Math.PI },
    color(...a) { return a.join(',') },
    lerpColor(a) { return a },
    millis() { return 0 },
  }
  for (const f of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'sqrt', 'pow', 'exp', 'log']) {
    known[f] = Math[f]
  }
  const p = new Proxy(known, {
    get(target, name) { return name in target ? target[name] : () => 0 },
    set(target, name, value) { target[name] = value; return true },
  })
  return { p, frame, reset() { frame.texts = []; frame.shapes = []; frame.strokes = []; order = 0; st = fresh(); stack.length = 0 } }
}
`

const DRIVER = String.raw`
const recorder = makeRecorder()
const p = recorder.p
const ui = makeUi(p, { side: 'a', still: false, palette: DEFAULT_PALETTE })
let failure = null
const frames = []
try {
  new Function('p', 'ui', SKETCH)(p, ui)
  if (typeof p.setup === 'function') p.setup()
  for (const f of FRAMES) {
    Object.assign(ui, f)
    recorder.reset()
    p.draw()
    frames.push({ texts: recorder.frame.texts, shapes: recorder.frame.shapes, strokes: recorder.frame.strokes })
  }
} catch (err) {
  failure = (err && err.name ? err.name + ': ' : '') + (err && err.message !== undefined ? err.message : String(err))
}
JSON.stringify(failure === null ? { ok: true, frames } : { ok: false, error: failure })
`

/** Draws the sketch at the moments a reader sees it, and returns what it drew. */
export function runSketch(source: string): SketchRun {
  const context = { SKETCH: source, FRAMES: JSON.parse(JSON.stringify(FRAMES)) as unknown }
  try {
    const out = runInNewContext(`${kit()}\n${RECORDER}\n${DRIVER}`, context, {
      timeout: RUN_TIMEOUT_MS,
      contextCodeGeneration: { strings: true, wasm: false },
    }) as unknown
    return JSON.parse(String(out)) as SketchRun
  } catch (err) {
    // Only the timeout lands here: the driver catches whatever the sketch throws.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

type Box = { x: number; y: number; w: number; h: number }

/** A box made smaller by `f` of its size on every side, so a stroke grazing an edge is let go. */
function shrink(b: Box, f: number): Box {
  return { x: b.x + b.w * f, y: b.y + b.h * f, w: b.w * (1 - 2 * f), h: b.h * (1 - 2 * f) }
}

/** Whether a stroke, as wide as it is drawn, touches the box. */
export function segmentHitsBox(
  k: { x1: number; y1: number; x2: number; y2: number; w: number },
  b: Box
): boolean {
  const pad = k.w / 2
  const x0 = b.x - pad
  const y0 = b.y - pad
  const x1 = b.x + b.w + pad
  const y1 = b.y + b.h + pad
  // Liang–Barsky: clip the segment to the box; it touches when something is left.
  let t0 = 0
  let t1 = 1
  const dx = k.x2 - k.x1
  const dy = k.y2 - k.y1
  const edges: Array<[number, number]> = [
    [-dx, k.x1 - x0],
    [dx, x1 - k.x1],
    [-dy, k.y1 - y0],
    [dy, y1 - k.y1],
  ]
  for (const [q, r] of edges) {
    if (q === 0) {
      if (r < 0) return false
      continue
    }
    const t = r / q
    if (q < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
    if (t0 > t1) return false
  }
  return true
}

/** The part of `a`'s area that `b` covers, 0..1. */
function covered(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w <= 0 || h <= 0 || a.w * a.h === 0 ? 0 : (w * h) / (a.w * a.h)
}

const STAGE = { x: 0, y: 0, w: 400, h: 300 }

/**
 * What a reader could not read in the frames a sketch drew: labels on top of each other, a label
 * a later filled shape paints over, a label off the stage, a label too small. One sentence each,
 * the same problem named once.
 */
export function layoutProblems(frames: readonly DrawnFrame[]): string[] {
  const problems = new Set<string>()
  for (const frame of frames) {
    const texts = frame.texts.filter(t => !t.rotated && t.text.trim() !== '')
    for (const t of texts) {
      if (t.size < MIN_LABEL_SIZE - 0.01) {
        problems.add(
          `label "${t.text}" is size ${Math.round(t.size * 10) / 10}; labels are at least ${MIN_LABEL_SIZE}`
        )
      }
      if (covered(t, STAGE) < 0.98) {
        problems.add(`label "${t.text}" runs off the 400×300 stage`)
      }
    }
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        const a = texts[i] as DrawnText
        const b = texts[j] as DrawnText
        if (Math.max(covered(a, b), covered(b, a)) > 0.15) {
          problems.add(`labels "${a.text}" and "${b.text}" overlap`)
        }
      }
    }
    for (const t of texts) {
      for (const s of frame.shapes) {
        // A filled shape drawn before the label is its background; one drawn after paints over
        // it. An outline is in the way when it is small next to the label (an icon on it), not
        // when it frames the label from around it. A turned shape counts by the box around it.
        const over = covered(t, s)
        const inTheWay = s.filled ? s.order > t.order && over > 0.12 : over > 0.1 && s.w * s.h < 4 * t.w * t.h
        if (inTheWay) {
          problems.add(
            s.filled
              ? `a ${s.kind} drawn after label "${t.text}" covers it; draw the label last or move one of them`
              : `a ${s.kind} crosses label "${t.text}"; move one of them`
          )
        }
      }
      // A stroke through a label, drawn before or after it, is in the way either way.
      if (frame.strokes.some(k => segmentHitsBox(k, shrink(t, 0.15)))) {
        problems.add(`a line crosses label "${t.text}"; move one of them`)
      }
    }
  }
  return [...problems].slice(0, 4)
}
