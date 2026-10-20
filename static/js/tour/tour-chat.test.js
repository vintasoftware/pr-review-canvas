// @ts-check
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syntheticTourBundle } from '../../../src/testing/tour-page.js'
import { ApiError } from '../api.js'
import { buildSteps } from './steps.js'
import {
  createTourChat,
  placeOfStep,
  stepOfPlace,
  threadOfTourPlace,
  TOUR_CHAT_OPEN_KEY,
  tourChats,
} from './tour-chat.js'

/** @typedef {import('../contract-types.js').TourPlace} TourPlace */
/** @typedef {import('../contract-types.js').ChatTurn} ChatTurn */

const LANDMARK = /** @type {TourPlace} */ ({ kind: 'tour-landmark', id: 'sum' })
const WHOLE = /** @type {TourPlace} */ ({ kind: 'tour' })

function chatBundle() {
  return /** @type {import('../contract-types.js').TourBundle & { tour: import('../contract-types.js').TourPageTour }} */ (
    syntheticTourBundle({ chat: { enabled: true, acpx: true, agent: 'claude', model: 'opus' } })
  )
}

/**
 * The tour chat server as the pane sees it: its threads, their turns, and the answers it streams.
 * An answer of `HOLD` waits for `release()`.
 * @param {{ threads?: Array<{ name: string, place: TourPlace, turns: ChatTurn[] }>, answers?: string[], failHistory?: boolean }} [opts]
 */
function fakeServer(opts = {}) {
  const threads = (opts.threads ?? []).map(t => ({ ...t, agent: 'claude', title: 't', createdAt: 'x' }))
  const answers = [...(opts.answers ?? [])]
  /** @type {Array<{ message: string, context: TourPlace, thread?: string }>} */
  const sent = []
  let cancels = 0
  let release = () => {}
  let made = threads.length
  return {
    sent,
    cancels: () => cancels,
    release: () => release(),
    api: {
      fetchTourThreads: async () => ({
        threads: threads.map(t => ({ ...t, turns: t.turns.length / 2 })),
        agent: 'claude',
      }),
      /** @param {string} _key @param {string} name */
      fetchTourThreadHistory: async (_key, name) => {
        if (opts.failHistory) throw new Error('no thread')
        return { name, turns: threads.find(t => t.name === name)?.turns.map(t => ({ ...t })) ?? [] }
      },
      cancelTourChat: async () => {
        cancels += 1
        return { cancelled: true }
      },
      /** @type {typeof import('./tour-api.js').streamTourChat} */
      streamTourChat: async (_key, input, streamOpts) => {
        sent.push(input)
        const answer = answers.shift() ?? 'Noted.'
        if (answer === 'BUSY') {
          throw new ApiError({ code: 'CHAT_BUSY', message: 'a chat turn is already running' }, 409)
        }
        if (answer === 'THROW') {
          throw new Error('offline')
        }
        if (answer === 'REJECT') {
          throw 'refused'
        }
        let thread = threads.find(t => t.name === input.thread)
        if (thread === undefined) {
          thread = {
            name: `t${++made}`,
            place: input.context,
            turns: [],
            agent: 'claude',
            title: 't',
            createdAt: 'x',
          }
          threads.push(thread)
        }
        const { name } = thread
        // The server keeps the question once the agent takes it, and the answer once it ends.
        thread.turns.push({ role: 'user', text: input.message, at: 'x', context: input.context })
        streamOpts.onEvent({ event: 'turn', data: { thread: name, agent: 'claude', seeded: true } })
        if (answer === 'HOLD') {
          await new Promise(resolve => {
            release = () => resolve(undefined)
          })
        }
        if (answer === 'ABORT') {
          await new Promise((_resolve, reject) => {
            streamOpts.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          })
        }
        if (answer === 'ERROR') {
          streamOpts.onEvent({ event: 'error', data: { code: 'AGENT_FAILED', message: 'boom' } })
        } else if (answer === 'CANCEL') {
          streamOpts.onEvent({ event: 'cancelled', data: {} })
        } else {
          streamOpts.onEvent({ event: 'chunk', data: { text: answer === 'HOLD' ? 'Late.' : answer } })
        }
        thread.turns.push({ role: 'assistant', text: answer, at: 'x' })
      },
    },
  }
}

/** @param {{ storage?: Pick<Storage, 'getItem' | 'setItem'> | null, reachable?: (i: number) => boolean, server?: ReturnType<typeof fakeServer> }} [opts] */
function mount(opts = {}) {
  const bundle = chatBundle()
  const steps = buildSteps(bundle.tour, bundle.options)
  document.body.innerHTML =
    '<button type="button" aria-controls="tour-ask">ask AI Chat</button><aside id="tour-ask" hidden></aside>'
  const pane = /** @type {HTMLElement} */ (document.querySelector('#tour-ask'))
  const server = opts.server ?? fakeServer()
  const onGoto = vi.fn()
  const onChange = vi.fn()
  const chat = createTourChat({
    pane,
    key: '42',
    bundle,
    steps,
    reachable: opts.reachable ?? (() => true),
    onGoto,
    onChange,
    api: server.api,
    storage: opts.storage === undefined ? null : opts.storage,
  })
  return { chat, pane, steps, server, onGoto, onChange }
}

/** @param {string} selector */
function el(selector) {
  const found = document.querySelector(selector)
  if (!(found instanceof HTMLElement)) throw new Error(`nothing at ${selector}`)
  return found
}

const box = () => /** @type {HTMLTextAreaElement} */ (el('#tour-ask-box'))
const title = () => el('#tour-ask-title').textContent
const answers = () =>
  [...document.querySelectorAll('#tour-ask-log .turn.a .prose')].map(a => a.textContent?.trim())

/** @param {string} text */
async function ask(text) {
  box().value = text
  el('#tour-ask form').dispatchEvent(new Event('submit', { cancelable: true }))
  await settle()
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the places of a tour', () => {
  it('are one per step, and lead back to it', () => {
    const bundle = chatBundle()
    const steps = buildSteps(bundle.tour, bundle.options)
    const places = steps.map(placeOfStep)
    expect(places.map(p => p.kind)).toEqual([
      'tour',
      'tour-landmark',
      'tour-landmark',
      'tour-landmark',
      'tour-landmark',
      'tour-decision',
      'tour-question',
      'tour-plan',
    ])
    expect(places.map(p => stepOfPlace(steps, p))).toEqual([-1, 1, 2, 3, 4, 5, 6, 7])
    expect(stepOfPlace(steps, { kind: 'tour-landmark', id: 'gone' })).toBe(-1)
  })

  it('have AI Chat when chat is on and the tour is not a preview', () => {
    expect(tourChats(syntheticTourBundle())).toBe(false)
    expect(tourChats(chatBundle())).toBe(true)
    expect(tourChats({ ...chatBundle(), preview: true })).toBe(false)
  })

  it('go to this agent’s newest thread of the place', () => {
    const threads = [
      { name: 'a', agent: 'claude', place: WHOLE },
      { name: 'b', agent: 'codex', place: WHOLE },
      { name: 'c', agent: 'claude', place: WHOLE },
    ]
    expect(threadOfTourPlace(threads, 'claude', WHOLE)?.name).toBe('c')
    expect(threadOfTourPlace(threads, 'codex', WHOLE)?.name).toBe('b')
    expect(threadOfTourPlace(threads, 'claude', LANDMARK)).toBeUndefined()
  })
})

describe('createTourChat', () => {
  it('opens on the thread of the step on screen and answers in it, naming the thread it made', async () => {
    const server = fakeServer({ answers: ['It sums.'] })
    const { chat, pane, onChange } = mount({ server })
    chat.follow(LANDMARK)
    expect(chat.marks()).toEqual({ open: false, thread: false, unseen: 0 })
    chat.toggle()
    expect(pane.hidden).toBe(false)
    expect(title()).toBe('landmark · Sum, not product')
    expect(el('#tour-ask-log').textContent).toContain('Ask about this stop')
    expect(box().placeholder).toBe('Ask AI Chat about this stop…')
    await ask('Why a sum?')
    expect(server.sent).toEqual([{ message: 'Why a sum?', context: LANDMARK }])
    expect(answers()).toEqual(['It sums.'])
    expect(chat.marks()).toEqual({ open: true, thread: true, unseen: 0 })
    expect(onChange).toHaveBeenCalled()
    // The next question continues the thread the first one made.
    await ask('And the test?')
    expect(server.sent[1]).toEqual({ message: 'And the test?', context: LANDMARK, thread: 't1' })
    expect(answers()).toEqual(['It sums.', 'Noted.'])
    // An empty box sends nothing.
    await ask('  ')
    expect(server.sent).toHaveLength(2)
    chat.toggle()
    expect(pane.hidden).toBe(true)
  })

  it('reads a thread that has questions, and follows the reader from step to step with their drafts', async () => {
    const server = fakeServer({
      threads: [
        {
          name: 't1',
          place: LANDMARK,
          turns: [
            { role: 'user', text: 'Why?', at: 'x' },
            { role: 'assistant', text: '', at: 'x', incomplete: 'cancelled' },
          ],
        },
      ],
    })
    const { chat } = mount({ server })
    await settle()
    chat.follow(WHOLE)
    chat.toggle()
    expect(title()).toBe('the whole tour')
    expect(box().placeholder).toBe('Ask AI Chat about this tour…')
    expect(el('#tour-ask-log').textContent).toContain('Ask about the tour')
    box().value = 'half a question'
    chat.follow(LANDMARK)
    expect(el('#tour-ask-log').textContent).toContain('Opening this thread')
    await settle()
    expect(el('#tour-ask-log .turn.u').textContent).toContain('Why?')
    expect(el('#tour-ask-log .turn.a').textContent).toContain('no answer')
    expect(el('#tour-ask-log .turn.a').textContent).toContain('the answer stopped early (cancelled)')
    expect(box().value).toBe('')
    chat.follow(WHOLE)
    expect(box().value).toBe('half a question')
    // The same step again leaves the thread as it is.
    chat.follow(WHOLE)
    expect(box().value).toBe('half a question')
  })

  it('opens a thread empty when it cannot be read', async () => {
    const server = fakeServer({ failHistory: true, threads: [{ name: 't1', place: LANDMARK, turns: [] }] })
    const { chat } = mount({ server })
    await settle()
    chat.follow(LANDMARK)
    chat.toggle()
    await settle()
    expect(el('#tour-ask-log').textContent).toContain('Ask about this stop')
  })

  it('keeps an answer coming in while the reader reads another stop, and marks it until they see it', async () => {
    const server = fakeServer({ answers: ['HOLD'] })
    const { chat } = mount({ server })
    chat.follow(LANDMARK)
    chat.toggle()
    await ask('Why a sum?')
    expect(el('[data-act="ask-stop"]').hidden).toBe(false)
    expect(box().placeholder).toBe('AI Chat is answering…')
    chat.follow(WHOLE)
    expect(box().disabled).toBe(true)
    expect(box().placeholder).toBe(
      'AI Chat is answering in “landmark · Sum, not product”. Ask here once it is done.'
    )
    expect(el('[data-act="ask-stop"]').hidden).toBe(true)
    el('[data-view="threads"]').click()
    await settle()
    expect(el('.thread-item').textContent).toContain('answering…')
    server.release()
    await settle()
    expect(chat.marks().unseen).toBe(1)
    expect(el('[data-view="threads"] .threads-new').hidden).toBe(false)
    expect(el('.thread-item').textContent).toContain('new answer')
    el('.thread-item').click()
    await settle()
    expect(answers()).toEqual(['HOLD'])
    expect(chat.marks().unseen).toBe(0)
    expect(box().disabled).toBe(false)
  })

  it('draws the answer coming in over a history read in the middle of it', async () => {
    const server = fakeServer({ answers: ['HOLD'], threads: [{ name: 't1', place: LANDMARK, turns: [] }] })
    const { chat } = mount({ server })
    await settle()
    chat.follow(LANDMARK)
    chat.toggle()
    await settle()
    await ask('Why a sum?')
    // The server has the question already; drawn again, the thread shows it once.
    el('[data-view="thread"]').click()
    await settle()
    expect(document.querySelectorAll('#tour-ask-log .turn.u')).toHaveLength(1)
    expect(document.querySelectorAll('#tour-ask-log .turn.a')).toHaveLength(1)
    server.release()
    await settle()
    expect(answers()).toEqual(['Late.'])
  })

  it('says why a question was not answered, in its answer', async () => {
    const server = fakeServer({ answers: ['BUSY', 'THROW', 'REJECT', 'ERROR', 'CANCEL'] })
    const { chat } = mount({ server })
    chat.follow(LANDMARK)
    chat.toggle()
    await ask('one')
    expect(el('#tour-ask-log .chat-warning').textContent).toContain('Another answer is still running')
    await ask('two')
    expect(document.querySelectorAll('#tour-ask-log .chat-warning')[1]?.textContent).toBe('offline')
    await ask('two and a half')
    expect(document.querySelectorAll('#tour-ask-log .chat-warning')[2]?.textContent).toBe('refused')
    await ask('three')
    expect(document.querySelectorAll('#tour-ask-log .chat-warning')[3]?.textContent).toBe('boom')
    await ask('four')
    expect(el('#tour-ask-log .turn.a:last-child').textContent).toContain('stopped')
  })

  it('stops the answer coming in', async () => {
    const server = fakeServer({ answers: ['ABORT'] })
    const { chat } = mount({ server })
    chat.follow(LANDMARK)
    chat.toggle()
    await ask('Why?')
    el('[data-act="ask-stop"]').click()
    await settle()
    expect(server.cancels()).toBe(1)
    expect(el('[data-act="ask-stop"]').hidden).toBe(true)
    // Stopping with nothing coming in does nothing.
    el('[data-act="ask-stop"]').click()
    expect(server.cancels()).toBe(1)
  })

  it('lists the threads by kind, starts one about the whole tour, and goes to a thread’s stop', async () => {
    const server = fakeServer({
      threads: [
        { name: 't1', place: WHOLE, turns: [] },
        {
          name: 't2',
          place: LANDMARK,
          turns: [
            { role: 'user', text: 'q', at: 'x' },
            { role: 'assistant', text: 'a', at: 'x' },
          ],
        },
        {
          name: 't3',
          place: { kind: 'tour-question', id: 'q-run' },
          turns: [
            { role: 'user', text: 'q', at: 'x' },
            { role: 'assistant', text: 'a', at: 'x' },
            { role: 'user', text: 'q', at: 'x' },
            { role: 'assistant', text: 'a', at: 'x' },
          ],
        },
      ],
    })
    let reachable = true
    const { chat, steps, onGoto } = mount({ server, reachable: () => reachable })
    await settle()
    chat.follow(WHOLE)
    chat.toggle()
    el('[data-view="threads"]').click()
    await settle()
    expect([...document.querySelectorAll('.thread-group')].map(g => g.textContent)).toEqual([
      'Landmarks',
      'Questions',
      'Whole tour',
    ])
    expect([...document.querySelectorAll('.thread-item .small')].map(s => s.textContent)).toEqual([
      '1 question',
      '2 questions',
      '0 questions',
    ])
    expect(el('#tour-ask-log').hidden).toBe(true)
    el('[data-thread="t2"]').click()
    await settle()
    expect(title()).toBe('landmark · Sum, not product')
    const goto = /** @type {HTMLButtonElement} */ (el('[data-act="ask-goto"]'))
    expect(goto.hidden).toBe(false)
    goto.click()
    expect(onGoto).toHaveBeenCalledWith(
      steps.findIndex(s => s.kind === 'landmark' && s.landmark.id === 'sum')
    )
    // A stop the reader cannot reach yet offers no way there.
    reachable = false
    el('[data-view="threads"]').click()
    el('[data-thread="t3"]').click()
    expect(goto.hidden).toBe(true)
    // New thread starts one about the whole tour, which names no thread.
    el('[data-view="threads"]').click()
    el('[data-act="ask-new"]').click()
    expect(title()).toBe('the whole tour')
    await ask('Overall?')
    expect(server.sent.at(-1)).toEqual({ message: 'Overall?', context: WHOLE })
    // An unknown thread opens nothing.
    el('[data-view="threads"]').click()
    const stray = document.createElement('button')
    stray.dataset['act'] = 'ask-open'
    stray.dataset['thread'] = 'gone'
    el('#tour-ask-threads').append(stray)
    stray.click()
    expect(el('#tour-ask-log').hidden).toBe(true)
  })

  it('says there are no threads yet', async () => {
    const { chat } = mount()
    chat.toggle()
    el('[data-view="threads"]').click()
    await settle()
    expect(el('#tour-ask-threads').textContent).toContain('No threads yet')
  })

  it('remembers that the reader keeps it open, and opens on the first step when they did', async () => {
    /** @type {Record<string, string>} */
    const kept = {}
    const storage = {
      getItem: (/** @type {string} */ k) => kept[k] ?? null,
      setItem: (/** @type {string} */ k, /** @type {string} */ v) => void (kept[k] = v),
    }
    const first = mount({ storage })
    first.chat.follow(WHOLE)
    first.chat.toggle()
    expect(kept[TOUR_CHAT_OPEN_KEY]).toBe('1')
    const again = mount({ storage })
    again.chat.follow(WHOLE)
    expect(again.pane.hidden).toBe(false)
    again.chat.toggle()
    expect(kept[TOUR_CHAT_OPEN_KEY]).toBe('0')
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const blocked = mount({ storage: broken })
    blocked.chat.follow(WHOLE)
    expect(blocked.pane.hidden).toBe(true)
    blocked.chat.toggle()
    expect(blocked.pane.hidden).toBe(false)
  })

  it('opens the step’s thread on focus, closes on Escape, and gives the focus back', async () => {
    const server = fakeServer({ threads: [{ name: 't1', place: LANDMARK, turns: [] }] })
    const { chat, pane } = mount({ server })
    await settle()
    chat.follow(WHOLE)
    chat.focus()
    expect(document.activeElement).toBe(box())
    chat.follow(LANDMARK)
    el('[data-view="threads"]').click()
    chat.focus()
    expect(title()).toBe('landmark · Sum, not product')
    expect(el('#tour-ask-log').hidden).toBe(false)
    chat.focus()
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(pane.hidden).toBe(true)
    expect(document.activeElement).toBe(el('[aria-controls="tour-ask"]'))
    chat.toggle()
    box().value = 'Enter sends'
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(server.sent.at(-1)?.message).toBe('Enter sends')
    box().value = 'line'
    box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    expect(box().value).toBe('line')
    // A click on plain text in the pane does nothing; closing with the focus elsewhere leaves it.
    title()
    el('#tour-ask-title').click()
    expect(pane.hidden).toBe(false)
    box().blur()
    el('[data-act="ask-close"]').click()
    expect(pane.hidden).toBe(true)
    expect(document.activeElement).toBe(document.body)
  })

  it('names no agent when the bundle has none', () => {
    const bundle = chatBundle()
    document.body.innerHTML = '<aside id="tour-ask" hidden></aside>'
    const pane = /** @type {HTMLElement} */ (document.querySelector('#tour-ask'))
    createTourChat({
      pane,
      key: '42',
      bundle: { ...bundle, chat: { enabled: true, acpx: true } },
      steps: buildSteps(bundle.tour, bundle.options),
      reachable: () => true,
      onGoto: () => {},
      onChange: () => {},
      api: fakeServer().api,
      storage: null,
    })
    expect(pane.querySelector('.ctx-line')?.textContent).toBe('agent · read-only · a thread per stop')
  })

  it('stops the answer coming in when the tour is drawn again', async () => {
    const server = fakeServer({ answers: ['ABORT'] })
    const { chat } = mount({ server })
    chat.follow(LANDMARK)
    chat.toggle()
    await ask('Why?')
    chat.stop()
    await settle()
    expect(server.cancels()).toBe(0)
  })
})
