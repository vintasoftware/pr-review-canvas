// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { ApiError } from '../api.js'
import {
  createGrill,
  CARD_MESSAGE,
  DONE_MESSAGE,
  formGrillHtml,
  grillsWithChat,
  openingMessage,
  PLAN_MESSAGE,
  readRestatement,
  restatementCardHtml,
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
  /** @type {true[]} */
  const cancels = []
  const answers = [...(opts.answers ?? [])]
  return {
    sent,
    cancels,
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
        if (answer === 'BUSY') {
          throw new ApiError({ code: 'CHAT_BUSY', message: 'a chat turn is already running' }, 409)
        }
        streamOpts.onEvent({ event: 'turn', data: { thread: 't0', agent: 'claude', seeded: true } })
        for (const piece of answer.split(' ')) {
          streamOpts.onEvent({ event: 'chunk', data: { text: `${piece} ` } })
        }
        streamOpts.onEvent({ event: 'done', data: { stopReason: 'end_turn' } })
      },
      cancelGrill: async () => {
        cancels.push(true)
        return { cancelled: true }
      },
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
  it("starts the restatement at the decision's line, or from the draft, and reads it back", () => {
    document.body.innerHTML = formGrillHtml(decision, undefined)
    expect(document.querySelector('.chat-h h2')?.textContent).toBe('Something else · Sum over product?')
    expect(document.querySelector('textarea[name="what"]')?.textContent).toBe('')
    expect(document.querySelector('textarea[name="where"]')?.textContent).toBe('src/app.ts:4')
    const form = document.querySelector('form')
    if (!(form instanceof HTMLFormElement)) {
      throw new Error('no form')
    }
    expect(readRestatement(form)).toBeNull()
    const what = form.querySelector('textarea[name="what"]')
    const unchanged = form.querySelector('textarea[name="unchanged"]')
    const where = form.querySelector('textarea[name="where"]')
    if (
      !(
        what instanceof HTMLTextAreaElement &&
        unchanged instanceof HTMLTextAreaElement &&
        where instanceof HTMLTextAreaElement
      )
    ) {
      throw new Error('no field')
    }
    unchanged.value = '  The callers.  '
    expect(readRestatement(form)).toBeNull()
    what.value = 'Product'
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
    const what = dialog.querySelector('textarea[name="what"]')
    const unchanged = dialog.querySelector('textarea[name="unchanged"]')
    if (
      !(
        form instanceof HTMLFormElement &&
        what instanceof HTMLTextAreaElement &&
        unchanged instanceof HTMLTextAreaElement
      )
    ) {
      throw new Error('no form')
    }
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(onApprove).not.toHaveBeenCalled()
    what.value = 'Product'
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
  it('opens the thread, sends the opening once, restates when the reader says enough, and approves it', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      answers: [
        'What should happen to the callers?',
        'Noted. Anything else?',
        'Thanks.\n```restatement\n{ "what": "Multiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }\n```',
      ],
    })
    const onApprove = vi.fn()
    const bundle = chatBundle()
    const grill = createGrill({ dialog, key: '42', bundle, onApprove, onReader: () => {}, api: server.api })
    await grill.open(decision, undefined)
    expect(dialog.open).toBe(true)
    expect(dialog.querySelector('.ctx-line')?.textContent).toBe(
      'claude · opus · read-only · one thread per tour'
    )
    expect(server.sent).toEqual([
      { message: openingMessage(decision), context: { kind: 'tour-decision', key: 'sum-over-product' } },
    ])
    expect(dialog.querySelector('.turn.u')?.textContent).toContain(
      'On "Sum over product?" I want neither "Sum" nor "Product".'
    )
    expect(dialog.querySelector('.turn.a')?.textContent).toContain('What should happen to the callers?')
    // The steps say where the reader is: talking it through, with finish offered under the answer.
    const now = () => dialog.querySelector('.tour-grill-steps [aria-current="step"]')?.textContent
    expect(now()).toBe('1talk it through')
    expect(dialog.querySelector('.tour-grill-guide [data-act="done"]')?.textContent).toBe('finish')

    const composer = dialog.querySelector('#composer')
    if (!(composer instanceof HTMLTextAreaElement)) {
      throw new Error('no composer')
    }
    composer.value = 'They stay.'
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(server.sent).toHaveLength(2))
    expect(server.sent[1]?.message).toBe('They stay.')
    expect(/** @type {HTMLTextAreaElement} */ (dialog.querySelector('#composer')).value).toBe('')
    // The reader may stop the questions at any time: the agent restates from what it has.
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="done"]:not([disabled])')).not.toBeNull())
    click('[data-act="done"]')
    expect(now()).toBe('2finish')
    expect(dialog.querySelector('.tour-grill-guide')?.textContent).toContain('The agent is restating')
    await vi.waitFor(() => expect(dialog.querySelector('.tour-restate')).not.toBeNull())
    expect(server.sent[2]?.message).toBe(DONE_MESSAGE)
    // A restatement to read: approve is the step, and finish is no longer offered.
    await vi.waitFor(() => expect(now()).toBe('3approve'))
    expect(dialog.querySelector('.tour-grill-steps [data-state="done"]')?.textContent).toBe(
      '✓talk it through'
    )
    expect(dialog.querySelector('[data-act="done"]')).toBeNull()
    expect(dialog.querySelector('#composer')?.getAttribute('placeholder')).toBe('Not it? Say what is wrong')
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
    expect(server.sent).toHaveLength(3)
    grill.stop()
  })

  it('offers to stop an answer that runs elsewhere and send again, dropping nothing the reader said', async () => {
    const dialog = mountDialog()
    const server = fakeApi({ answers: ['BUSY', 'What should happen to the callers?'] })
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader: () => {},
      api: server.api,
    })
    await grill.open(decision, undefined)
    // The refused opening leaves no turn behind, only the way out.
    expect(dialog.querySelectorAll('.turn')).toHaveLength(0)
    expect(dialog.querySelector('.tour-grill-guide')?.textContent).toContain(
      'Another answer is still running'
    )
    click('[data-act="busy-retry"]')
    await vi.waitFor(() => expect(dialog.querySelector('.turn.a')?.textContent).toContain('callers'))
    expect(server.cancels).toHaveLength(1)
    expect(server.sent.map(s => s.message)).toEqual([openingMessage(decision), openingMessage(decision)])
    expect(dialog.querySelector('[data-act="busy-retry"]')).toBeNull()
    grill.stop()
  })

  it('finishes from history, restates the plan, and shows errors, stops, and failures', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      history: [
        { role: 'user', text: 'about another', at: 'x', context: { kind: 'tour-decision', key: 'other' } },
        { role: 'assistant', text: 'Elsewhere.', at: 'x' },
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
    // This decision's part of the thread is drawn, and the opening is not sent again.
    expect(server.sent).toHaveLength(0)
    expect(dialog.querySelector('#grill-log')?.textContent).not.toContain('Elsewhere.')
    expect(dialog.querySelector('#grill-log')?.textContent).toContain('earlier')
    expect(dialog.querySelectorAll('.turn.a .muted.small')).toHaveLength(1)
    click('[data-act="done"]')
    await vi.waitFor(() => expect(server.sent).toHaveLength(1))
    expect(server.sent[0]?.message).toBe(DONE_MESSAGE)
    await vi.waitFor(() =>
      expect(dialog.querySelector('#grill-log')?.textContent).toContain('Change src/app.ts.')
    )
    grill.close()
    await grill.openPlan()
    expect(server.sent[1]).toEqual({ message: PLAN_MESSAGE, context: { kind: 'tour-plan' } })
    await vi.waitFor(() => expect(dialog.querySelector('.tour-plan-card')).not.toBeNull())
    expect(dialog.querySelector('.tour-plan-card')?.textContent).toContain('Sum over product?')
    expect(dialog.querySelector('[data-act="done"]')).toBeNull()
    expect(dialog.querySelector('[data-act="done"]')).toBeNull()
    // An agent error, a cancelled turn, and a request that fails each leave a note.
    const composer = () => /** @type {HTMLTextAreaElement} */ (dialog.querySelector('#composer'))
    const form = () => /** @type {HTMLFormElement} */ (dialog.querySelector('form[data-act="send"]'))
    composer().value = 'x'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(dialog.querySelector('#grill-log')?.textContent).toContain('boom'))
    composer().value = 'y'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(dialog.querySelector('#grill-log')?.textContent).toContain('stopped early (cancelled)')
    )
    composer().value = 'z'
    form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(dialog.querySelector('#grill-log')?.textContent).toContain('stopped early (offline)')
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

  it('shows a restatement only once its block is whole, not as code while it streams', async () => {
    const dialog = mountDialog()
    /** @type {string[]} */
    const seen = []
    const api = {
      fetchGrillHistory: async () => ({ name: 't0', turns: [] }),
      /** @type {typeof import('./tour-api.js').streamGrill} */
      streamGrill: async (_key, _input, opts) => {
        const log = () => dialog.querySelector('#grill-log .turn.a')?.innerHTML ?? ''
        // Before a word, the answer says it is on its way, as the canvas's AI Chat does.
        expect(dialog.querySelector('.turn.a .chat-activity')?.textContent).toMatch(/^Preparing answer/)
        opts.onEvent({ event: 'tool', data: { id: 'r1', title: 'Read src/app.ts', status: 'completed' } })
        opts.onEvent({ event: 'chunk', data: { text: 'Enough.\n```restatement\n{ "what": "Mul' } })
        await vi.waitFor(() => expect(log()).toContain('Enough.'))
        seen.push(log())
        opts.onEvent({
          event: 'chunk',
          data: { text: 'tiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }\n```' },
        })
        await vi.waitFor(() => expect(log()).toContain('data-restatement'))
        seen.push(log())
      },
      cancelGrill: async () => ({ cancelled: true }),
    }
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader: () => {},
      api,
    })
    await grill.open(decision, undefined)
    expect(seen[0]).toContain('Enough.')
    expect(seen[0]).toContain('writing the restatement…')
    expect(seen[0]).not.toContain('Mul')
    expect(seen[1]).toContain('data-restatement="t1-0"')
    expect(seen[1]).not.toContain('writing the')
    // Done, the answer keeps its elapsed time and its tool calls, and its card approves.
    expect(dialog.querySelector('.turn.a .chat-activity')?.textContent).toMatch(/^Elapsed: \d+s$/)
    expect(dialog.querySelector('.turn.a .chat-tool-calls summary')?.textContent).toBe('1 tool calls')
    expect(dialog.querySelector('.tour-grill-steps [aria-current="step"]')?.textContent).toBe('3approve')
    grill.stop()
  })

  it('offers to ask for the card, or to write it, when finish gets an answer without one', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      answers: [
        'What should happen to the callers?',
        '> What you want: multiply.',
        'Sure.\n```restatement\n{ "what": "Multiply.", "where": ["src/app.ts:4"], "unchanged": "Callers." }\n```',
      ],
    })
    const onApprove = vi.fn()
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove,
      onReader: () => {},
      api: server.api,
    })
    await grill.open(decision, undefined)
    click('[data-act="done"]')
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="ask-card"]')).not.toBeNull())
    expect(dialog.querySelector('.tour-grill-guide')?.textContent).toContain('without a card')
    expect(dialog.querySelector('[data-act="done"]')).toBeNull()
    // Writing it brings the form; cancel takes it away, and the way out stays.
    click('[data-act="write-own"]')
    expect(dialog.querySelector('#grill-log form[data-act="restate"]')).not.toBeNull()
    click('[data-act="redraw"]')
    expect(dialog.querySelector('form[data-act="restate"]')).toBeNull()
    // Asking again sends the card's format, and the card that comes back approves.
    click('[data-act="done"]')
    await vi.waitFor(() => expect(server.sent).toHaveLength(3))
    expect(server.sent[2]?.message).toBe(DONE_MESSAGE)
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="approve"]')).not.toBeNull())
    click('[data-act="approve"]')
    expect(onApprove).toHaveBeenCalledWith(decision, RESTATEMENT)
    grill.stop()
  })

  it('asks for the card in its format', async () => {
    const dialog = mountDialog()
    const server = fakeApi({ answers: ['Noted.', 'In prose.', 'Still prose.'] })
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader: () => {},
      api: server.api,
    })
    await grill.open(decision, undefined)
    click('[data-act="done"]')
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="ask-card"]')).not.toBeNull())
    click('[data-act="ask-card"]')
    await vi.waitFor(() => expect(server.sent).toHaveLength(3))
    expect(server.sent[2]?.message).toBe(CARD_MESSAGE)
    // Still no card: the way out comes back.
    await vi.waitFor(() => expect(dialog.querySelector('[data-act="ask-card"]')).not.toBeNull())
    grill.stop()
  })

  it('sends the opening again when the decision was asked but never answered', async () => {
    const dialog = mountDialog()
    const server = fakeApi({
      history: [
        {
          role: 'user',
          text: 'old opening',
          at: 'x',
          context: { kind: 'tour-decision', key: 'sum-over-product' },
        },
        { role: 'assistant', text: '', at: 'x', incomplete: 'cancelled' },
      ],
      answers: ['What should happen to the callers?'],
    })
    const grill = createGrill({
      dialog,
      key: '42',
      bundle: chatBundle(),
      onApprove: () => {},
      onReader: () => {},
      api: server.api,
    })
    await grill.open(decision, undefined)
    expect(server.sent.map(s => s.message)).toEqual([openingMessage(decision)])
    expect(dialog.querySelector('#grill-log')?.textContent).toContain('callers')
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
