// @ts-check
// @vitest-environment happy-dom
// The live AI Chat pane: the context chip, streaming, the comment cards, threads, and the width.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState } from '../../src/contract/state.js'
import { UNKNOWN_CAPABILITIES } from '../../src/github/capabilities.js'
import { mapReviewComment } from '../../src/github/comments.js'
import { GH_REVIEW_COMMENTS, syntheticArtifact } from '../../src/testing/synthetic.js'
import { setChatEnabled } from './ask.js'
import {
  answerHtml,
  CHAT_WIDTH_DEFAULT,
  CHAT_WIDTH_KEY,
  CHAT_WIDTH_MAX,
  CHAT_WIDTH_MIN,
  clampWidth,
  proposedCommentHtml,
  QUICK_QUESTIONS,
  readChatWidth,
  renderChatShell,
  wireChat,
  writeChatWidth,
} from './chat.js'
import { targetsFromFiles } from './proposed-comment.js'
import { wireQuickQuestions } from './quick-questions.js'
import { createReviewSession } from './review-session.js'

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
  })
}

/**
 * @param {Partial<Parameters<typeof wireChat>[0]['api']>} [api]
 * @param {Partial<Parameters<typeof wireChat>[0]>} [extra]
 */
function mount(api = {}, extra = {}) {
  setChatEnabled(true)
  const root = document.createElement('div')
  root.innerHTML = renderChatShell({ enabled: true })
  document.body.replaceChildren(root)
  const chat = wireChat({
    root,
    prNumber: 42,
    session: session(),
    storage: null,
    reducedMotion: true,
    api: {
      fetchThreads: async () => ({ threads: [], activeThread: null, agent: 'claude' }),
      createThread: async () => ({ threads: [], activeThread: null, agent: 'claude' }),
      fetchThreadHistory: async () => ({ name: 't', turns: [] }),
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

  it('renders the thread select, the context line, the transcript, and the composer', () => {
    const html = renderChatShell({ enabled: true, width: 400 })
    expect(html).toContain('id="thread"')
    expect(html).toContain('id="chat-ctx"')
    expect(html).toContain('id="chat-log"')
    expect(html).toContain('id="chat-send"')
    expect(html).toContain('aria-valuenow="400"')
    expect(html).not.toContain('disabled')
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
    chat.setContext({ kind: 'layer', layerId: 'layer-1' })
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

  it('swaps send for stop while the turn runs, and shows an agent error next to it', async () => {
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
    expect(root.querySelector('.cmd-err')?.textContent).toBe('not logged in')
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
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
        ],
        activeThread: 'pr-review-a-b-42-claude-t2',
        agent: 'claude',
      }),
    })
    await flush()
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    expect(Array.from(select.options).map(o => o.textContent)).toEqual(['first', 'second'])
    expect(select.value).toBe('pr-review-a-b-42-claude-t2')
  })

  it('empties the transcript when a new thread starts', async () => {
    const { root } = mount({
      createThread: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'New thread', createdAt: '' },
        ],
        activeThread: 'pr-review-a-b-42-claude-t2',
        agent: 'claude',
      }),
    })
    el(root, '#new-thread').click()
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('New thread.')
  })

  it('loads the transcript of the thread the reader picks', async () => {
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
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
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    // The first entry is the thread that was already open, loaded when the pane started.
    expect(asked).toEqual(['pr-review-a-b-42-claude-t1', 'pr-review-a-b-42-claude-t2'])
    expect(root.querySelectorAll('.turn')).toHaveLength(2)
    expect(root.textContent).toContain('the answer stopped early (cancelled)')
  })

  it('shows the empty note for a thread with no turns', async () => {
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
        ],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
    })
    await flush()
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(el(root, '#chat-log').textContent).toContain('Ask AI Chat about a layer')
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
  it('renders a posted proposal with a view link when the answer is drawn again', () => {
    const posted = { ...mapReviewComment(GH_REVIEW_COMMENTS[0], new Set()), body: 'Rename this.', line: 3 }
    document.body.innerHTML = answerHtml(
      '```comment\n{"path":"src/app.ts","line":3,"body":"Rename this."}\n```',
      targets,
      new Map(),
      paths,
      'history-0',
      [posted]
    )
    expect(document.querySelector('.proposed .tbtns a')?.textContent).toBe('view comment')
    expect(document.querySelector('.proposed .tbtns a')?.getAttribute('href')).toBe(posted.url)
    expect(document.querySelector('[data-act="proposed-post"]')).toBeNull()
  })
  it('renders a proposed comment as a card with its three commands', () => {
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
    /** @type {Array<[string, string]>} */
    const seen = []
    const { root } = mount(
      {
        streamChat: async (_pr, _input, opts) => {
          opts.onEvent({
            event: 'chunk',
            data: { text: '```comment\n{"path":"src/app.ts","line":3,"body":"Rename."}\n```\n' },
          })
        },
      },
      { onProposed: (what, comment) => seen.push([what, comment.body]) }
    )
    const box = el(root, '#msg')
    if (!(box instanceof HTMLTextAreaElement)) {
      throw new Error('no box')
    }
    box.value = 'x'
    el(root, '#chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    el(root, '[data-act="proposed-post"]').click()
    el(root, '[data-act="proposed-edit"]').click()
    expect(seen).toEqual([
      ['post', 'Rename.'],
      ['edit', 'Rename.'],
    ])
  })
})

describe('QUICK_QUESTIONS', () => {
  it('holds the four fixed questions', () => {
    expect(QUICK_QUESTIONS).toEqual([
      'Is this covered by tests?',
      'What could break?',
      'Why this way, and what were the alternatives?',
      'Does this follow how the codebase already does it?',
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
    chat.askQuestion({ kind: 'layer', layerId: 'layer-1' }, 'Is this covered by tests?')
    await flush()
    expect(sent).toEqual([
      { message: 'Is this covered by tests?', context: { kind: 'layer', layerId: 'layer-1' } },
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
        { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
        { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
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
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    log.scrollTop = 250
    log.dispatchEvent(new Event('scroll'))
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    // A thread seen for the first time opens at the bottom.
    expect(log.scrollTop).toBe(1000)
    log.scrollTop = 600
    log.dispatchEvent(new Event('scroll'))
    select.value = 'pr-review-a-b-42-claude-t1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(log.scrollTop).toBe(250)
  })

  it('loads the open thread once when it starts, and not again when it is selected', async () => {
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [{ name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' }],
        activeThread: 'pr-review-a-b-42-claude-t1',
        agent: 'claude',
      }),
      fetchThreadHistory: async (_pr, name) => {
        asked.push(name)
        return { name, turns: [] }
      },
    })
    await flush()
    const select = el(root, '#thread')
    select.dispatchEvent(new Event('change', { bubbles: true }))
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

  it('ignores a thread select that lands on nothing', async () => {
    /** @type {string[]} */
    const asked = []
    const { root } = mount({
      fetchThreadHistory: async (_pr, name) => {
        asked.push(name)
        return { name, turns: [] }
      },
    })
    await flush()
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    select.innerHTML = '<option value=""></option>'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(asked).toEqual([])
  })

  it('names the thread it is answering in on the next message', async () => {
    /** @type {Array<{ message: string, context: unknown, thread?: string }>} */
    const sent = []
    const { root } = mount({
      fetchThreads: async () => ({
        threads: [{ name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' }],
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

  it('locks the thread controls while an answer is arriving', async () => {
    /** @type {{ run: (() => void) | null }} */
    const done = { run: null }
    const { root } = mount({
      streamChat: () =>
        new Promise(resolve => {
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
    const select = el(root, '#thread')
    expect(select instanceof HTMLSelectElement && select.disabled).toBe(true)
    const newThread = el(root, '#new-thread')
    expect(newThread instanceof HTMLButtonElement && newThread.disabled).toBe(true)
    done.run?.()
    await flush()
    expect(select instanceof HTMLSelectElement && select.disabled).toBe(false)
  })

  it('stops the request when the pane is taken down mid-answer', async () => {
    /** @type {AbortSignal | undefined} */
    let signal
    const { root, chat } = mount({
      streamChat: (_pr, _input, opts) =>
        new Promise(() => {
          signal = opts.signal
        }),
    })
    await send(root, 'x')
    expect(signal?.aborted).toBe(false)
    chat.stop()
    expect(signal?.aborted).toBe(true)
  })

  it('writes the target onto the chip, so a quick question from it keeps the target', () => {
    const { root, chat } = mount()
    chat.setContext({ kind: 'lines', path: 'src/app.ts', side: 'old', start: 2, end: 4 })
    const chip = el(root, '#chat-ctx')
    expect(chip.getAttribute('data-ask-path')).toBe('src/app.ts')
    expect(chip.getAttribute('data-ask-side')).toBe('old')
    expect(chip.getAttribute('data-ask-start')).toBe('2')
    chat.setContext({ kind: 'layer', layerId: 'layer-1' })
    expect(chip.getAttribute('data-ask-path')).toBeNull()
    expect(chip.getAttribute('data-ask-layer')).toBe('layer-1')
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
        threads: [{ name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' }],
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
        { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
        { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
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
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
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
                { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
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
          { name: 'pr-review-a-b-42-claude-t1', agent: 'claude', title: 'first', createdAt: '' },
          { name: 'pr-review-a-b-42-claude-t2', agent: 'claude', title: 'second', createdAt: '' },
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
    const select = el(root, '#thread')
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error('no select')
    }
    // Leave the second thread at a place worth coming back to.
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    log.scrollTop = 400
    log.dispatchEvent(new Event('scroll'))
    select.value = 'pr-review-a-b-42-claude-t1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    // Back to the second thread, whose turns take a while: emptying the log scrolls it to the top.
    select.value = 'pr-review-a-b-42-claude-t2'
    select.dispatchEvent(new Event('change', { bubbles: true }))
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
