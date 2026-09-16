// @vitest-environment node
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatThread } from '../contract/state.js'
import { makeTempDir } from '../testing/fakes.js'
import {
  createTranscriptStore,
  isThreadNameFor,
  nextThreadIndex,
  slug,
  threadName,
  threadTitle,
} from './threads.js'

const REPO = { owner: 'Acme Corp', name: 'Widgets.js' }

function thread(name: string): ChatThread {
  return {
    name,
    agent: 'claude',
    rev: 0,
    title: 't',
    createdAt: '2026-09-11T10:00:00.000Z',
    seededHeadSha: '',
  }
}

describe('threadName', () => {
  it('names a session after the repository, the pull request, and the agent', () => {
    expect(threadName(REPO, 42, 'claude', 1)).toBe('pr-review-acme-corp-widgets-js-42-claude-t1')
  })

  it('keeps only characters a session name and a file name can both hold', () => {
    expect(slug('../../etc/passwd')).toBe('etc-passwd')
    expect(slug('!!!')).toBe('')
    expect(slug('x'.repeat(60))).toHaveLength(40)
  })
})

describe('isThreadNameFor', () => {
  it('accepts a name this tool made for this pull request', () => {
    expect(isThreadNameFor('pr-review-acme-widgets-42-claude-t3', 42)).toBe(true)
  })

  it('refuses another pull request, another shape, and a path', () => {
    expect(isThreadNameFor('pr-review-acme-widgets-43-claude-t3', 42)).toBe(false)
    expect(isThreadNameFor('../../etc/passwd', 42)).toBe(false)
    expect(isThreadNameFor('pr-review-acme-widgets-42-claude-t3/../x', 42)).toBe(false)
    expect(isThreadNameFor('anything', 42)).toBe(false)
  })
})

describe('nextThreadIndex', () => {
  it('starts at one and then goes past the highest index in use', () => {
    expect(nextThreadIndex([])).toBe(1)
    expect(nextThreadIndex([thread('pr-review-a-b-42-claude-t1'), thread('pr-review-a-b-42-codex-t4')])).toBe(
      5
    )
    expect(nextThreadIndex([thread('not-a-thread-name')])).toBe(1)
  })
})

describe('threadTitle', () => {
  it('takes the title from the first message, on one line', () => {
    expect(threadTitle('  is this\n covered? ')).toBe('is this covered?')
    expect(threadTitle('   ')).toBe('New thread')
    expect(threadTitle('x'.repeat(100))).toBe(`${'x'.repeat(59)}…`)
  })
})

describe('createTranscriptStore', () => {
  let dir: string
  const NAME = 'pr-review-acme-widgets-42-claude-t1'

  beforeEach(async () => {
    dir = await makeTempDir('pr-review-chat-')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const store = () => createTranscriptStore(number => path.join(dir, 'prs', String(number)))

  it('reads back the turns it appended, in order', async () => {
    const s = store()
    await s.append(42, NAME, { role: 'user', text: 'is this covered?', at: '2026-09-11T10:00:00.000Z' })
    await s.append(42, NAME, { role: 'assistant', text: 'Yes.', at: '2026-09-11T10:00:05.000Z' })
    expect(await s.read(42, NAME)).toEqual([
      { role: 'user', text: 'is this covered?', at: '2026-09-11T10:00:00.000Z' },
      { role: 'assistant', text: 'Yes.', at: '2026-09-11T10:00:05.000Z' },
    ])
  })

  it('has no turns for a thread nothing was said in', async () => {
    expect(await store().read(42, NAME)).toEqual([])
  })

  it('skips a line an older version wrote that no longer fits', async () => {
    const s = store()
    await s.append(42, NAME, { role: 'user', text: 'one', at: '2026-09-11T10:00:00.000Z' })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(s.file(42, NAME), 'not json\n{"role":"alien","text":"x","at":"now"}\n', 'utf8')
    expect(await s.read(42, NAME)).toEqual([{ role: 'user', text: 'one', at: '2026-09-11T10:00:00.000Z' }])
  })

  it('writes the raw event log next to the transcript', async () => {
    const s = store()
    await s.appendEvent(42, NAME, '{"a":1}')
    expect(await readFile(s.eventsFile(42, NAME), 'utf8')).toBe('{"a":1}\n')
    expect(s.eventsFile(42, NAME)).toBe(path.join(s.dir(42), `${NAME}.events.ndjson`))
  })

  it('refuses a name that is not a thread of this pull request', async () => {
    const s = store()
    expect(() => s.file(42, '../../escape')).toThrow(/not a chat thread/)
    await expect(s.read(42, 'pr-review-a-b-99-claude-t1')).rejects.toThrow(/not a chat thread/)
  })
})
