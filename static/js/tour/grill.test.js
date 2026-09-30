// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syntheticTourBundle } from '../../../src/testing/tour-page.js'
import {
  createGrill,
  formGrillHtml,
  grillsWithChat,
  openingMessage,
  PLAN_MESSAGE,
  readRestatement,
  restatementCardHtml,
  REVERSE_QUIZ_MESSAGE,
  speechRecognizer,
} from './grill.js'

const decision = /** @type {import('../contract-types.js').Decision} */ (
  syntheticTourBundle().tour?.decisions[0]
)
const RESTATEMENT = { what: 'Multiply.', where: ['src/app.ts:4'], unchanged: 'Callers.' }

/** A chat-enabled bundle. */
function chatBundle() {
  return syntheticTourBundle({ chat: { enabled: true, acpx: true, agent: 'claude', model: 'opus' } })
}

/**
 * The grilling server as the drawer sees it: the thread it holds and the answers it streams.
 * @param {{ history?: import('../contract-types.js').ChatTurn[], answers?: string[], fail?: boolean }} [opts]
 */
function fakeApi(opts = {}) {
  /** @type {Array<{ message: string, context: unknown }>} */
  const sent = []
  const answers = [...(opts.answers ?? [])]
  return {
    sent,
    cancelled: 0,
    api: {
      fetchGrillHistory: async () => {
        if (opts.fail) {
          throw new Error('no thread')
        }
        return { name: 't0', turns: opts.history ?? [] }
      },
      /** @type {typeof import('./tour-api.js').streamGrill} */
      streamGrill: async (_key, input, streamOpts) => {
        sent.push(input)
        const answer = answers.shift() ?? 'Noted.'
        if (answer === 'ERROR') {
          streamOpts.onEvent({ event: 'error', data: { code: 'AGENT_FAILED', message: 'boom' } })
          return
        }
        if (answer === 'CANCEL') {
          streamOpts.onEvent({ event: 'cancelled', data: {} })
          return
        }
        if (answer === 'THROW') {
          throw new Error('offline')
        }
        streamOpts.onEvent({ event: 'turn', data: { thread: 't0', agent: 'claude', seeded: true } })
        for (const piece of answer.split(' ')) {
          streamOpts.onEvent({ event: 'chunk', data: { text: `${piece} ` } })
        }
        streamOpts.onEvent({ event: 'done', data: { stopReason: 'end_turn' } })
      },
      cancelGrill: async () => ({ cancelled: true }),
    },
  }
}

function mountDialog() {
  document.body.innerHTML = '<dialog id="tour-grill"></dialog>'
  const dialog = document.querySelector('dialog')
  if (!(dialog instanceof HTMLDialogElement)) {
    throw new Error('no dialog')
  }
  return dialog
}

/** @param {string} selector */
function click(selector) {
  const el = document.querySelector(selector)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`nothing to click at ${selector}`)
  }
  el.click()
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('grillsWithChat', () => {
  it('needs chat on, the project grilling, and no preview', () => {
    expect(grillsWithChat(syntheticTourBundle())).toBe(false)
    expect(grillsWithChat(chatBundle())).toBe(true)
    expect(grillsWithChat({ ...chatBundle(), preview: true })).toBe(false)
    const off = chatBundle()
    expect(grillsWithChat({ ...off, options: { ...off.options, grill: 'off' } })).toBe(false)
    expect(speechRecognizer()).toBeNull()
  })
})

describe('the form without an agent', () => {
  it('starts the restatement from the decision, or from the draft, and reads it back', () => {
    document.body.innerHTML = formGrillHtml(decision, undefined)
    expect(document.querySelector('textarea[name="what"]')?.textContent).toBe('Product')
    expect(document.querySelector('textarea[name="where"]')?.textContent).toBe('src/app.ts:4')
    const form = document.querySelector('form')
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('no form')
    }
    expect(readRestatement(form)).toBeNull()
    const unchanged = form.querySelector('textarea[name="unchanged"]')
    const where = form.querySelector('textarea[name="where"]')
    if (!(unchanged instanceof HTMLTextAreaElement && where instanceof HTMLTextAreaElement)) {
      throw new Error('no field')
    }
    unchanged.value = '  The callers.  '
    where.value = 'src/app.ts, , src/b.ts '
    expect(readRestatement(form)).toEqual({
      what: 'Product',
      where: ['src/app.ts', 'src/b.ts'],
      unchanged: 'The callers.',
    })
    where.value = ' , '
    expect(readRestatement(form)).toBeNull()
    document.body.innerHTML = formGrillHtml(decision, RESTATEMENT)
    expect(document.querySelector('textarea[name="what"]')?.textContent).toBe('Multiply.')
    document.body.innerHTML = '<form></form>'
    const bare = document.querySelector('form')
    if (!(bare instanceof HTMLFormElement)) {
      throw new Error('no form')
    }
    expect(readRestatement(bare)).toBeNull()
  })

  it('opens as a form when chat is off, and approves through the page', async () => {
    const dialog = mountDialog()
    const onApprove = vi.fn()
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: syntheticTourBundle(),
      onApprove,
      onReader: () => {},
    })
    await grill.open(decision, undefined)
    expect(dialog.open).toBe(true)
    const form = dialog.querySelector('form[data-act="restate"]')
    const unchanged = dialog.querySelector('textarea[name="unchanged"]')
    if (!(form instanceof HTMLFormElement && unchanged instanceof HTMLTextAreaElement)) {
      throw new Error('no form')
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(onApprove).not.toHaveBeenCalled()
    unchanged.value = 'Callers.'
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(onApprove).toHaveBeenCalledWith(decision, {
      what: 'Product',
      where: ['src/app.ts:4'],
      unchanged: 'Callers.',
    })
    expect(dialog.open).toBe(false)
    await grill.open(decision, undefined)
    click('[data-act="close-grill"]')
    expect(dialog.open).toBe(false)
    grill.stop()
  })
})

describe('the grilling with an agent', () => {
  it('opens the thread, sends the opening once, draws the restatement card, and approves it', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      answers: [
        'What should happen to the callers?',
        'Thanks.\n```restatement\n{ "what": "Multiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }\n```',
      ],
    })
    const onApprove = vi.fn()
    const bundle = chatBundle()
    const grill = createGrill({ dialog, key: '42', bundle, onApprove, onReader: () => {}, api: server.api })
    await grill.open(decision, undefined)
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('.tour-chat-h .agent')?.textContent).toBe(
      'claude · opus · read-only · one thread per tour'
    )
    expect(server.sent).toEqual([
      { message: openingMessage(decision), context: { kind: 'tour-decision', key: 'sum-over-product' } },
    ])
    expect(dialog.querySelector('.tour-msg.reader')?.textContent).toContain(
      'I want to change this decision: Product.'
    )
    expect(dialog.querySelector('.tour-msg.agent')?.textContent).toContain(
      'What should happen to the callers?'
    )
    expect(dialog.querySelector('[data-act="reverse"]')).not.toBeNull()

    const composer = dialog.querySelector('#composer')
    if (!(composer instanceof HTMLTextAreaElement)) {
      throw new Error('no composer')
    }
    composer.value = 'They stay.'
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.querySelector('.tour-restate')).not.toBeNull())
    expect(server.sent[1]?.message).toBe('They stay.')
    expect(dialog.querySelector('.tour-restate .where span')?.textContent).toBe('src/app.ts:4')
    // Reject puts the words in the box; edit turns the card into the form; approve settles.
    click('[data-act="reject"]')
    expect(/** @type {HTMLTextAreaElement} */ (dialog.querySelector('#composer')).value).toBe(
      'No, that is not it: '
    )
    click('[data-act="edit"]')
    expect(dialog.querySelector('form[data-act="restate"] textarea[name="what"]')?.textContent).toBe(
      'Multiply.'
    )
    click('[data-act="redraw"]')
    expect(dialog.querySelector('form[data-act="restate"]')).toBeNull()
    click('[data-act="approve"]')
    expect(onApprove).toHaveBeenCalledWith(decision, RESTATEMENT)
    expect(dialog.open).toBe(false)
    // Opening again does not send the opening twice: the thread already holds it.
    await grill.open(decision, RESTATEMENT)
    expect(server.sent).toHaveLength(2)
    grill.stop()
  })

  it('runs the reverse quiz, the plan restatement, and shows errors, stops, and failures', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      history: [
        {
          role: 'user',
          text: 'earlier',
          at: 'x',
          context: { kind: 'tour-decision', key: 'sum-over-product' },
        },
        { role: 'assistant', text: 'Sure.', at: 'x', incomplete: 'cancelled' },
      ],
      answers: [
        '1. Change src/app.ts.',
        '```plan\n{ "changes": [], "kept": ["sum-over-product"] }\n```',
        'ERROR',
        'CANCEL',
        'THROW',
      ],
    })
    const bundle = chatBundle()
    const grill = createGrill({
      dialog,
      key: '42',
      bundle,
      onApprove: () => {},
      onReader: () => {},
      api: server.api,
    })
    await grill.open(decision, undefined)
    // The history is drawn, and the opening is not sent again.
    expect(server.sent).toHaveLength(0)
    expect(dialog.querySelectorAll('.tour-msg.note')).toHaveLength(1)
    click('[data-act="reverse"]')
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))
    expect(server.sent[0]?.message).toBe(REVERSE_QUIZ_MESSAGE)
    await vi.waitFor(() =>
      expect(dialog.querySelector('.tour-chat-log')?.textContent).toContain('Change src/app.ts.')
    )
    grill.close()
    await grill.openPlan()
    expect(server.sent[1]).toEqual({ message: PLAN_MESSAGE, context: { kind: 'tour-plan' } })
    await vi.waitFor(() => expect(dialog.querySelector('.tour-plan-card')).not.toBeNull())
    expect(dialog.querySelector('.tour-plan-card')?.textContent).toContain('Sum over product?')
    expect(dialog.querySelector('[data-act="reverse"]')).toBeNull()
    // An agent error, a cancelled turn, and a request that fails each leave a note.
    const composer = () => /** @type {HTMLTextAreaElement} */ (dialog.querySelector('#composer'))
    const form = () => /** @type {HTMLFormElement} */ (dialog.querySelector('form[data-act="send"]'))
    composer().value = 'x'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.querySelector('.tour-chat-log')?.textContent).toContain('boom'))
    composer().value = 'y'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(dialog.querySelector('.tour-chat-log')?.textContent).toContain('stopped early (cancelled)')
    )
    composer().value = 'z'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(dialog.querySelector('.tour-chat-log')?.textContent).toContain('stopped early (offline)')
    )
    // An empty message goes nowhere.
    composer().value = '  '
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(server.sent).toHaveLength(5)
    grill.stop()
  })

  it('stops a turn in flight when the drawer closes, and survives a thread it cannot read', async () => {
    const dialog = mountDialog()
    const pending = { release: /** @type {(() => void) | null} */ (null) }
    const cancelGrill = vi.fn(async () => ({ cancelled: true }))
    const api = {
      fetchGrillHistory: async () => {
        throw new Error('no thread')
      },
      /** @type {typeof import('./tour-api.js').streamGrill} */
      streamGrill: (_key, _input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'chunk', data: { text: 'thinking' } })
          pending.release = () => resolve(undefined)
        }),
      cancelGrill,
    }
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader: () => {},
      api,
    })
    void grill.open(decision, undefined)
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="stop"]')).not.toBeNull())
    expect(dialog.querySelector('#composer')?.hasAttribute('disabled')).toBe(true)
    click('[data-act="stop"]')
    expect(cancelGrill).toHaveBeenCalled()
    pending.release?.()
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="stop"]')).toBeNull())
    grill.close()
    expect(dialog.open).toBe(false)
    grill.stop()
  })

  it('speaks through the browser after the notice, or turns audio off for this reader', async () => {
    const dialog = mountDialog()
    /** @type {Array<{ started: boolean, stopped: boolean, fire: (text: string) => void }>} */
    const recognizers = []
    class FakeSpeech {
      lang = ''
      interimResults = true
      /** @type {import('./grill.js').SpeechRecognitionLike['onresult']} */
      onresult = null
      /** @type {(() => void) | null} */
      onend = null
      /** @type {(() => void) | null} */
      onerror = null
      constructor() {
        const self = this
        recognizers.push({
          started: false,
          stopped: false,
          fire: text => {
            self.onresult?.({ results: [[{ transcript: text }]] })
            self.onend?.()
          },
        })
      }
      start() {
        const last = recognizers.at(-1)
        if (last) {
          last.started = true
        }
      }
      stop() {
        const last = recognizers.at(-1)
        if (last) {
          last.stopped = true
        }
      }
    }
    const bundle = chatBundle()
    const onReader = vi.fn()
    const server = fakeApi({
      history: [
        {
          role: 'user',
          text: 'earlier',
          at: 'x',
          context: { kind: 'tour-decision', key: 'sum-over-product' },
        },
      ],
    })
    const grill = createGrill({
      dialog,
      key: '42',
      bundle,
      onApprove: () => {},
      onReader,
      api: server.api,
      speech: FakeSpeech,
    })
    await grill.open(decision, undefined)
    click('[data-act="mic"]')
    expect(dialog.querySelector('.tour-notice')).not.toBeNull()
    click('[data-act="notice-ok"]')
    expect(bundle.reader.audioNoticeSeen).toBe(true)
    expect(onReader).toHaveBeenCalled()
    expect(recognizers[0]?.started).toBe(true)
    expect(dialog.querySelector('.tour-mic')?.getAttribute('data-state')).toBe('listening')
    recognizers[0]?.fire('keep the callers')
    expect(/** @type {HTMLTextAreaElement} */ (dialog.querySelector('#composer')).value).toBe(
      'keep the callers'
    )
    expect(dialog.querySelector('.tour-mic')?.getAttribute('data-state')).toBe('')
    // Closing while listening stops the recognizer.
    click('[data-act="mic"]')
    grill.close()
    expect(recognizers[1]?.stopped).toBe(true)
    // The other way out of the notice: audio off for this reader, and no mic after.
    const fresh = chatBundle()
    const other = createGrill({
      dialog,
      key: '42',
      bundle: fresh,
      onApprove: () => {},
      onReader,
      api: server.api,
      speech: FakeSpeech,
    })
    await other.open(decision, undefined)
    click('[data-act="mic"]')
    click('[data-act="notice-off"]')
    expect(fresh.reader.audioOff).toBe(true)
    expect(dialog.querySelector('.tour-mic')).toBeNull()
    other.stop()
    grill.stop()
    // No recognizer at all: the mic is there but disabled.
    const none = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader,
      api: server.api,
      speech: null,
    })
    await none.open(decision, undefined)
    expect(dialog.querySelector('.tour-mic')?.hasAttribute('disabled')).toBe(true)
    none.stop()
    expect(restatementCardHtml(RESTATEMENT, 3)).toContain('data-restatement="3"')
  })
})
