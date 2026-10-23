// @ts-check
// One answer while it streams in: the activity line with its elapsed time, the tool calls, the
// text redrawn at most once per frame, and the note a stopped answer leaves. The canvas's AI Chat
// and the tour's grilling drawer both draw their answers through it; each says how its text
// becomes HTML and what to do around it.
import { esc } from './dom.js'

/**
 * What the activity line says while a review checkout is created or moved.
 * @param {{ sha: string, creating: boolean }} event
 */
export function checkoutActivityText(event) {
  const sha = event.sha.slice(0, 7)
  return event.creating ? `Creating the review checkout at ${sha}` : `Checking out ${sha}`
}

/**
 * The warning a turn shows when its review checkout failed and it read the reader's checkout.
 * @param {{ message: string, branch: string | null }} event
 */
export function checkoutWarningHtml(event) {
  const where =
    event.branch === null
      ? 'your checkout'
      : `your checkout on <span class="mono">${esc(event.branch)}</span>`
  return (
    `<p class="chat-warning small" role="status">The review checkout could not be updated, so AI Chat read ${where}. ` +
    `Answers may describe another version of the code. <span class="muted">${esc(event.message)}</span></p>`
  )
}

/**
 * @typedef {{
 *   turn: HTMLElement,
 *   body: HTMLElement,
 *   render: (text: string, done: boolean) => string,
 *   onDraw?: () => void,
 *   onChunk?: () => void,
 *   onThread?: (thread: string) => void,
 *   onError?: (message: string, code: string) => void,
 *   onCancelled?: () => void,
 *   now?: () => number,
 * }} LiveAnswerOptions
 */

/**
 * Starts drawing an answer into its turn. `onEvent` takes the stream's events; `finish` draws the
 * answer whole once the stream ends, and `stop` drops the timers when the turn is torn down.
 * @param {LiveAnswerOptions} opts
 */
export function liveAnswer(opts) {
  const { turn, body, render } = opts
  const now = opts.now ?? Date.now
  const activity = document.createElement('p')
  activity.className = 'muted small chat-activity'
  activity.setAttribute('aria-live', 'off')
  turn.append(activity)
  const started = now()
  /** What the turn is waiting on: the answer, or a review checkout first. */
  let phase = 'Preparing answer'
  const updateActivity = () => {
    const elapsed = now() - started
    activity.textContent = `${phase}${'.'.repeat((Math.floor(elapsed / 400) % 3) + 1)} · ${Math.floor(elapsed / 1000)}s`
  }
  updateActivity()
  const timer = setInterval(updateActivity, 400)
  const toolDetails = document.createElement('details')
  toolDetails.className = 'chat-tool-calls muted small'
  toolDetails.hidden = true
  turn.append(toolDetails)
  /** @type {Map<string, { title: string, status: string }>} */
  const tools = new Map()
  let text = ''
  /** @type {number | ReturnType<typeof setTimeout>} */
  let frame = 0

  const cancelFrame = () => {
    if (frame === 0) {
      return
    }
    if (typeof frame === 'number' && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frame)
    } else {
      clearTimeout(frame)
    }
    frame = 0
  }

  /**
   * Redraws the text at most once per frame: a chunk every few milliseconds must not mean a
   * markdown parse every few milliseconds.
   */
  const scheduleRender = () => {
    if (frame !== 0) {
      return
    }
    // requestAnimationFrame is what batches the redraws; setTimeout stands in for it in a test
    // environment that has none.
    const run = () => {
      frame = 0
      body.innerHTML = render(text, false)
      opts.onDraw?.()
    }
    frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16)
  }

  /** @param {{ event: string, data: unknown }} event */
  const onEvent = event => {
    const data = /** @type {Record<string, unknown>} */ (event.data ?? {})
    const thread = data['thread']
    if (event.event === 'turn' && typeof thread === 'string') {
      opts.onThread?.(thread)
      // The checkout, if there was one, is done once the turn starts.
      phase = 'Preparing answer'
      activity.classList.remove('checking-out')
      updateActivity()
      return
    }
    if (event.event === 'checkout') {
      const checkout = /** @type {import('./contract-types.js').ChatCheckoutEvent} */ ({
        event: 'checkout',
        ...data,
      })
      if (checkout.status === 'preparing') {
        phase = checkoutActivityText(checkout)
        activity.classList.add('checking-out')
        updateActivity()
      } else {
        turn.querySelector('.role')?.insertAdjacentHTML('afterend', checkoutWarningHtml(checkout))
      }
      return
    }
    if (event.event === 'tool') {
      const id = String(data['id'] ?? '')
      const previous = tools.get(id)
      const title = String(data['title'] ?? 'tool')
      tools.delete(id)
      const latest = {
        title: title === 'tool' && previous ? previous.title : title,
        status: String(data['status'] ?? 'pending'),
      }
      tools.set(id, latest)
      toolDetails.hidden = false
      toolDetails.innerHTML = `<summary>${esc(latest.title)} · ${esc(latest.status)} (${tools.size} tool calls)</summary><ul>${[...tools.values()].map(t => `<li>${esc(t.title)} · ${esc(t.status)}</li>`).join('')}</ul>`
      return
    }
    const chunk = data['text']
    if (event.event === 'chunk' && typeof chunk === 'string') {
      text += chunk
      opts.onChunk?.()
      scheduleRender()
      return
    }
    if (event.event === 'error') {
      opts.onError?.(String(data['message'] ?? 'the agent failed'), String(data['code'] ?? 'error'))
      return
    }
    if (event.event === 'cancelled') {
      opts.onCancelled?.()
    }
  }

  const stop = () => {
    clearInterval(timer)
    cancelFrame()
  }

  return {
    onEvent,
    /** The text so far. */
    text: () => text,
    stop,
    /** Draws the answer whole and leaves the elapsed time and the tool calls folded under it. */
    finish() {
      stop()
      toolDetails.open = false
      const summary = toolDetails.querySelector('summary')
      if (summary) {
        summary.textContent = `${tools.size} tool calls`
      }
      activity.textContent = `Elapsed: ${Math.floor((now() - started) / 1000)}s`
      body.innerHTML = text === '' ? '<span class="muted">no answer</span>' : render(text, true)
      opts.onDraw?.()
    },
  }
}
