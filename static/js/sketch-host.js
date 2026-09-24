// @ts-check
// The sketch frame's boot. The frame is sandboxed (an opaque origin with no network, see
// sketchFramePolicy), says it is ready, and runs the one sketch the deck page posts back. Later
// messages move its animation state. Errors go back to the deck page, which shows the side's
// consequence as text instead.
import { isSketchState, makeUi, stageFit, tick, DEFAULT_PALETTE } from './sketch-kit.js'

/** @typedef {import('./sketch-kit.js').SketchState} SketchState */

const w = /** @type {any} */ (window)
const P5 = w.p5
// What the policy does not cover. A sketch cannot name these anyway (the validator refuses
// bare globals); this is the second lock.
for (const name of [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'WebTransport',
  'open',
]) {
  try {
    Object.defineProperty(w, name, { value: undefined, configurable: false, writable: false })
  } catch {
    // Already locked down.
  }
}

const deckPage = window.parent
// The deck page is on this server, whose origin the frame's URL still names although the
// sandbox gives the document itself an opaque one.
const deckOrigin = new URL(location.href).origin

/** @param {Record<string, unknown>} message */
const send = message => deckPage.postMessage(message, deckOrigin)

let started = false
/** @type {ReturnType<typeof makeUi> | null} */
let ui = null
const clock = { clock: 0, last: performance.now(), pickedAt: /** @type {number | null} */ (null) }

/** @param {unknown} err */
function fail(err) {
  const message = err instanceof Error ? err.message : String(err)
  send({ type: 'error', message: message.slice(0, 300) })
}

/**
 * @param {{ code: string, side: 'a' | 'b', still: boolean, palette?: Record<string, unknown> }} run
 */
function start(run) {
  started = true
  /** @type {(p: unknown, ui: unknown) => void} */
  let body
  try {
    // The one place generated code turns into a function; the sandbox is why it may.
    body = /** @type {any} */ (new Function('p', 'ui', run.code))
  } catch (err) {
    fail(err)
    return
  }
  const palette = { ...DEFAULT_PALETTE }
  for (const [k, v] of Object.entries(run.palette ?? {})) {
    if (k in palette && typeof v === 'string') /** @type {Record<string, string>} */ (palette)[k] = v
  }
  let drawn = false
  // p5 runs the sketch from the instance's constructor; the instance itself is not needed.
  const instance = new P5((/** @type {any} */ p) => {
    const kit = makeUi(p, { side: run.side === 'b' ? 'b' : 'a', still: run.still === true, palette })
    ui = kit
    try {
      body(p, kit)
    } catch (err) {
      fail(err)
      return
    }
    const userSetup = typeof p.setup === 'function' ? p.setup : null
    const userDraw = typeof p.draw === 'function' ? p.draw : null
    p.setup = () => {
      p.pixelDensity(Math.min(2, window.devicePixelRatio || 1))
      p.createCanvas(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))
      p.frameRate(30)
      p.textFont('ui-sans-serif, system-ui, sans-serif')
      try {
        userSetup?.()
      } catch (err) {
        p.noLoop()
        fail(err)
      }
      if (kit.still) p.noLoop()
    }
    p.draw = () => {
      tick(kit, clock, performance.now())
      p.clear()
      const fit = stageFit(p.width, p.height)
      p.push()
      p.translate(fit.dx, fit.dy)
      p.scale(fit.scale)
      try {
        userDraw?.()
      } catch (err) {
        p.pop()
        p.noLoop()
        fail(err)
        return
      }
      p.pop()
      if (!drawn) {
        drawn = true
        send({ type: 'drawn' })
      }
    }
    p.windowResized = () => {
      p.resizeCanvas(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))
      if (kit.still) p.redraw()
    }
  }, document.body)
  void instance
}

/** @param {{ state?: unknown, lean?: unknown }} message */
function setState(message) {
  if (ui === null || !isSketchState(message.state)) return
  const state = /** @type {SketchState} */ (message.state)
  if (state === 'picked' && ui.state !== 'picked') clock.pickedAt = performance.now()
  ui.state = state
  ui.lean = typeof message.lean === 'number' ? Math.min(1, Math.max(0, message.lean)) : 0
}

window.addEventListener('message', event => {
  if (event.source !== deckPage || event.origin !== deckOrigin) return
  const data = /** @type {Record<string, unknown> | null} */ (event.data)
  if (data === null || typeof data !== 'object') return
  if (data['type'] === 'run' && !started && typeof data['code'] === 'string') {
    start(/** @type {any} */ (data))
  } else if (data['type'] === 'state') {
    setState(data)
  }
})
window.addEventListener('error', event => fail(event.error ?? event.message))

send({ type: 'ready' })
