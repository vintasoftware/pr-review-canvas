// @ts-check
// @vitest-environment happy-dom
// The live AI Chat pane: the context chip, streaming, the comment cards, threads, and the width.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/contract/settings.js'
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/host/capabilities.js'
import { mapReviewComment } from '../../src/github/comments.js'
import { GH_REVIEW_COMMENTS, syntheticArtifact } from '../../src/testing/synthetic.js'
import { cssEscape } from './anchors.js'
import { setChatEnabled } from './ask.js'
import { checkoutActivityText, checkoutWarningHtml } from './chat-answer.js'
import {
  answerHtml,
  CHAT_MINIMIZED_KEY,
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_KEY,
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  clampWidth,
  proposedCommentHtml,
  QUICK_QUESTIONS,
  readChatMinimized,
  readChatWidth,
  renderChatShell,
  wireChat,
  writeChatMinimized,
  writeChatWidth,
} from './chat.js'
import { proposalFingerprint, SETTLEMENT_REASON_MAX, targetsFromFiles } from './proposed-comment.js'
import { wireQuickQuestions } from './quick-questions.js'
import { createReviewSession } from './review-session.js'
import { setSelfReview, setSettled } from './self-review.js'

const artifact = syntheticArtifact()
const targets = targetsFromFiles(artifact.files)
const paths = new Set(artifact.files.map(f => f.path))

function session() {
  return createReviewSession({
    prNumber: 42,
    artifact,
    files: artifact.files,
    state: emptyState('2026-09-11T10:00:00.000Z'),
    capabilities: UNKNOWN_CAPABILITIES,
    headSha: artifact.pr.headSha,
    mergeBaseSha: artifact.pr.mergeBaseSha,
  })
}

/**
 * @param {Partial<Parameters<typeof wireChat>[0]['api']>} [api]
 * @param {Partial<Parameters<typeof wireChat>[0]>} [extra]
 */
function mount(api = {}, extra = {}) {
  setChatEnabled(true)
  const root = document.createElement('div')
  root.innerHTML = `<div class="layout">${renderChatShell({ enabled: true })}</div>`
  document.body.replaceChildren(root)
  const chat = wireChat({
    root,
    prNumber: 42,
    session: session(),
    storage: null,
    reducedMotion: true,
    api: {
      fetchThreads: async () => ({ threads: [], activeThread: null, agent: 'claude' }),
      fetchThreadHistory: async () => ({ name: 't', turns: [] }),
      selectThread: async (_pr, name) => ({ activeThread: name }),
      cancelChat: async () => ({ cancelled: true }),
      streamChat: async () => undefined,
      ...api,
    },
    ...extra,
  })
  if (chat === null) {
    throw new Error('the pane did not wire')
  }
  return { root, chat }
}

/**
 * Opens a thread the way a reader does: from its entry in the Threads tab.
 * @param {ParentNode} root
 * @param {string} name
 */
function pickThread(root, name) {
  el(root, '#side-tab-threads').click()
  el(root, `[data-thread-open="${name}"]`).click()
}

/** @param {ParentNode} root @param {string} selector */
function el(root, selector) {
  const found = root.querySelector(selector)
  if (!(found instanceof HTMLElement)) {
    throw new Error(`no ${selector}`)
  }
  return found
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  document.body.replaceChildren()
})

describe('renderChatShell', () => {
  it('renders nothing while the pane is off', () => {
    expect(renderChatShell({ enabled: false })).toBe('')
  })

  it('renders the thread head, the Threads tab, the context line, the transcript, and the composer', () => {
    const html = renderChatShell({ enabled: true, width: 400 })
    expect(html).toContain('id="thread-title"')
    expect(html).toContain('id="side-tab-threads"')
    expect(html).toContain('id="thread-index"')
    expect(html).toContain('id="new-thread"')
    expect(html).not.toContain('id="thread-close"')
    expect(html).toContain('id="chat-ctx"')
    expect(html).toContain('id="chat-log"')
    expect(html).toContain('id="chat-send"')
    expect(html).toContain('aria-valuenow="400"')
    expect(html).not.toContain('disabled')
  })

  it('puts the context line in the composer, above the message box', () => {
    const root = document.createElement('div')
    root.innerHTML = renderChatShell({ enabled: true })
    const line = el(root, '#chat-ctx-line')
    expect(line.parentElement?.id).toBe('chat-form')
    expect(line.compareDocumentPosition(el(root, '#msg')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the chat width', () => {
  it('stays between the two bounds', () => {
    expect(clampWidth(10)).toBe(CHAT_WIDTH_MIN)
    expect(clampWidth(9000)).toBe(CHAT_WIDTH_MAX)
    expect(clampWidth(Number.NaN)).toBe(CHAT_WIDTH_DEFAULT)
    expect(clampWidth(400.4)).toBe(400)
  })

  it('is remembered per browser', () => {
    /** @type {Record<string, string>} */
    const store = {}
    const storage = /** @type {Storage} */ (
      /** @type {unknown} */ ({
        getItem: (/** @type {string} */ k) => store[k] ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
          store[k] = v
        },
      })
    )
    expect(readChatWidth(storage)).toBe(CHAT_WIDTH_DEFAULT)
    writeChatWidth(storage, 9000)
    expect(store[CHAT_WIDTH_KEY]).toBe(String(CHAT_WIDTH_MAX))
    expect(readChatWidth(storage)).toBe(CHAT_WIDTH_MAX)
    expect(readChatWidth(null)).toBe(CHAT_WIDTH_DEFAULT)
  })

  it('moves the pane with the arrow keys from the handle', () => {
    const { root } = mount()
    const handle = el(root, '#chat-handle')
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(root.style.getPropertyValue('--chat-w')).toBe(`${CHAT_WIDTH_DEFAULT + 16}px`)
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(root.style.getPropertyValue('--chat-w')).toBe(`${CHAT_WIDTH_DEFAULT + 16}px`)
  })

  it('widens the pane while the handle is dragged left', () => {
    const { root } = mount()
    window.innerWidth = 1200
    el(root, '#chat-handle').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 800 }))
    expect(root.style.getPropertyValue('--chat-w')).toBe('400px')
    document.dispatchEvent(new PointerEvent('pointerup'))
    // A move after the drag ended changes nothing.
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 700 }))
    expect(root.style.getPropertyValue('--chat-w')).toBe('400px')
  })
})

describe('minimizing a docked chat', () => {
  // The pane docks into the grid above 1360px; below it the launcher opens a floating dialog.
  /** Media queries read the happy-dom viewport, not `window.innerWidth`. @param {number} width */
  const setViewportWidth = width => {
    const win = /** @type {{ happyDOM: { setViewport: (v: { width: number }) => void } }} */ (
      /** @type {unknown} */ (window)
    )
    win.happyDOM.setViewport({ width })
  }
  let previousWidth = 0
  beforeEach(() => {
    previousWidth = window.innerWidth
    setViewportWidth(1500)
  })
  afterEach(() => {
    setViewportWidth(previousWidth)
  })

  it('drops the chat column, offers the launcher, and keeps the draft', () => {
    const { root } = mount()
    const pane = el(root, '.chat')
    const launcher = el(root, '#chat-launcher')
    const box = /** @type {HTMLTextAreaElement} */ (el(root, '#msg'))
    box.value = 'draft'
    expect(pane.hidden).toBe(false)
    expect(launcher.hidden).toBe(true)

    el(root, '#chat-minimize').click()
    expect(pane.hidden).toBe(true)
    expect(el(root, '.layout').classList.contains('no-chat')).toBe(true)
    expect(launcher.hidden).toBe(false)
    expect(launcher.getAttribute('aria-expanded')).toBe('false')

    launcher.click()
    expect(pane.hidden).toBe(false)
    expect(el(root, '.layout').classList.contains('no-chat')).toBe(false)
    expect(launcher.hidden).toBe(true)
    expect(box.value).toBe('draft')
  })

  it('is remembered per browser', () => {
    /** @type {Record<string, string>} */
    const store = {}
    const storage = /** @type {Storage} */ (
      /** @type {unknown} */ ({
        getItem: (/** @type {string} */ k) => store[k] ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
          store[k] = v
        },
      })
    )
    expect(readChatMinimized(storage)).toBe(false)
    expect(readChatMinimized(null)).toBe(false)

    const { root } = mount({}, { storage })
    el(root, '#chat-minimize').click()
    expect(store[CHAT_MINIMIZED_KEY]).toBe('1')
    expect(readChatMinimized(storage)).toBe(true)

    // A reload with that memory starts minimized, out of the grid.
    const again = mount({}, { storage })
    expect(el(again.root, '.chat').hidden).toBe(true)
    expect(el(again.root, '#chat-launcher').hidden).toBe(false)
    again.root.querySelector('#chat-launcher')?.dispatchEvent(new MouseEvent('click'))
    expect(store[CHAT_MINIMIZED_KEY]).toBe('0')

    writeChatMinimized(null, true)
  })

  it('renders a minimized shell without the pane', () => {
    expect(renderChatShell({ enabled: true, minimized: true })).toContain(
      'class="chat" aria-label="AI Chat and your review" data-tab="chat" hidden'
    )
  })
})

describe('the context chip', () => {
  it('offers quick questions only for a selected context', () => {
    const { root, chat } = mount()
    const menu = wireQuickQuestions(root, { onPick: () => undefined })
    const chip = el(root, '#chat-ctx')
    try {
      chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      expect(el(root, '#qq-menu').hidden).toBe(true)
      expect(chip.tabIndex).toBe(-1)

      chat.setContext({ kind: 'file', path: 'src/app.ts' })
      chip.focus()
      expect(el(root, '#qq-menu').hidden).toBe(false)
      expect(chip.tabIndex).toBe(0)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

      el(root, '#chat-clear').click()
      chip.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      expect(el(root, '#qq-menu').hidden).toBe(true)
      expect(chip.tabIndex).toBe(-1)
    } finally {
      menu.stop()
      chat.stop()
    }
  })

  it('names the target exactly and is set, not toggled', () => {
    const { root, chat } = mount()
    expect(el(root, '#chat-ctx').textContent).toBe('whole PR')
    expect(chat.setContext({ kind: 'file', path: 'src/app.ts' })).toBe(true)
    expect(el(root, '#chat-ctx').textContent).toBe('src/app.ts')
    // The same target again is one state change in total, not a toggle back.
    expect(chat.setContext({ kind: 'file', path: 'src/app.ts' })).toBe(false)
    expect(el(root, '#chat-ctx').textContent).toBe('src/app.ts')
  })

  it('names a layer by its title', () => {
    const { root, chat } = mount()
    chat.setContext({ kind: 'layer', layerId: 'run-path' })
    expect(el(root, '#chat-ctx').textContent).toBe('layer · Run path')
  })

  it('clear is the only way back to the whole pull request', () => {
    const { root, chat } = mount()
    expect(el(root, '#chat-clear').hidden).toBe(true)
    chat.setContext({ kind: 'file', path: 'src/app.ts' })
    expect(el(root, '#chat-clear').hidden).toBe(false)
    el(root, '#chat-clear').click()
    expect(chat.context).toEqual({ kind: 'pr' })
    expect(el(root, '#chat-ctx').textContent).toBe('whole PR')
    expect(el(root, '#chat-clear').hidden).toBe(true)
  })
})

describe('sending a message', () => {
  it('shows the question, streams the answer, and re-renders it once the turn ends', async () => {
    /** @type {Array<{ message: string, context: unknown }>} */
    const sent = []
    const { root, chat } = mount({
      streamChat: async (_pr, input, opts) => {
        sent.push(input)
        opts.onEvent({
          event: 'turn',
          data: { thread: 'pr-review-a-b-42-claude-t1', agent: 'claude', seeded: true },
        })
        opts.onEvent({ event: 'chunk', data: { text: 'Yes. ' } })
        opts.onEvent({ event: 'chunk', data: { text: 'Covered at `src/app.ts:3`.' } })
      },
    })
    chat.setContext({ kind: 'file', path: 'src/app.ts' })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'is this covered?'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(sent).toEqual([{ message: 'is this covered?', context: { kind: 'file', path: 'src/app.ts' } }])
    const turns = root.querySelectorAll('.turn')
    expect(turns).toHaveLength(2)
    expect(turns[0]?.textContent).toContain('is this covered?')
    expect(turns[1]?.textContent).toContain('Covered at src/app.ts:3')
    expect(box.value).toBe('')
  })

  it('names what a sent message was about on its turn, and keeps the context for the next one', async () => {
    // With a thread per place off, the open thread takes questions about anything, so each names
    // its own place.
    const { root, chat } = mount({}, { threadPerPlace: false })
    chat.setContext({ kind: 'layer', layerId: 'run-path' })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'why this order?'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(el(root, '.turn.u .turn-ctx').textContent).toBe('about layer · Run path')
    expect(chat.context).toEqual({ kind: 'layer', layerId: 'run-path' })
  })

  it('names no place on a question asked in that place’s own thread', async () => {
    const { root, chat } = mount()
    chat.ask({ kind: 'layer', layerId: 'run-path' })
    await flush()
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'why this order?'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    // The head already says what the thread is about.
    expect(el(root, '#thread-title').textContent).toBe('layer · Run path')
    expect(root.querySelector('.turn.u .turn-ctx')).toBeNull()
  })

  it('names the context of each saved question, and none for the whole PR', async () => {
    const thread = 'pr-review-a-b-42-claude-t1'
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [{ name: thread, agent: 'claude', title: 't1', createdAt: '', turns: 2 }],
        activeThread: thread,
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: [
          { role: 'user', text: 'a', at: '', context: { kind: 'file', path: 'src/app.ts' } },
          { role: 'assistant', text: 'b', at: '' },
          { role: 'user', text: 'c', at: '', context: { kind: 'pr' } },
          { role: 'user', text: 'd', at: '' },
        ],
      }),
    })
    await flush()
    const labels = Array.from(root.querySelectorAll('.turn')).map(
      turn => turn.querySelector('.turn-ctx')?.textContent ?? null
    )
    expect(labels).toEqual(['about src/app.ts', null, null, null])
  })

  it('sends nothing for an empty box', async () => {
    let calls = 0
    const { root } = mount({
      streamChat: async () => {
        calls += 1
      },
    })
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(calls).toBe(0)
  })

  it('sends on Enter and leaves shift-Enter to the textarea', async () => {
    let calls = 0
    const { root } = mount({
      streamChat: async () => {
        calls += 1
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))
    await flush()
    expect(calls).toBe(0)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flush()
    expect(calls).toBe(1)
  })

  it('swaps send for stop while the turn runs, and shows an agent error in its answer', async () => {
    /** @type {{ run: (() => void) | null }} */
    const done = { run: null }
    const { root } = mount({
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'error', data: { code: 'AGENT_AUTH_REQUIRED', message: 'not logged in' } })
          done.run = () => resolve(undefined)
        }),
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(el(root, '#chat-stop').hidden).toBe(false)
    // The error belongs to its answer, which may be off screen by the time it arrives.
    expect(el(root, '.turn.a .chat-warning').textContent).toBe('not logged in')
    done.run?.()
    await flush()
    expect(el(root, '#chat-stop').hidden).toBe(true)
  })

  it('stops a running turn through the cancel route', async () => {
    let cancelled = 0
    const { root } = mount({
      cancelChat: async () => {
        cancelled += 1
        return { cancelled: true }
      },
    })
    el(root, '#chat-stop').click()
    await flush()
    expect(cancelled).toBe(1)
  })

  it('marks an answer the reader stopped', async () => {
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'half' } })
        opts.onEvent({ event: 'cancelled', data: {} })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(root.textContent).toContain('stopped')
  })

  it('says so when the agent answered nothing at all', async () => {
    const { root } = mount({ streamChat: async () => undefined })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(root.querySelectorAll('.turn')[1]?.textContent).toContain('no answer')
  })

  it('redraws a streaming answer once per frame rather than once per chunk', async () => {
    /** @type {Array<() => void>} */
    const frames = []
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(() => cb(0))
      return frames.length
    })
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'a' } })
        opts.onEvent({ event: 'chunk', data: { text: 'b' } })
        opts.onEvent({ event: 'chunk', data: { text: 'c' } })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(frames).toHaveLength(1)
    raf.mockRestore()
  })
})

describe('threads', () => {
  it('lists the threads and marks the active one', async () => {
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t2',
        agent: 'claude',
      }),
    })
    await flush()
    const entries = [...root.querySelectorAll('#thread-index [data-thread-open]')]
    expect(entries.map(entry => entry.querySelector('.thread-item-t')?.textContent)).toEqual([
      'first',
      'second',
    ])
    expect(entries.map(entry => entry.classList.contains('current'))).toEqual([false, true])
    expect(el(root, '#thread-title').textContent).toBe('second')
  })

  it('says how a thread starts while there is none', async () => {
    const { root } = mount()
    await flush()
    expect(el(root, '#thread-index').textContent).toContain('No threads yet')
  })

  it('starts a thread about the whole PR as a draft, made by its first question', async () => {
    /** @type {Array<{ message: string, thread?: string }>} */
    const sent = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: [{ role: 'user', text: 'an old question', at: '' }],
      }),
      streamChat: async (_pr, input) => {
        sent.push(input)
      },
    })
    await flush()
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    await flush()
    // The AI Chat tab shows the draft, and nothing is made until it is asked something.
    expect(el(root, '.chat').getAttribute('data-tab')).toBe('chat')
    expect(el(root, '#chat-log').textContent).toContain('A new thread about the whole PR.')
    expect(el(root, '#chat-log').textContent).not.toContain('an old question')
    expect(el(root, '#thread-title').textContent).toBe('New thread')
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'what changed?'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    // It names no thread: the server starts one, instead of using the thread left open.
    expect(sent).toEqual([{ message: 'what changed?', context: { kind: 'pr' } }])
  })

  it('loads the transcript of the thread the reader picks', async () => {
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => {
        asked.push(name)
        return {
          name,
          turns: [
            { role: 'user', text: 'why?', at: '' },
            { role: 'assistant', text: 'Because.', at: '', incomplete: 'cancelled' },
          ],
        }
      },
    })
    await flush()
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    // The first entry is the thread that was already open, loaded when the pane started.
    expect(asked).toEqual(['pr-review-a-b-42-claude-t1', 'pr-review-a-b-42-claude-t2'])
    expect(el(root, '.chat').getAttribute('data-tab')).toBe('chat')
    expect(el(root, '#thread-title').textContent).toBe('second')
    expect(root.querySelectorAll('.turn')).toHaveLength(2)
    expect(root.textContent).toContain('the answer stopped early (cancelled)')
  })

  it('shows the empty note for a thread with no turns', async () => {
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
    })
    await flush()
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('Ask AI Chat about a layer')
  })
})

/** A point's thread and a general one, the second open. */
const PLACED = {
  threads: [
    {
      name: 'pr-review-a-b-42-claude-t1',
      agent: 'claude',
      title: 'point · Sum instead of product',
      createdAt: '',
      turns: 2,
      anchor: /** @type {const} */ ({ kind: 'point', fingerprint: 'fp-1' }),
    },
    { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'overall', createdAt: '', turns: 1 },
  ],
  activeThread: 'pr-review-a-b-42-claude-t2',
  agent: 'claude',
}
const POINT = /** @type {const} */ ({ kind: 'point', fingerprint: 'fp-1' })
const LAYER = /** @type {const} */ ({ kind: 'layer', layerId: 'run-path' })

/** @param {ParentNode} root @param {string} message */
async function sendMessage(root, message) {
  const box = el(root, '#msg')
  if (!(box instanceof HTMLTextAreaElement)) {
    throw new Error('no box')
  }
  box.value = message
  el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flush()
}

describe('a thread per place', () => {
  it('opens a draft for a place with no thread, which its first question files under that place', async () => {
    /** @type {unknown[]} */
    const sent = []
    /** @type {string[]} */
    const loaded = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      fetchThreadHistory: async (_pr, name) => {
        loaded.push(name)
        return { name, turns: [] }
      },
      streamChat: async (_pr, input) => {
        sent.push(input)
      },
    })
    await flush()
    chat.ask(LAYER)
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('layer · Run path')
    expect(el(root, '#chat-log').textContent).toContain('A new thread about layer · Run path')
    expect(el(root, '#thread-goto').hidden).toBe(false)
    // Only the thread open at the start was loaded: a draft has no turns to fetch.
    expect(loaded).toEqual(['pr-review-a-b-42-claude-t2'])
    await sendMessage(root, 'why this order?')
    expect(sent).toEqual([{ message: 'why this order?', context: LAYER }])
  })

  it('opens the thread a place already has, and tells the server it is the open one', async () => {
    /** @type {string[]} */
    const selected = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: name.endsWith('t1') ? [{ role: 'user', text: 'is the sum intended?', at: '' }] : [],
      }),
      selectThread: async (_pr, name) => {
        selected.push(name)
        return PLACED
      },
    })
    await flush()
    chat.ask(POINT)
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('Sum instead of product')
    expect(el(root, '#chat-log').textContent).toContain('is the sum intended?')
    expect(selected).toEqual(['pr-review-a-b-42-claude-t1'])
    // Asking about the same place again stays where it is.
    chat.ask(POINT)
    await flush()
    expect(selected).toEqual(['pr-review-a-b-42-claude-t1'])
  })

  it('goes back to the latest thread about the whole PR when asked about it from a place’s thread', async () => {
    /** @type {string[]} */
    const loaded = []
    const { root, chat } = mount({
      fetchThreads: async () => ({ ...PLACED, activeThread: 'pr-review-a-b-42-claude-t1' }),
      fetchThreadHistory: async (_pr, name) => {
        loaded.push(name)
        return { name, turns: [] }
      },
    })
    await flush()
    chat.ask({ kind: 'pr' })
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('overall')
    expect(loaded).toEqual(['pr-review-a-b-42-claude-t1', 'pr-review-a-b-42-claude-t2'])
    expect(el(root, '#thread-goto').hidden).toBe(true)
  })

  it('opens a draft about the whole PR when there is no thread about it yet', async () => {
    const { root, chat } = mount({
      fetchThreads: async () => ({
        ...PLACED,
        threads: PLACED.threads.slice(0, 1),
        activeThread: 'pr-review-a-b-42-claude-t1',
      }),
    })
    await flush()
    chat.ask({ kind: 'pr' })
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('New thread')
    expect(el(root, '#chat-log').textContent).toContain('A new thread about the whole PR.')
  })

  it('takes a thread’s place from the server once the list holds it', async () => {
    // The setting was off on the server when the draft's question went: it landed in a thread
    // with no place.
    const general = {
      name: 'pr-review-a-b-42-claude-t3',
      agent: 'claude',
      title: 'why this order?',
      createdAt: '',
      turns: 1,
    }
    let listed = PLACED
    const { root, chat } = mount({
      fetchThreads: async () => listed,
      streamChat: async (_pr, _input, opts) => {
        listed = { ...PLACED, threads: [...PLACED.threads, general], activeThread: general.name }
        opts.onEvent({ event: 'turn', data: { thread: general.name, agent: 'claude', seeded: true } })
      },
    })
    await flush()
    chat.ask(LAYER)
    await flush()
    await sendMessage(root, 'why this order?')
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('why this order?')
    expect(el(root, '#thread-goto').hidden).toBe(true)
    // The layer still has no thread, so asking about it opens one rather than staying here.
    chat.ask(LAYER)
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('A new thread about layer · Run path')
  })

  it('opens another place’s thread while an answer comes in, and the answer keeps arriving in its own', async () => {
    /** @type {{ opts: { onEvent: (event: { event: string, data: unknown }) => void } | null, end: (() => void) | null }} */
    const stream = { opts: null, end: null }
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: name.endsWith('t2') ? [{ role: 'user', text: 'overall?', at: '' }] : [],
      }),
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          stream.opts = opts
          stream.end = () => resolve(undefined)
        }),
    })
    await flush()
    await sendMessage(root, 'overall?')
    chat.ask(POINT)
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('Sum instead of product')
    // Here a question waits for the answer instead of being refused.
    expect([el(root, '#chat-send').hidden, el(root, '#chat-stop').hidden]).toEqual([false, true])
    expect(el(root, '#msg').getAttribute('placeholder')).toBe(
      'AI Chat is answering in “overall”. Ask here and it goes next…'
    )
    stream.opts?.onEvent({ event: 'chunk', data: { text: 'The sum is the whole change.' } })
    await flush()
    expect(el(root, '#chat-log').textContent).not.toContain('The sum is the whole change.')
    expect(root.textContent).not.toContain('An answer is still coming in')
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    // Back in its thread, the answer is where it was left, still coming in, under its question once.
    const log = el(root, '#chat-log')
    expect(log.textContent).toContain('The sum is the whole change.')
    expect(log.querySelectorAll('.turn.u')).toHaveLength(1)
    expect(el(root, '#chat-stop').hidden).toBe(false)
    stream.end?.()
    await flush()
    expect(el(root, '#chat-stop').hidden).toBe(true)
  })

  it('marks every ask command of a place that has a thread with a dot', async () => {
    const { root } = mount({ fetchThreads: async () => PLACED })
    await flush()
    const marks = el(root, '#chat-thread-marks').textContent ?? ''
    expect(marks).toBe(
      '[data-act="ask"][data-ask-point="fp-1"] > .ask-label::after { content: "" / "thread"; }'
    )
    // The thread about the whole PR has no place, so no command carries it.
  })

  it('marks an answer that ended off screen as new until its thread is opened', async () => {
    /** @type {{ end: (() => void) | null }} */
    const stream = { end: null }
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: (_pr, input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'turn', data: { thread: input.thread, agent: 'claude', seeded: false } })
          stream.end = () => resolve(undefined)
        }),
    })
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    chat.ask(LAYER)
    await flush()
    stream.end?.()
    await flush()
    const marks = () => el(root, '#chat-thread-marks').textContent ?? ''
    expect(marks()).toContain(
      '[data-ask-point="fp-1"] > .ask-label::after { content: "" / "new answer"; background: var(--accent); }'
    )
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(false)
    const entry = el(root, '[data-thread-open="pr-review-a-b-42-claude-t1"] .thread-new')
    expect(entry.textContent).toBe('new answer')
    // Opening the thread is seeing it.
    chat.ask(POINT)
    await flush()
    expect(marks()).toContain('[data-ask-point="fp-1"] > .ask-label::after { content: "" / "thread"; }')
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(true)
    expect(root.querySelector('.thread-new')).toBeNull()
  })

  it('does not mark an answer the reader watched come in', async () => {
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: async (_pr, input, opts) => {
        opts.onEvent({ event: 'turn', data: { thread: input.thread, agent: 'claude', seeded: false } })
      },
    })
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    expect(el(root, '#chat-thread-marks').textContent).not.toContain('new answer')
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(true)
  })

  /** A point's thread whose answer comes in when the test ends it. */
  const heldAnswer = () => {
    /** @type {{ end: (() => void) | null }} */
    const stream = { end: null }
    const mounted = mount({
      fetchThreads: async () => PLACED,
      streamChat: (_pr, input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'turn', data: { thread: input.thread, agent: 'claude', seeded: false } })
          stream.end = () => resolve(undefined)
        }),
    })
    return { ...mounted, stream }
  }
  /** @param {ParentNode} root */
  const badges = root =>
    Array.from(root.querySelectorAll('.chat-new')).map(b =>
      b instanceof HTMLElement && !b.hidden ? b.textContent : null
    )

  it('counts an answer that ended in the open thread while the pane was minimized, until it opens', async () => {
    const { root, chat, stream } = heldAnswer()
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    el(root, '#chat-minimize').click()
    stream.end?.()
    await flush()
    // The AI Chat tab and the launcher both count it.
    expect(badges(root)).toEqual(['1', '1'])
    expect(el(root, '#chat-launcher .chat-new').getAttribute('aria-label')).toBe('1 answer you have not seen')
    expect(el(root, '#chat-thread-marks').textContent).toContain('"new answer"')
    el(root, '#chat-launcher').click()
    expect(badges(root)).toEqual([null, null])
    expect(el(root, '#chat-thread-marks').textContent).not.toContain('new answer')
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(true)
  })

  it('counts an answer that ended in the open thread while another tab showed, until AI Chat does', async () => {
    const { root, chat, stream } = heldAnswer()
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    el(root, '#side-tab-review').click()
    stream.end?.()
    await flush()
    expect(badges(root)).toEqual(['1', '1'])
    // The Threads tab shows the thread's answer as new; it is not seen there.
    el(root, '#side-tab-threads').click()
    expect(badges(root)).toEqual(['1', '1'])
    el(root, '#side-tab-chat').click()
    expect(badges(root)).toEqual([null, null])
  })

  it('keeps the count of a thread an ask moves away from as the pane opens', async () => {
    const { root, chat, stream } = heldAnswer()
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    el(root, '#chat-minimize').click()
    stream.end?.()
    await flush()
    // The pane opens on the layer's thread: the point's answer is still not seen.
    chat.ask(LAYER)
    await flush()
    expect(badges(root)).toEqual(['1', '1'])
    expect(el(root, '[data-thread-open="pr-review-a-b-42-claude-t1"] .thread-new').textContent).toBe(
      'new answer'
    )
  })

  it('counts every answer not seen, and shows 9 for more than 9', async () => {
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: async (_pr, input, opts) => {
        opts.onEvent({ event: 'turn', data: { thread: input.thread, agent: 'claude', seeded: false } })
      },
    })
    await flush()
    chat.ask(POINT)
    await flush()
    el(root, '#chat-minimize').click()
    for (let i = 1; i <= 10; i += 1) {
      await sendMessage(root, `question ${i}`)
      await flush()
      expect(badges(root)).toEqual([String(Math.min(i, 9)), String(Math.min(i, 9))])
    }
    expect(el(root, '#side-tab-chat .chat-new').getAttribute('aria-label')).toBe(
      '10 answers you have not seen'
    )
  })

  it('brings the thread open last time back without taking the reader off their tab', async () => {
    /** @type {{ list: ((value: typeof PLACED) => void) | null }} */
    const pending = { list: null }
    const { root } = mount({
      fetchThreads: () =>
        new Promise(resolve => {
          pending.list = resolve
        }),
    })
    el(root, '#side-tab-review').click()
    pending.list?.(PLACED)
    await flush()
    expect(el(root, '.chat').getAttribute('data-tab')).toBe('review')
    expect(el(root, '#thread-title').textContent).toBe('overall')
  })
})

describe('a place’s thread, in its corners', () => {
  /**
   * @param {string} name
   * @param {import('./chat-context.js').ChatContext} anchor
   * @param {number} turns
   */
  const placed = (name, anchor, turns) => ({
    name,
    agent: 'claude',
    title: `saved ${name}`,
    createdAt: '',
    turns,
    anchor,
  })

  it('marks the ask command of every kind of place, and none for a thread not asked anything yet', async () => {
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          placed('t1', LAYER, 1),
          placed('t2', { kind: 'file', path: 'src/app.ts' }, 2),
          placed('t3', { kind: 'lines', path: 'src/app.ts', side: 'old', start: 3, end: 4 }, 3),
          placed('t4', POINT, 0),
        ],
        activeThread: null,
        agent: 'claude',
      }),
    })
    await flush()
    const path = cssEscape('src/app.ts')
    expect((el(root, '#chat-thread-marks').textContent ?? '').split('\n')).toEqual([
      '[data-act="ask"][data-ask-layer="run-path"] > .ask-label::after { content: "" / "thread"; }',
      `[data-act="ask"][data-ask-path="${path}"]:not([data-ask-start]) > .ask-label::after { content: "" / "thread"; }`,
      `[data-act="ask"][data-ask-path="${path}"][data-ask-side="old"][data-ask-start="3"][data-ask-end="4"] > .ask-label::after { content: "" / "thread"; }`,
    ])
  })

  it('keeps a thread whose place left the canvas readable, asking its questions about the whole PR', async () => {
    /** @type {unknown[]} */
    const sent = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [placed('t1', POINT, 1), placed('t2', { kind: 'point', fingerprint: 'gone' }, 1)],
        activeThread: 't2',
        agent: 'claude',
      }),
      streamChat: async (_pr, input) => {
        sent.push(input)
      },
    })
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('saved t2 · not on this canvas')
    expect(el(root, '#thread-goto').hidden).toBe(true)
    const titles = [...root.querySelectorAll('#thread-index .thread-item-t')].map(item => item.textContent)
    expect(titles).toEqual(['Sum instead of product', 'saved t2'])
    await sendMessage(root, 'still there?')
    expect(sent).toEqual([{ message: 'still there?', context: { kind: 'pr' }, thread: 't2' }])
  })

  it('counts questions in the index, and says which thread an answer is coming into', async () => {
    /** @type {{ run: (() => void) | null }} */
    const done = { run: null }
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [placed('t1', POINT, 1), placed('t2', LAYER, 3)],
        activeThread: 't2',
        agent: 'claude',
      }),
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'turn', data: { thread: 't2', agent: 'claude', seeded: false } })
          done.run = () => resolve(undefined)
        }),
    })
    await flush()
    const statuses = () =>
      [...root.querySelectorAll('#thread-index .thread-item .muted')].map(item => item.textContent)
    expect(statuses()).toEqual(['1 question', '3 questions'])
    await sendMessage(root, 'more?')
    expect(statuses()).toEqual(['1 question', 'answering…'])
    done.run?.()
    await flush()
  })

  it('leads the canvas to the open thread’s place, whatever kind of place it is', async () => {
    const { root, chat } = mount()
    await flush()
    const card = document.createElement('li')
    card.setAttribute('data-point', '')
    card.setAttribute('data-fingerprint', 'fp-1')
    root.append(card)
    chat.ask(POINT)
    await flush()
    el(root, '#thread-goto').click()
    expect(card.classList.contains('is-target')).toBe(true)

    const layerKey = artifact.layers.find(layer => layer.id === 'run-path')?.key
    /** @type {Array<[import('./chat-context.js').ChatContext, string]>} */
    const places = [
      [LAYER, `#layer:${layerKey}`],
      [{ kind: 'file', path: 'src/app.ts' }, '#file:src/app.ts'],
      [{ kind: 'lines', path: 'src/app.ts', side: 'new', start: 3, end: 3 }, '#line:src/app.ts:3'],
      [{ kind: 'lines', path: 'src/app.ts', side: 'old', start: 3, end: 4 }, '#line:src/app.ts:3-4:old'],
    ]
    for (const [place, hash] of places) {
      chat.ask(place)
      await flush()
      el(root, '#thread-goto').click()
      expect([place.kind, location.hash]).toEqual([place.kind, hash])
    }
  })

  it('keeps a draft’s answer and a waiting question with their own threads as the reader moves around', async () => {
    /** @type {Array<{ onEvent: (event: { event: string, data: unknown }) => void, end: () => void }>} */
    const streams = []
    /** @type {unknown[]} */
    const sent = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: (_pr, input, opts) =>
        new Promise(resolve => {
          sent.push(input)
          streams.push({ onEvent: opts.onEvent, end: () => resolve(undefined) })
        }),
    })
    await flush()
    const log = () => el(root, '#chat-log').textContent ?? ''
    chat.ask(LAYER)
    await flush()
    await sendMessage(root, 'why this order?')
    streams[0]?.onEvent({ event: 'chunk', data: { text: 'Because run() reads it first.' } })
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    // Back to the layer's draft: its question and the answer so far come back with it.
    chat.ask(LAYER)
    await flush()
    expect(log()).toContain('why this order?')
    expect(log()).toContain('Because run() reads it first.')
    expect(log()).not.toContain('is the sum intended?')
    // And back to the point: its question still waits there.
    chat.ask(POINT)
    await flush()
    expect(log()).toContain('is the sum intended?')
    expect(log()).toContain(
      'Waiting for the answer in “layer · Run path”. It is sent as soon as that answer ends.'
    )
    // The reader moves on; the layer's thread is named and its answer ends off screen.
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    streams[0]?.onEvent({
      event: 'turn',
      data: { thread: 'pr-review-a-b-42-claude-t3', agent: 'claude', seeded: true },
    })
    streams[0]?.end()
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('overall')
    expect(sent).toEqual([
      { message: 'why this order?', context: LAYER },
      { message: 'is the sum intended?', context: POINT, thread: 'pr-review-a-b-42-claude-t1' },
    ])
    // The point's answer is coming in off screen, and is there once its thread opens.
    streams[1]?.onEvent({ event: 'chunk', data: { text: 'The spec asks for a sum.' } })
    pickThread(root, 'pr-review-a-b-42-claude-t1')
    await flush()
    expect(log()).toContain('is the sum intended?')
    expect(log()).toContain('The spec asks for a sum.')
    expect(el(root, '#chat-stop').hidden).toBe(false)
    streams[1]?.end()
    await flush()
  })

  it('leaves send as it was while answers come in, and turns it off while a question waits', async () => {
    /** @type {Array<() => void>} */
    const ends = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: () =>
        new Promise(resolve => {
          ends.push(() => resolve(undefined))
        }),
    })
    await flush()
    const send = /** @type {HTMLButtonElement} */ (el(root, '#chat-send'))
    await sendMessage(root, 'overall?')
    chat.ask(POINT)
    await flush()
    // The answer coming in is the other thread's; this thread's send waits for nothing.
    expect([send.textContent, send.disabled, send.hidden]).toEqual(['send', false, false])
    await sendMessage(root, 'is the sum intended?')
    expect([send.textContent, send.disabled]).toEqual(['send', true])
    ends[0]?.()
    await flush()
    // The waiting question went, and is answered here, so stop takes send's place.
    expect([send.hidden, send.disabled, el(root, '#chat-stop').hidden]).toEqual([true, false, false])
    ends[1]?.()
    await flush()
    expect([send.textContent, send.disabled, send.hidden]).toEqual(['send', false, false])
  })

  it('says in its answer that a question did not reach the agent', async () => {
    const { root } = mount({
      streamChat: async () => {
        throw new Error('a canvas generation holds the review checkout')
      },
    })
    await sendMessage(root, 'is this covered?')
    expect(el(root, '.turn.a .chat-warning').textContent).toBe(
      'a canvas generation holds the review checkout'
    )
    expect(el(root, '#chat-send').hidden).toBe(false)
  })

  it('brings a live answer back with proposal cards that work', async () => {
    /** @type {Array<[string, string]>} */
    const seen = []
    /** @type {{ end: (() => void) | null }} */
    const stream = { end: null }
    const { root, chat } = mount(
      {
        fetchThreads: async () => PLACED,
        streamChat: (_pr, _input, opts) =>
          new Promise(resolve => {
            opts.onEvent({
              event: 'chunk',
              data: { text: '```comment\n{"path":"src/app.ts","line":3,"body":"FIRST"}\n```\n' },
            })
            stream.end = () => resolve(undefined)
          }),
      },
      { onProposed: (what, comment) => seen.push([what, comment.body]) }
    )
    await flush()
    await sendMessage(root, 'overall?')
    await new Promise(resolve => setTimeout(resolve, 30))
    chat.ask(POINT)
    await flush()
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    el(root, '[data-act="proposed-post"]').click()
    expect(seen).toEqual([['post', 'FIRST']])
    stream.end?.()
    await flush()
  })

  it('keeps a question refused off screen with its thread, says so where the reader is, and marks no new answer', async () => {
    /** @type {Array<{ end: () => void, fail: (error: Error) => void }>} */
    const streams = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: () =>
        new Promise((resolve, reject) => {
          streams.push({ end: () => resolve(undefined), fail: reject })
        }),
    })
    await flush()
    await sendMessage(root, 'overall?')
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    chat.ask(LAYER)
    await flush()
    streams[0]?.end()
    await flush()
    streams[1]?.fail(new Error('a canvas generation holds the review checkout'))
    await flush()
    expect(root.querySelector('.toast')?.textContent).toBe(
      'Your question in “Sum instead of product” was not sent: a canvas generation holds the review checkout'
    )
    expect(el(root, '#chat-thread-marks').textContent).not.toContain('new answer')
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(true)
    // In its thread, the question and the reason are there.
    chat.ask(POINT)
    await flush()
    const log = el(root, '#chat-log').textContent ?? ''
    expect(log).toContain('is the sum intended?')
    expect(log).toContain('a canvas generation holds the review checkout')
  })

  it('counts a question the agent took as asked, even when its answer breaks off screen', async () => {
    /** @type {Array<{ onEvent: (event: { event: string, data: unknown }) => void, end: () => void, fail: (error: Error) => void }>} */
    const streams = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: name.endsWith('t1') ? [{ role: 'user', text: 'is the sum intended?', at: '' }] : [],
      }),
      streamChat: (_pr, _input, opts) =>
        new Promise((resolve, reject) => {
          streams.push({ onEvent: opts.onEvent, end: () => resolve(undefined), fail: reject })
        }),
    })
    await flush()
    await sendMessage(root, 'overall?')
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    chat.ask(LAYER)
    await flush()
    streams[0]?.end()
    await flush()
    streams[1]?.onEvent({
      event: 'turn',
      data: { thread: 'pr-review-a-b-42-claude-t1', agent: 'claude', seeded: false },
    })
    streams[1]?.fail(new Error('the connection to the server was lost'))
    await flush()
    // The agent took it, so it was sent: no "not sent", and its thread has an answer to see.
    expect(root.querySelector('.toast')).toBeNull()
    expect(el(root, '#side-tab-threads .threads-new').hidden).toBe(false)
    chat.ask(POINT)
    await flush()
    const questions = [...root.querySelectorAll('#chat-log .turn.u')].map(turn => turn.textContent)
    expect(questions.filter(text => text?.includes('is the sum intended?'))).toHaveLength(1)
  })

  it('brings a refused question from new thread back in the next new thread', async () => {
    /** @type {Array<{ end: () => void, fail: (error: Error) => void }>} */
    const streams = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: () =>
        new Promise((resolve, reject) => {
          streams.push({ end: () => resolve(undefined), fail: reject })
        }),
    })
    await flush()
    await sendMessage(root, 'overall?')
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    await flush()
    await sendMessage(root, 'what changed overall?')
    chat.ask(POINT)
    await flush()
    streams[0]?.end()
    await flush()
    streams[1]?.fail(new Error('a canvas generation holds the review checkout'))
    await flush()
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    await flush()
    const log = el(root, '#chat-log').textContent ?? ''
    expect(log).toContain('what changed overall?')
    expect(log).toContain('a canvas generation holds the review checkout')
    // Once seen, it is not brought back again.
    chat.ask(POINT)
    await flush()
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    await flush()
    expect(el(root, '#chat-log').textContent).not.toContain('what changed overall?')
  })

  it('says where the reader is that a quick question cannot go yet, and leaves the box alone', async () => {
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      streamChat: () => new Promise(() => {}),
    })
    await flush()
    await sendMessage(root, 'overall?')
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    chat.askQuestion(LAYER, 'What could break?')
    await flush()
    expect(/** @type {HTMLTextAreaElement} */ (el(root, '#msg')).value).toBe('')
    expect(root.querySelector('.toast')?.textContent).toBe(
      'A question already waits for the answer in “overall”. Ask this once it is sent.'
    )
  })

  it('records the thread a draft on screen gets as the one a reload opens, and only that one', async () => {
    /** @type {string[]} */
    const selected = []
    /** @type {Array<() => void>} */
    const ends = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      selectThread: async (_pr, name) => {
        selected.push(name)
        return { activeThread: name }
      },
      streamChat: (_pr, input, opts) =>
        new Promise(resolve => {
          ends.push(() => {
            opts.onEvent({
              event: 'turn',
              data: { thread: input.thread ?? 'pr-review-a-b-42-claude-t3', agent: 'claude', seeded: true },
            })
            resolve(undefined)
          })
        }),
    })
    await flush()
    chat.ask(LAYER)
    await flush()
    await sendMessage(root, 'why this order?')
    ends[0]?.()
    await flush()
    expect(selected).toEqual(['pr-review-a-b-42-claude-t3'])
    // A draft's question named off screen does not take a reload away from the thread on screen.
    chat.ask(LAYER)
    chat.ask({ kind: 'file', path: 'src/app.ts' })
    await flush()
    await sendMessage(root, 'and this file?')
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    ends[1]?.()
    await flush()
    expect(selected).toEqual(['pr-review-a-b-42-claude-t3', 'pr-review-a-b-42-claude-t2'])
  })

  it('sends a question asked elsewhere during an answer once that answer ends, to its own thread', async () => {
    /** @type {Array<() => void>} */
    const ends = []
    /** @type {unknown[]} */
    const sent = []
    const { root, chat } = mount({
      streamChat: (_pr, input) =>
        new Promise(resolve => {
          sent.push(input)
          ends.push(() => resolve(undefined))
        }),
    })
    await flush()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    // New thread opens a fresh draft, not the draft whose answer is coming in.
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('New thread')
    expect(el(root, '#chat-log').textContent).not.toContain('is the sum intended?')
    chat.askQuestion(LAYER, 'What could break?')
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('layer · Run path')
    expect(sent).toHaveLength(1)
    expect(el(root, '#chat-log').textContent).toContain('Waiting for the answer in “Sum instead of product”.')
    const box = el(root, '#msg')
    expect(box.hasAttribute('disabled')).toBe(true)
    expect(box.getAttribute('placeholder')).toBe(
      'A question already waits for the answer in “Sum instead of product”.'
    )
    ends[0]?.()
    await flush()
    expect(sent).toEqual([
      { message: 'is the sum intended?', context: POINT },
      { message: 'What could break?', context: LAYER },
    ])
    expect(el(root, '#chat-log').textContent).not.toContain('Waiting for the answer in')
    expect(el(root, '#chat-stop').hidden).toBe(false)
    ends[1]?.()
    await flush()
  })
})

describe('with a thread per place off', () => {
  it('only says what the open thread’s next question is about', async () => {
    /** @type {string[]} */
    const loaded = []
    /** @type {unknown[]} */
    const sent = []
    const { root, chat } = mount(
      {
        fetchThreads: async () => PLACED,
        fetchThreadHistory: async (_pr, name) => {
          loaded.push(name)
          return { name, turns: [] }
        },
        streamChat: async (_pr, input) => {
          sent.push(input)
        },
      },
      { threadPerPlace: false }
    )
    await flush()
    chat.ask(POINT)
    await flush()
    // The point has a thread, but the open one keeps the question.
    expect(loaded).toEqual(['pr-review-a-b-42-claude-t2'])
    expect(el(root, '#thread-title').textContent).toBe('overall')
    expect(el(root, '#chat-ctx-line').hidden).toBe(false)
    expect(el(root, '#chat-ctx').textContent).toBe('point · Sum instead of product')
    expect(el(root, '#chat-thread-marks').textContent).toBe('')
    await sendMessage(root, 'is the sum intended?')
    expect(sent).toEqual([
      { message: 'is the sum intended?', context: POINT, thread: 'pr-review-a-b-42-claude-t2' },
    ])
  })

  it('starts a new thread with a question about a place asked after new thread', async () => {
    /** @type {unknown[]} */
    const sent = []
    const { root, chat } = mount(
      {
        fetchThreads: async () => PLACED,
        streamChat: async (_pr, input) => {
          sent.push(input)
        },
      },
      { threadPerPlace: false }
    )
    await flush()
    el(root, '#side-tab-threads').click()
    el(root, '#new-thread').click()
    chat.ask(POINT)
    await flush()
    await sendMessage(root, 'is the sum intended?')
    // It names no thread, so the server starts one rather than use the thread the reader left.
    expect(sent).toEqual([{ message: 'is the sum intended?', context: POINT }])
  })

  it('sends a quick question to the open thread', async () => {
    /** @type {unknown[]} */
    const sent = []
    const { chat } = mount(
      {
        fetchThreads: async () => PLACED,
        streamChat: async (_pr, input) => {
          sent.push(input)
        },
      },
      { threadPerPlace: false }
    )
    await flush()
    chat.askQuestion(LAYER, 'What could break?')
    await flush()
    expect(sent).toEqual([
      { message: 'What could break?', context: LAYER, thread: 'pr-review-a-b-42-claude-t2' },
    ])
  })

  it('follows the setting when the reader changes it, without a reload', async () => {
    /** @type {unknown[]} */
    const sent = []
    const { root, chat } = mount(
      {
        fetchThreads: async () => PLACED,
        streamChat: async (_pr, input) => {
          sent.push(input)
        },
      },
      { threadPerPlace: false }
    )
    await flush()
    // Off, an ask about the point only set the context of the open thread.
    chat.ask(POINT)
    chat.followSettings({ ...DEFAULT_SETTINGS, chatThreadPerPlace: true })
    await flush()
    expect(el(root, '#chat-ctx-line').hidden).toBe(true)
    expect(el(root, '#chat-thread-marks').textContent).toContain('data-ask-point="fp-1"')
    // The open thread is about the whole PR again, so the next question is too.
    await sendMessage(root, 'overall?')
    // And an ask about the point opens the point's thread.
    chat.ask(POINT)
    await flush()
    expect(el(root, '#thread-title').textContent).toBe('Sum instead of product')
    expect(sent).toEqual([
      { message: 'overall?', context: { kind: 'pr' }, thread: 'pr-review-a-b-42-claude-t2' },
    ])
    chat.followSettings({ ...DEFAULT_SETTINGS, chatThreadPerPlace: false })
    expect(el(root, '#chat-ctx-line').hidden).toBe(false)
    expect(el(root, '#chat-thread-marks').textContent).toBe('')
  })

  it('continues the new agent’s threads once the reader switches agents', async () => {
    let agent = 'claude'
    const { root, chat } = mount({ fetchThreads: async () => ({ ...PLACED, agent }) })
    await flush()
    agent = 'codex'
    chat.followSettings({ ...DEFAULT_SETTINGS, chatAgent: 'codex' })
    await flush()
    // The point's thread is claude's: its badge goes, and an ask starts codex's thread.
    expect(el(root, '#chat-thread-marks').textContent).toBe('')
    chat.ask(POINT)
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('A new thread about point · Sum instead of product')
  })
})

describe('the unseen bubble', () => {
  it('appears while the reader is scrolled up and jumps back on click', async () => {
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'a' } })
      },
    })
    const log = el(root, '#chat-log')
    // happy-dom reports no layout, so the scroll numbers are set by hand.
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    const chat = root.querySelector('#chat-unseen')
    expect(chat instanceof HTMLElement && chat.hidden).toBe(true)

    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    // A message the reader sends re-pins, so the bubble only shows for what arrives after.
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    box.value = 'y'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(el(root, '#chat-unseen').hidden).toBe(true)
  })
})

describe('answerHtml', () => {
  it('keeps proposal identities when earlier files leave the diff across two updates', () => {
    const filePaths = ['first.ts', 'second.ts', 'third.ts']
    const text = filePaths
      .map(path => '```comment\n' + JSON.stringify({ path, line: 1, body: 'Test this.' }) + '\n```')
      .join('\n')
    const render = (/** @type {string[]} */ present) => {
      const sink = new Map()
      answerHtml(
        text,
        { hasPath: path => present.includes(path), hasLine: () => true },
        sink,
        new Set(present),
        { turnKey: 'turn' }
      )
      return [...sink.values()]
    }
    const initial = render(filePaths)
    for (const removed of [1, 2]) {
      const remaining = render(filePaths.slice(removed))
      expect(remaining.map(c => c.proposalFingerprint)).toEqual(
        initial.slice(removed).map(c => c.proposalFingerprint)
      )
    }
  })

  it('recognizes identical proposals in another turn', () => {
    const text = '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```'
    const first = new Map()
    const second = new Map()
    answerHtml(text, targets, first, paths, { turnKey: 'first' })
    answerHtml(text, targets, second, paths, { turnKey: 'second' })
    expect([...first.values()][0].proposalFingerprint).toBe([...second.values()][0].proposalFingerprint)
  })

  it('renders a posted proposal with a view link when the answer is drawn again', () => {
    const posted = { ...mapReviewComment(GH_REVIEW_COMMENTS[0], new Set()), body: 'Rename this.', line: 3 }
    document.body.innerHTML = answerHtml(
      '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```',
      targets,
      new Map(),
      paths,
      { turnKey: 'history-0', posted: [posted] }
    )
    expect(document.querySelector('.proposed .tbtns a')?.textContent).toBe('view comment')
    expect(document.querySelector('.proposed .tbtns a')?.getAttribute('href')).toBe(posted.url)
    expect(document.querySelector('[data-act="proposed-post"]')).toBeNull()
  })
  it('renders a queued proposal as in your review when the answer is drawn again', () => {
    const queued = {
      id: 'p1',
      path: 'src/app.ts',
      line: 3,
      side: /** @type {const} */ ('new'),
      body: 'Rename this.',
      headSha: '',
      createdAt: '',
      updatedAt: '',
    }
    document.body.innerHTML = answerHtml(
      '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```',
      targets,
      new Map(),
      paths,
      { turnKey: 'history-0', pending: [queued] }
    )
    expect(document.querySelector('.proposed .tbtns .pill')?.textContent).toBe('in your review')
    expect(document.querySelector('[data-act="proposed-post"]')).toBeNull()
    expect(document.querySelector('[data-act="proposed-queue"]')).toBeNull()
  })
  it('renders a proposed comment as a card with its four commands', () => {
    /** @type {Map<string, import('./proposed-comment.js').ProposedComment>} */
    const sink = new Map()
    const html = answerHtml(
      'No, and it should be.\n\n```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```\n',
      targets,
      sink,
      paths
    )
    expect(sink.size).toBe(1)
    expect(html).toContain('proposed comment')
    expect(html).toContain('data-act="proposed-post"')
    expect(html).toContain('data-act="proposed-queue"')
    expect(html).toContain('data-act="proposed-edit"')
    expect(html).toContain('data-copy="Rename this."')
    expect(html).toContain('src/app.ts:3')
  })

  it('shows a range and the old side on the card', () => {
    expect(
      proposedCommentHtml({ path: 'a.ts', line: 5, startLine: 3, side: 'old', body: 'x' }, 'turn-1-0')
    ).toContain('a.ts:3–5 (old side)')
  })

  it('keeps a block that is not a usable comment as a code block with the reason', () => {
    /** @type {Map<string, import('./proposed-comment.js').ProposedComment>} */
    const sink = new Map()
    const html = answerHtml('```comment\n{"path":"nope.ts","line":1,"body":"x"}\n```\n', targets, sink, paths)
    expect(sink.size).toBe(0)
    expect(html).toContain('proposed-invalid')
    expect(html).toContain('not a file of this pull request')
  })

  it('renders model text as text, so raw HTML never becomes markup', () => {
    /** @type {Map<string, import('./proposed-comment.js').ProposedComment>} */
    const sink = new Map()
    const html = answerHtml('<img src=x onerror=alert(1)>', targets, sink, paths)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })
})

describe('the proposed-comment commands', () => {
  it('hands the card the reader clicked to the page', async () => {
    /** @type {Array<[string, string, string | undefined]>} */
    const seen = []
    const { root } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({
            event: 'turn',
            data: { thread: 't1', agent: 'claude', seeded: true },
          })
          opts.onEvent({
            event: 'chunk',
            data: { text: '```comment\n{"path":"src/app.ts","line":3,"body":"Rename."}\n```\n' },
          })
        },
      },
      { onProposed: (what, comment) => seen.push([what, comment.body, comment.proposalFingerprint]) }
    )
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    el(root, '[data-act="proposed-post"]').click()
    el(root, '[data-act="proposed-queue"]').click()
    el(root, '[data-act="proposed-edit"]').click()
    const fingerprint = proposalFingerprint({ path: 'src/app.ts', line: 3, side: 'new', body: 'Rename.' })
    expect(seen).toEqual([
      ['post', 'Rename.', fingerprint],
      ['queue', 'Rename.', fingerprint],
      ['edit', 'Rename.', fingerprint],
    ])
  })

  it('shows the point the agent tied a comment to, and lets the reader untie it before sending', async () => {
    /** @type {Array<[string, string | undefined]>} */
    const seen = []
    const { root } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({ event: 'turn', data: { thread: 't1', agent: 'claude', seeded: true } })
          opts.onEvent({
            event: 'chunk',
            data: {
              text: '```comment\n{"path":"src/app.ts","line":3,"body":"Rename.","point":"fp-1"}\n```\n',
            },
          })
        },
      },
      { onProposed: (what, comment) => seen.push([what, comment.point?.fingerprint]) }
    )
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no box')
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(el(root, '.proposed-point').textContent).toBe('about the point “Sum instead of product” unlink')
    el(root, '[data-act="proposed-queue"]').click()
    el(root, '[data-act="proposed-unlink"]').click()
    expect(root.querySelector('.proposed-point')).toBeNull()
    el(root, '[data-act="proposed-queue"]').click()
    expect(seen).toEqual([
      ['queue', 'fp-1'],
      ['queue', undefined],
    ])
  })

  it('draws the link from what was sent once the comment went out', () => {
    const withPoints = targetsFromFiles(artifact.files, artifact.points)
    const text = '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this.","point":"fp-1"}\n```'
    const fingerprint = proposalFingerprint({
      path: 'src/app.ts',
      line: 3,
      side: 'new',
      body: 'Rename this.',
    })
    /** @param {string | undefined} pointFingerprint */
    const queued = pointFingerprint => ({
      id: 'p1',
      path: 'src/app.ts',
      line: 3,
      side: /** @type {const} */ ('new'),
      body: 'Rename this.',
      proposalFingerprint: fingerprint,
      ...(pointFingerprint === undefined ? {} : { pointFingerprint }),
      headSha: '',
      createdAt: '',
      updatedAt: '',
    })
    document.body.innerHTML = answerHtml(text, withPoints, new Map(), paths)
    expect(document.querySelector('[data-act="proposed-unlink"]')).not.toBeNull()
    // Sent with its link: the line stays, with nothing left to untie.
    document.body.innerHTML = answerHtml(text, withPoints, new Map(), paths, { pending: [queued('fp-1')] })
    expect(document.querySelector('.proposed-point')?.textContent).toBe(
      'about the point “Sum instead of product”'
    )
    // Untied before it went out: the agent's text links it again on a redraw, the draft does not.
    document.body.innerHTML = answerHtml(text, withPoints, new Map(), paths, { pending: [queued(undefined)] })
    expect(document.querySelector('.proposed-point')).toBeNull()
  })
})

describe('a proposed resolution', () => {
  const BASE = emptyState('2026-09-10T12:00:00.000Z')
  afterEach(() => setSelfReview(false, {}))
  const author = targetsFromFiles(artifact.files, artifact.points, true)
  /** @param {string} reason */
  const answer = reason => '```resolve\n' + JSON.stringify({ point: 'fp-1', reason }) + '\n```'

  it('is a card for a reader who may resolve, with resolve, edit, and copy', () => {
    setSelfReview(true, {})
    document.body.innerHTML = answerHtml(answer('We keep it.'), author, new Map(), paths, {
      state: BASE,
    })
    const card = document.querySelector('.proposed.resolution')
    expect(card?.querySelector('.proposed-point')?.textContent).toBe(
      'about the point “Sum instead of product”'
    )
    expect([...(card?.querySelectorAll('.tbtns button') ?? [])].map(b => b.textContent)).toEqual([
      'resolve',
      'edit',
      'copy',
    ])
  })

  it('offers resolve exactly where the point does: not once resolved, nor while dismissed', () => {
    setSelfReview(true, { 'fp-1': { reason: 'Done.', at: 'x' } })
    document.body.innerHTML = answerHtml(answer('We keep it.'), author, new Map(), paths, { state: BASE })
    expect(document.querySelector('.proposed .pill.status.resolved')?.textContent).toBe('resolved')
    expect(document.querySelector('[data-act="resolution-save"]')).toBeNull()
    setSelfReview(true, {})
    const dismissed = { ...BASE, dismissed: { 'fp-1': { at: 'x' } } }
    document.body.innerHTML = answerHtml(answer('We keep it.'), author, new Map(), paths, {
      state: dismissed,
    })
    expect(document.querySelector('.proposed .tbtns')?.textContent).toContain(
      'restore the point to resolve it'
    )
    expect(document.querySelector('[data-act="resolution-save"]')).toBeNull()
  })

  it.each([
    [
      'to a reader who may not resolve here',
      targets,
      'We keep it.',
      'attention points cannot be resolved here',
    ],
    [
      'with a reason too long to save',
      author,
      'x'.repeat(SETTLEMENT_REASON_MAX + 1),
      'the reason is too long to save',
    ],
  ])('stays the agent’s own block %s', (_why, given, reason, why) => {
    document.body.innerHTML = answerHtml(answer(reason), given, new Map(), paths)
    expect(document.querySelector('.proposed')).toBeNull()
    expect(document.querySelector('.proposed-invalid code')?.textContent).toBe(
      JSON.stringify({ point: 'fp-1', reason })
    )
    expect(document.querySelector('.proposed-invalid + p')?.textContent).toBe(why)
  })

  it('hands the page the resolution, and follows its point as the state changes', async () => {
    setSelfReview(true, {})
    /** @type {Array<[string, import('./proposed-comment.js').ProposedResolution]>} */
    const seen = []
    const { root, chat } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({ event: 'turn', data: { thread: 't1', agent: 'claude', seeded: true } })
          opts.onEvent({ event: 'chunk', data: { text: answer('We keep it.') } })
        },
      },
      { onResolution: (what, resolution) => seen.push([what, resolution]) }
    )
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no box')
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    el(root, '[data-act="resolution-save"]').click()
    el(root, '[data-act="resolution-edit"]').click()
    const resolution = {
      point: { fingerprint: 'fp-1', title: 'Sum instead of product' },
      reason: 'We keep it.',
    }
    expect(seen).toEqual([
      ['save', resolution],
      ['edit', resolution],
    ])
    setSettled({ 'fp-1': { reason: 'We keep it.', at: 'x' } })
    chat.refreshProposed()
    expect(el(root, '.proposed.resolution .pill.status.resolved').textContent).toBe('resolved')
    setSettled({})
    chat.refreshProposed()
    expect(root.querySelector('[data-act="resolution-save"]')).not.toBeNull()
  })
})

describe('a refresh the cards did not ask for', () => {
  it('leaves a card whose state held as the page left it: its error, its gate, its focus', async () => {
    const { root, chat } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'turn', data: { thread: 't1', agent: 'claude', seeded: true } })
        opts.onEvent({
          event: 'chunk',
          data: { text: '```comment\n{"path":"src/app.ts","line":3,"body":"Rename.","point":"fp-1"}\n```\n' },
        })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no box')
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    const queue = el(root, '[data-act="proposed-queue"]')
    const post = el(root, '[data-act="proposed-post"]')
    const line = el(root, '.proposed-point')
    queue.insertAdjacentHTML('afterend', '<span class="cmd-err" role="alert">offline</span>')
    post.setAttribute('disabled', '')
    queue.focus()
    chat.refreshProposed()
    expect(el(root, '.proposed .cmd-err').textContent).toBe('offline')
    expect(el(root, '[data-act="proposed-post"]')).toBe(post)
    expect(post.hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).toBe(queue)
    expect(el(root, '.proposed-point')).toBe(line)
  })
})

describe('the tie a reader takes off', () => {
  afterEach(() => setSelfReview(false, {}))

  it('stays off while the answer is still being drawn, and the comment goes out untied', async () => {
    /** @type {Array<string | undefined>} */
    const seen = []
    const text = '```comment\n{"path":"src/app.ts","line":3,"body":"Rename.","point":"fp-1"}\n```\n'
    let more = () => {}
    const next = new Promise(resolve => {
      more = () => resolve(undefined)
    })
    const { root, chat } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({ event: 'turn', data: { thread: 't1', agent: 'claude', seeded: true } })
          opts.onEvent({ event: 'chunk', data: { text } })
          await next
          // A later chunk draws the whole answer again, from the agent's text.
          opts.onEvent({ event: 'chunk', data: { text: 'More.' } })
        },
      },
      { onProposed: (_what, comment) => seen.push(comment.point?.fingerprint) }
    )
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) throw new Error('no box')
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    el(root, '[data-act="proposed-unlink"]').click()
    more()
    await flush()
    expect(root.textContent).toContain('More.')
    expect(root.querySelector('.proposed-point')).toBeNull()
    chat.refreshProposed()
    expect(root.querySelector('.proposed-point')).toBeNull()
    el(root, '[data-act="proposed-queue"]').click()
    expect(seen).toEqual([undefined])
  })
})

describe('QUICK_QUESTIONS', () => {
  it('holds the fixed quick questions', () => {
    expect(QUICK_QUESTIONS).toEqual([
      'Suggestion to solve this?',
      'Why this way, and what were the alternatives?',
      'What could break?',
      'Does this follow how the codebase already does it?',
      'Is this covered by tests?',
    ])
  })
})

describe('wireChat', () => {
  it('does nothing when the pane is not on the page', () => {
    const root = document.createElement('div')
    expect(wireChat({ root, prNumber: 42, session: session(), storage: null })).toBeNull()
  })

  it('says which part of the pane is missing rather than half-wiring it', () => {
    const root = document.createElement('div')
    root.innerHTML = renderChatShell({ enabled: true })
    root.querySelector('#msg')?.remove()
    expect(() => wireChat({ root, prNumber: 42, session: session(), storage: null })).toThrow(/no #msg/)
  })

  it('takes its listeners off on stop', async () => {
    let calls = 0
    const { root, chat } = mount({
      cancelChat: async () => {
        calls += 1
        return { cancelled: true }
      },
    })
    chat.stop()
    el(root, '#chat-stop').click()
    await flush()
    expect(calls).toBe(0)
  })

  it('focuses the box when asked to', () => {
    const { root, chat } = mount()
    chat.ask({ kind: 'file', path: 'src/app.ts' })
    expect(document.activeElement).toBe(el(root, '#msg'))
    expect(chat.context).toEqual({ kind: 'file', path: 'src/app.ts' })
  })

  it('sends a quick question about the target it names', async () => {
    /** @type {Array<{ message: string, context: unknown }>} */
    const sent = []
    const { chat } = mount({
      streamChat: async (_pr, input) => {
        sent.push(input)
      },
    })
    chat.askQuestion({ kind: 'layer', layerId: 'run-path' }, 'Is this covered by tests?')
    await flush()
    expect(sent).toEqual([
      { message: 'Is this covered by tests?', context: { kind: 'layer', layerId: 'run-path' } },
    ])
  })
})

describe('the transcript position', () => {
  /** @param {HTMLElement} log */
  function fakeLayout(log) {
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
  }

  it('keeps where each thread was left when the reader switches back and forth', async () => {
    const threads = {
      threads: [
        { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
      ],
      activeThread: 'pr-review-a-b-42-claude-t1',
      agent: 'claude',
    }
    const { root } = mount({
      fetchThreads: async () => threads,
      fetchThreadHistory: async (_pr, name) => ({ name, turns: [{ role: 'user', text: 'x', at: '' }] }),
    })
    await flush()
    const log = el(root, '#chat-log')
    fakeLayout(log)
    log.scrollTop = 250
    log.dispatchEvent(new Event('scroll'))
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    // A thread seen for the first time opens at the bottom.
    expect(log.scrollTop).toBe(1000)
    log.scrollTop = 600
    log.dispatchEvent(new Event('scroll'))
    pickThread(root, 'pr-review-a-b-42-claude-t1')
    await flush()
    expect(log.scrollTop).toBe(250)
  })

  it('loads the open thread once when it starts, and not again when it is selected', async () => {
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => {
        asked.push(name)
        return { name, turns: [] }
      },
    })
    await flush()
    pickThread(root, 'pr-review-a-b-42-claude-t1')
    await flush()
    expect(asked).toEqual(['pr-review-a-b-42-claude-t1'])
  })

  it('jumps to the first unseen message from the bubble', async () => {
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'a' } })
      },
    })
    const log = el(root, '#chat-log')
    fakeLayout(log)
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'one'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    // The reader scrolls up, then an answer lands below the fold.
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    box.value = 'two'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    // The chunk of the second answer is what arrives unseen.
    const bubble = el(root, '#chat-unseen')
    if (bubble.hidden) {
      // Nothing was counted, so the bubble is hidden; clicking it still scrolls to the bottom.
      bubble.click()
      expect(log.scrollTop).toBe(1000)
      return
    }
    bubble.click()
    expect(bubble.hidden).toBe(true)
  })

  it('scrolls to the bottom when the bubble has no message to jump to', () => {
    const { root } = mount()
    const log = el(root, '#chat-log')
    fakeLayout(log)
    el(root, '#chat-unseen').click()
    expect(log.scrollTop).toBe(1000)
  })
})

describe('the wheel over the pane', () => {
  /** @param {HTMLElement} log */
  function fakeLayout(log) {
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
  }

  /** @param {Element} target */
  function wheel(target) {
    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  it('moves the transcript when the turn starts on the pane rather than in it', async () => {
    const { root } = mount()
    await flush()
    const log = el(root, '#chat-log')
    fakeLayout(log)
    log.scrollTop = 0

    // happy-dom reports the pane as sticky only if the stylesheet is loaded, so state it here.
    const pane = root.querySelector('.chat')
    if (!(pane instanceof HTMLElement)) {
      throw new Error('no pane')
    }
    pane.style.position = 'sticky'

    const header = el(root, '#chat-ctx')
    const event = wheel(header)
    expect(event.defaultPrevented).toBe(true)
    expect(log.scrollTop).toBe(120)
  })

  it('leaves a turn inside the transcript to the browser', async () => {
    const { root } = mount()
    await flush()
    const log = el(root, '#chat-log')
    fakeLayout(log)
    log.scrollTop = 0
    const pane = root.querySelector('.chat')
    if (!(pane instanceof HTMLElement)) {
      throw new Error('no pane')
    }
    pane.style.position = 'sticky'

    const event = wheel(log)
    expect(event.defaultPrevented).toBe(false)
    expect(log.scrollTop).toBe(0)
  })

  it('gives the wheel to the review list while its tab is shown, not to the hidden transcript', async () => {
    const { root } = mount()
    await flush()
    const log = el(root, '#chat-log')
    const list = el(root, '#review-panel')
    fakeLayout(log)
    fakeLayout(list)
    log.scrollTop = 0
    list.scrollTop = 0
    const pane = root.querySelector('.chat')
    if (!(pane instanceof HTMLElement)) {
      throw new Error('no pane')
    }
    pane.style.position = 'sticky'
    el(root, '#side-tab-review').click()

    // A turn inside the list is the browser's to scroll.
    list.innerHTML = '<p>a draft</p>'
    const inside = wheel(el(list, 'p'))
    expect(inside.defaultPrevented).toBe(false)
    expect(log.scrollTop).toBe(0)

    // A turn on the tabs moves the list, the one scroller on screen.
    const onTabs = wheel(el(root, '#side-tab-review'))
    expect(onTabs.defaultPrevented).toBe(true)
    expect(list.scrollTop).toBe(120)
    expect(log.scrollTop).toBe(0)
  })

  it('leaves the page alone while the pane is not pinned', async () => {
    const { root } = mount()
    await flush()
    const log = el(root, '#chat-log')
    fakeLayout(log)
    log.scrollTop = 0
    const pane = root.querySelector('.chat')
    if (!(pane instanceof HTMLElement)) {
      throw new Error('no pane')
    }
    pane.style.position = 'static'

    const event = wheel(el(root, '#chat-ctx'))
    expect(event.defaultPrevented).toBe(false)
    expect(log.scrollTop).toBe(0)
  })
})

describe('the pane wiring', () => {
  it('ignores a click that is not one of its commands', () => {
    const { root, chat } = mount()
    el(root, '#chat-log').click()
    el(root, '.chat-h').click()
    expect(chat.context).toEqual({ kind: 'pr' })
  })

  it('ignores a proposed-comment click with no card behind it', () => {
    /** @type {unknown[]} */
    const seen = []
    const { root } = mount({}, { onProposed: what => seen.push(what) })
    const stray = document.createElement('button')
    stray.setAttribute('data-act', 'proposed-post')
    stray.setAttribute('data-proposed', '7')
    root.appendChild(stray)
    stray.click()
    expect(seen).toEqual([])
  })

  it('falls back to a timer when the browser has no animation frame', async () => {
    const raf = globalThis.requestAnimationFrame
    // @ts-expect-error the fallback exists for environments without it
    globalThis.requestAnimationFrame = undefined
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'a' } })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(root.querySelectorAll('.turn')[1]?.textContent).toContain('a')
    globalThis.requestAnimationFrame = raf
  })

  it('reads the browser preference for less motion when it is not told', () => {
    const root = document.createElement('div')
    root.innerHTML = renderChatShell({ enabled: true })
    document.body.replaceChildren(root)
    const chat = wireChat({ root, prNumber: 42, session: session(), storage: null })
    expect(chat).not.toBeNull()
    chat?.stop()
  })

  it('ignores an event frame that carries nothing', async () => {
    const { root } = mount({
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'turn', data: null })
        opts.onEvent({ event: 'usage', data: { used: 1 } })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(root.querySelectorAll('.turn')).toHaveLength(2)
  })
})

describe('the pane in the last few corners', () => {
  it('narrows the pane with the right arrow', () => {
    const { root } = mount()
    el(root, '#chat-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(root.style.getPropertyValue('--chat-w')).toBe(`${CHAT_WIDTH_DEFAULT - 16}px`)
  })

  it('names the thread it is answering in on the next message', async () => {
    /** @type {Array<{ message: string, context: unknown, thread?: string }>} */
    const sent = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      streamChat: async (_pr, input) => {
        sent.push(input)
      },
    })
    await flush()
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(sent[0]?.thread).toBe('pr-review-a-b-42-claude-t1')
  })

  it('uses the browser storage when it is not given one', () => {
    const root = document.createElement('div')
    root.innerHTML = renderChatShell({ enabled: true })
    document.body.replaceChildren(root)
    localStorage.setItem(CHAT_WIDTH_KEY, '500')
    const chat = wireChat({ root, prNumber: 42, session: session() })
    expect(root.style.getPropertyValue('--chat-w')).toBe('500px')
    chat?.stop()
    localStorage.removeItem(CHAT_WIDTH_KEY)
  })
})

describe('what the review round found', () => {
  /** @param {HTMLElement} log */
  function fakeLayout(log) {
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
  }

  /** @param {HTMLElement} root @param {string} message */
  async function send(root, message) {
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = message
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
  }

  it('an older card still posts its own comment after a newer answer draws one', async () => {
    /** @type {Array<[string, string]>} */
    const seen = []
    let answer = '```comment\n{"path":"src/app.ts","line":3,"body":"FIRST"}\n```\n'
    const { root } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({ event: 'chunk', data: { text: answer } })
        },
      },
      { onProposed: (what, comment) => seen.push([what, comment.body]) }
    )
    await send(root, 'one')
    answer = '```comment\n{"path":"src/app.ts","line":11,"body":"SECOND"}\n```\n'
    await send(root, 'two')
    const posts = [...root.querySelectorAll('[data-act="proposed-post"]')]
    expect(posts).toHaveLength(2)
    for (const post of posts) {
      if (post instanceof HTMLElement) {
        post.click()
      }
    }
    expect(seen).toEqual([
      ['post', 'FIRST'],
      ['post', 'SECOND'],
    ])
  })

  it('counts an answer that arrives while the reader is scrolled up, once', async () => {
    /** @type {{ chunk: ((text: string) => void) | null, end: (() => void) | null }} */
    const stream = { chunk: null, end: null }
    const { root } = mount({
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          stream.chunk = text => opts.onEvent({ event: 'chunk', data: { text } })
          stream.end = () => resolve(undefined)
        }),
    })
    const log = el(root, '#chat-log')
    fakeLayout(log)
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'one'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    // The reader scrolls away while the answer is still arriving.
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    stream.chunk?.('a')
    stream.chunk?.('b')
    const bubble = el(root, '#chat-unseen')
    expect(bubble.hidden).toBe(false)
    expect(bubble.textContent).toBe('1 new message ↓')
    bubble.click()
    expect(bubble.hidden).toBe(true)
    stream.end?.()
    await flush()
  })

  it('keeps every thread open while an answer comes in, and says which one waits', async () => {
    /** @type {Array<() => void>} */
    const ends = []
    /** @type {unknown[]} */
    const sent = []
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => {
        asked.push(name)
        return { name, turns: [] }
      },
      streamChat: (_pr, input, opts) =>
        new Promise(resolve => {
          sent.push(input)
          opts.onEvent({ event: 'turn', data: { thread: input.thread, agent: 'claude', seeded: false } })
          ends.push(() => resolve(undefined))
        }),
    })
    await flush()
    await sendMessage(root, 'x')
    const status = (/** @type {string} */ name) => el(root, `[data-thread-open="${name}"] .muted`).textContent
    expect(el(root, '#new-thread').hasAttribute('disabled')).toBe(false)
    expect(status('pr-review-a-b-42-claude-t1')).toBe('answering…')
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    expect(asked).toEqual(['pr-review-a-b-42-claude-t1', 'pr-review-a-b-42-claude-t2'])
    await sendMessage(root, 'y')
    expect(status('pr-review-a-b-42-claude-t2')).toBe('question waiting')
    ends[0]?.()
    await flush()
    expect(sent).toEqual([
      { message: 'x', context: { kind: 'pr' }, thread: 'pr-review-a-b-42-claude-t1' },
      { message: 'y', context: { kind: 'pr' }, thread: 'pr-review-a-b-42-claude-t2' },
    ])
    expect(status('pr-review-a-b-42-claude-t2')).toBe('answering…')
    ends[1]?.()
    await flush()
  })

  it('stops the request when the pane is taken down mid-answer, and drops the question waiting for it', async () => {
    /** @type {AbortSignal | undefined} */
    let signal
    /** @type {string[]} */
    const sent = []
    const { root, chat } = mount({
      fetchThreads: async () => PLACED,
      // As fetch does, the request fails once it is aborted.
      streamChat: (_pr, input, opts) =>
        new Promise((_resolve, reject) => {
          sent.push(input.message)
          signal = opts.signal
          opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    })
    await flush()
    await send(root, 'x')
    chat.ask(POINT)
    await flush()
    await send(root, 'waiting')
    expect(chat.holdsUnsent()).toBe(true)
    expect(signal?.aborted).toBe(false)
    chat.stop()
    await flush()
    expect(signal?.aborted).toBe(true)
    // The waiting question went nowhere, and the aborted turn drew nothing.
    expect(sent).toEqual(['x'])
    expect(chat.holdsUnsent()).toBe(false)
    expect(root.querySelector('.chat-warning')).toBeNull()
  })

  it('writes the target onto the chip, so a quick question from it keeps the target', () => {
    const { root, chat } = mount()
    chat.setContext({ kind: 'lines', path: 'src/app.ts', side: 'old', start: 2, end: 4 })
    const chip = el(root, '#chat-ctx')
    expect(chip.getAttribute('data-ask-path')).toBe('src/app.ts')
    expect(chip.getAttribute('data-ask-side')).toBe('old')
    expect(chip.getAttribute('data-ask-start')).toBe('2')
    chat.setContext({ kind: 'layer', layerId: 'run-path' })
    expect(chip.getAttribute('data-ask-path')).toBeNull()
    expect(chip.getAttribute('data-ask-layer')).toBe('run-path')
  })
})

describe('taking the pane down while it is drawing', () => {
  it('cancels the redraw that was scheduled for the next frame', async () => {
    /** @type {Array<() => void>} */
    const frames = []
    let cancelled = 0
    const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(cb => {
      frames.push(() => cb(0))
      return frames.length
    })
    const caf = vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {
      cancelled += 1
    })
    /** @type {{ end: (() => void) | null }} */
    const stream = { end: null }
    const { root, chat } = mount({
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          opts.onEvent({ event: 'chunk', data: { text: 'a' } })
          stream.end = () => resolve(undefined)
        }),
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    chat.stop()
    expect(cancelled).toBe(1)
    stream.end?.()
    await flush()
    raf.mockRestore()
    caf.mockRestore()
  })
})

describe('what the second review round found', () => {
  /** @param {HTMLElement} log */
  function fakeLayout(log) {
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
  }

  it('leaves a question alone when the history it was waiting for arrives late', async () => {
    /** @type {{ release: (() => void) | null }} */
    const history = { release: null }
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: (_pr, name) =>
        new Promise(resolve => {
          history.release = () =>
            resolve({ name, turns: [{ role: 'user', text: 'an old question', at: '' }] })
        }),
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'the new answer' } })
      },
    })
    await flush()
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'a new question'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    history.release?.()
    await flush()
    const text = el(root, '#chat-log').textContent ?? ''
    expect(text).toContain('a new question')
    expect(text).toContain('the new answer')
    expect(text).not.toContain('an old question')
  })

  it('counts an answer again when the reader catches up and then drifts away', async () => {
    /** @type {{ chunk: ((text: string) => void) | null, end: (() => void) | null }} */
    const stream = { chunk: null, end: null }
    const { root } = mount({
      streamChat: (_pr, _input, opts) =>
        new Promise(resolve => {
          stream.chunk = text => opts.onEvent({ event: 'chunk', data: { text } })
          stream.end = () => resolve(undefined)
        }),
    })
    const log = el(root, '#chat-log')
    fakeLayout(log)
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'one'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    const bubble = el(root, '#chat-unseen')
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    stream.chunk?.('a')
    expect(bubble.hidden).toBe(false)
    // Back at the bottom: nothing is waiting any more.
    log.scrollTop = 1000
    log.dispatchEvent(new Event('scroll'))
    expect(bubble.hidden).toBe(true)
    // Away again, in the same answer: what arrives now is waiting again.
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    stream.chunk?.('b')
    expect(bubble.hidden).toBe(false)
    expect(bubble.textContent).toBe('1 new message ↓')
    stream.end?.()
    await flush()
  })
})

describe('what the third review round found', () => {
  it('asks the thread it switched to, without the thread it left below it', async () => {
    /** @type {{ release: (() => void) | null }} */
    const pending = { release: null }
    const threads = {
      threads: [
        { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
        { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
      ],
      activeThread: 'pr-review-a-b-42-claude-t1',
      agent: 'claude',
    }
    let held = false
    const { root } = mount({
      fetchThreads: async () => threads,
      fetchThreadHistory: async (_pr, name) => {
        if (!held) {
          held = true
          return { name, turns: [{ role: 'user', text: 'a question in the first thread', at: '' }] }
        }
        return new Promise(resolve => {
          pending.release = () =>
            resolve({ name, turns: [{ role: 'user', text: 'a question in the second', at: '' }] })
        })
      },
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'the answer' } })
      },
    })
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('a question in the first thread')
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    // The second thread's turns have not arrived, so the first thread's are already gone.
    expect(el(root, '#chat-log').textContent).not.toContain('a question in the first thread')
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'a new question'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    pending.release?.()
    await flush()
    const text = el(root, '#chat-log').textContent ?? ''
    expect(text).toContain('a new question')
    expect(text).not.toContain('a question in the first thread')
    expect(text).not.toContain('a question in the second')
  })

  it('leaves a question alone when the thread list it started with arrives late', async () => {
    /** @type {{ release: (() => void) | null }} */
    const list = { release: null }
    const { root } = mount({
      fetchThreads: () =>
        new Promise(resolve => {
          list.release = () =>
            resolve({
              threads: [
                {
                  name: 'pr-review-a-b-42-claude-t1',
                  agent: 'claude',
                  title: 'first',
                  createdAt: '',
                  turns: 1,
                },
              ],
              activeThread: 'pr-review-a-b-42-claude-t1',
              agent: 'claude',
            })
        }),
      fetchThreadHistory: async (_pr, name) => ({
        name,
        turns: [{ role: 'user', text: 'an old one', at: '' }],
      }),
      streamChat: async (_pr, _input, opts) => {
        opts.onEvent({ event: 'chunk', data: { text: 'the answer' } })
      },
    })
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'a new question'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    list.release?.()
    await flush()
    const text = el(root, '#chat-log').textContent ?? ''
    expect(text).toContain('a new question')
    expect(text).not.toContain('an old one')
  })
})

describe('what the fourth review round found', () => {
  it('keeps where a thread was left when the switch back to it has to wait for its turns', async () => {
    /** @type {{ release: (() => void) | null }} */
    const pending = { release: null }
    let held = 0
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '', turns: 1 },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '', turns: 1 },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => {
        held += 1
        if (held < 3) {
          return { name, turns: [{ role: 'user', text: 'x', at: '' }] }
        }
        return new Promise(resolve => {
          pending.release = () => resolve({ name, turns: [{ role: 'user', text: 'x', at: '' }] })
        })
      },
    })
    await flush()
    const log = el(root, '#chat-log')
    Object.defineProperty(log, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(log, 'clientHeight', { value: 100, configurable: true })
    // Leave the second thread at a place worth coming back to.
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    await flush()
    log.scrollTop = 400
    log.dispatchEvent(new Event('scroll'))
    pickThread(root, 'pr-review-a-b-42-claude-t1')
    await flush()
    // Back to the second thread, whose turns take a while: emptying the log scrolls it to the top.
    pickThread(root, 'pr-review-a-b-42-claude-t2')
    log.scrollTop = 0
    log.dispatchEvent(new Event('scroll'))
    pending.release?.()
    await flush()
    expect(log.scrollTop).toBe(400)
  })
})

it('animates preparation, tracks elapsed time, and collapses updated tool calls', async () => {
  let finish = () => {}
  const { root, chat } = mount({
    streamChat: async (_pr, _input, opts) => {
      opts.onEvent({ event: 'tool', data: { id: '1', title: 'Read src/app.ts', status: 'pending' } })
      opts.onEvent({ event: 'tool', data: { id: '1', title: 'tool', status: 'completed' } })
      await new Promise(resolve => {
        finish = () => resolve(undefined)
      })
      opts.onEvent({ event: 'chunk', data: { text: 'Answer' } })
    },
  })
  await flush()
  vi.useFakeTimers()
  const box = /** @type {HTMLTextAreaElement} */ (el(root, 'textarea'))
  box.value = 'Explain'
  el(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }))
  expect(el(root, '.chat-activity').textContent).toBe('Preparing answer. · 0s')
  await vi.advanceTimersByTimeAsync(800)
  expect(el(root, '.chat-activity').textContent).toBe('Preparing answer... · 0s')
  await vi.advanceTimersByTimeAsync(400)
  expect(el(root, '.chat-activity').textContent).toBe('Preparing answer. · 1s')
  const calls = /** @type {HTMLDetailsElement} */ (el(root, '.chat-tool-calls'))
  expect(el(calls, 'summary').textContent).toContain('Read src/app.ts · completed (1 tool calls)')
  expect(calls.querySelectorAll('li')).toHaveLength(1)
  calls.open = true
  finish()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.open).toBe(false)
  expect(el(calls, 'summary').textContent).toBe('1 tool calls')
  expect(el(root, '.chat-activity').textContent).toBe('Elapsed: 1s')
  chat.stop()
  vi.useRealTimers()
})

it('shows the review checkout while it is prepared, and the answer once the turn starts', async () => {
  let checkedOut = () => {}
  const sha = 'b'.repeat(40)
  const { root, chat } = mount({
    streamChat: async (_pr, _input, opts) => {
      opts.onEvent({ event: 'checkout', data: { status: 'preparing', sha, creating: true } })
      await new Promise(resolve => {
        checkedOut = () => resolve(undefined)
      })
      opts.onEvent({ event: 'turn', data: { thread: 't1', agent: 'claude', seeded: true } })
      opts.onEvent({ event: 'chunk', data: { text: 'Answer' } })
    },
  })
  await flush()
  const box = /** @type {HTMLTextAreaElement} */ (el(root, 'textarea'))
  box.value = 'Explain'
  el(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  const activity = el(root, '.chat-activity')
  expect(activity.textContent).toMatch(/^Creating the review checkout at bbbbbbb\./)
  expect(activity.classList.contains('checking-out')).toBe(true)
  checkedOut()
  await flush()
  expect(activity.classList.contains('checking-out')).toBe(false)
  expect(el(root, '.turn.a .prose').textContent).toContain('Answer')
  chat.stop()
})

it('warns when the review checkout failed and the answer read the reader checkout', async () => {
  const { root, chat } = mount({
    streamChat: async (_pr, _input, opts) => {
      opts.onEvent({ event: 'checkout', data: { status: 'preparing', sha: 'c'.repeat(40), creating: false } })
      opts.onEvent({ event: 'checkout', data: { status: 'fallback', message: 'disk full', branch: 'main' } })
      opts.onEvent({ event: 'chunk', data: { text: 'Answer' } })
    },
  })
  await flush()
  const box = /** @type {HTMLTextAreaElement} */ (el(root, 'textarea'))
  box.value = 'Explain'
  el(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  const warning = el(root, '.turn.a .chat-warning')
  expect(warning.textContent).toContain('AI Chat read your checkout on main')
  expect(warning.textContent).toContain('disk full')
  chat.stop()
})

it('shows a saved fallback warning again when the thread is reopened', async () => {
  const { root, chat } = mount({
    fetchThreads: async () => ({
      threads: [{ name: 't1', agent: 'claude', title: 'x', createdAt: '', turns: 1 }],
      activeThread: 't1',
      agent: 'claude',
    }),
    fetchThreadHistory: async () => ({
      name: 't1',
      turns: [
        { role: 'user', text: 'Is this safe?', at: '' },
        { role: 'assistant', text: 'Yes.', at: '', fallback: { message: 'disk full', branch: 'main' } },
      ],
    }),
  })
  await flush()
  await flush()
  expect(el(root, '.turn.a .chat-warning').textContent).toContain('AI Chat read your checkout on main')
  chat.stop()
})

describe('checkoutWarningHtml', () => {
  it('names no branch when the reader checkout is on a detached HEAD', () => {
    expect(checkoutWarningHtml({ message: 'x', branch: null })).toContain('AI Chat read your checkout.')
  })
})

describe('checkoutActivityText', () => {
  it('says whether the checkout is created or moved', () => {
    expect(checkoutActivityText({ sha: 'd'.repeat(40), creating: false })).toBe('Checking out ddddddd')
  })
})

it('upgrades a submitted proposal to its link when a normalized receipt arrives', () => {
  const draft = {
    id: 'draft',
    path: 'src/app.ts',
    line: 3,
    side: /** @type {const} */ ('new'),
    body: 'Rename this.',
    headSha: artifact.pr.headSha,
    mergeBaseSha: artifact.pr.mergeBaseSha,
    createdAt: '',
    updatedAt: '',
  }
  const text = '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```'
  document.body.innerHTML = answerHtml(text, targets, new Map(), paths, {
    turnKey: 'history-0',
    submitted: [draft],
  })
  expect(document.querySelector('.proposed .tbtns .pill')?.textContent).toBe('submitted')
  const posted = { ...mapReviewComment(GH_REVIEW_COMMENTS[0], new Set()), body: 'Rename this.\r\n', line: 3 }
  document.body.innerHTML = answerHtml(text, targets, new Map(), paths, {
    turnKey: 'history-0',
    posted: [posted],
    submitted: [draft],
  })
  expect(document.querySelector('.proposed .tbtns a')?.getAttribute('href')).toBe(posted.url)
})

it('renders sparse tool updates and an agent error without a message', async () => {
  const { root, chat } = mount({
    streamChat: async (_pr, _input, opts) => {
      opts.onEvent({ event: 'tool', data: {} })
      opts.onEvent({ event: 'tool', data: { title: 'Read code' } })
      opts.onEvent({ event: 'tool', data: { status: 'completed' } })
      opts.onEvent({ event: 'error', data: {} })
    },
  })
  await flush()
  const box = /** @type {HTMLTextAreaElement} */ (el(root, 'textarea'))
  box.value = 'Explain'
  el(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
  expect(el(root, '.chat-tool-calls li').textContent).toBe('Read code · completed')
  expect(root.textContent).toContain('the agent failed')
  chat.stop()
})
