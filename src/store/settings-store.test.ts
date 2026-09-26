// @vitest-environment node
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../contract/settings.js'
import { makeTempDir } from '../testing/fakes.js'
import { applySettings, createSettingsStore, parseSettings, SETTINGS_TEMPLATE } from './settings-store.js'

let dataDir: string

beforeEach(async () => {
  dataDir = await makeTempDir('pr-review-settings-')
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('createSettingsStore', () => {
  it('answers with the defaults before the file exists', async () => {
    const store = createSettingsStore(dataDir)
    expect(await store.read()).toEqual(DEFAULT_SETTINGS)
    expect(store.file).toBe(path.join(dataDir, 'settings.yml'))
  })

  it('writes the commented template on the first run, and only then', async () => {
    const store = createSettingsStore(dataDir)
    expect(await store.ensureFile()).toBe(true)
    expect(await readFile(store.file, 'utf8')).toBe(SETTINGS_TEMPLATE)
    expect(await store.ensureFile()).toBe(false)
    expect(await store.read()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the comments of the file it writes back into', async () => {
    const store = createSettingsStore(dataDir)
    await store.ensureFile()
    const saved = await store.write({
      chatAgent: 'codex',
      chatModel: 'gpt-5.2',
      chatTimeoutSec: 900,
      maxTurns: 6,
    })
    expect(saved).toEqual({
      version: 1,
      skin: 'github',
      theme: 'auto',
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'codex',
      chatModel: 'gpt-5.2',
      chatTimeoutSec: 900,
      maxTurns: 6,
    })
    const text = await readFile(store.file, 'utf8')
    expect(text).toContain('# Which agent answers in the AI Chat pane')
    expect(text).toContain('chatAgent: codex')
    expect(text).toContain('chatTimeoutSec: 900')
    expect(await store.read()).toEqual(saved)
  })

  it('changes only the fields the request names', async () => {
    const store = createSettingsStore(dataDir)
    await store.write({ chatAgent: 'codex' })
    expect(await store.write({ chatTimeoutSec: 120 })).toEqual({
      version: 1,
      skin: 'github',
      theme: 'auto',
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'codex',
      chatModel: null,
      chatTimeoutSec: 120,
      maxTurns: null,
    })
  })

  it('saves the reading level a review opens at, next to its comment', async () => {
    const store = createSettingsStore(dataDir)
    await store.ensureFile()
    expect(SETTINGS_TEMPLATE).toContain('foldLevel: light')
    expect((await store.write({ foldLevel: 'moderate' })).foldLevel).toBe('moderate')
    const text = await readFile(store.file, 'utf8')
    expect(text).toContain('# How much code a review hides when it opens')
    expect(text).toContain('foldLevel: moderate')
    expect((await store.read()).foldLevel).toBe('moderate')
  })

  it('writes a good file over one that is not YAML', async () => {
    const store = createSettingsStore(dataDir)
    await writeFile(store.file, 'chatAgent: [unclosed\n', 'utf8')
    expect(await store.read()).toEqual(DEFAULT_SETTINGS)
    const saved = await store.write({ chatAgent: 'codex' })
    expect(saved.chatAgent).toBe('codex')
    expect(await readFile(store.file, 'utf8')).toContain('# Personal pr-review settings')
  })
})

describe('parseSettings', () => {
  it('fills the fields a partial file leaves out', () => {
    expect(parseSettings('chatAgent: codex\n')).toEqual({ ...DEFAULT_SETTINGS, chatAgent: 'codex' })
  })

  it('falls back to the defaults for values that do not fit', () => {
    expect(parseSettings('chatAgent: gemini\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('chatTimeoutSec: 5\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('foldLevel: everything\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('- a\n- b\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('just a string')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('the chat keys of an older file', () => {
  const LEGACY = `# Which agent answers in the AI Chat pane: claude or codex.
agent: codex

# Model id for that agent, or null for the agent's own default.
model: gpt-5.2
chatTimeoutSec: 300
`

  it('reads agent and model as the chat agent and chat model', () => {
    expect(parseSettings(LEGACY)).toEqual({
      ...DEFAULT_SETTINGS,
      chatAgent: 'codex',
      chatModel: 'gpt-5.2',
      chatTimeoutSec: 300,
    })
  })

  it('renames them in place on a save, and a second save keeps the new names', async () => {
    const store = createSettingsStore(dataDir)
    await writeFile(store.file, LEGACY, 'utf8')
    await store.write({ foldLevel: 'moderate' })
    const first = await readFile(store.file, 'utf8')
    expect(first).not.toMatch(/^(agent|model):/m)
    expect(first).not.toContain('# Model id for that agent')
    expect(first).toContain('Canvas generation does not read')
    // The renamed keys stay where they were, ahead of the key that followed them.
    expect(first.indexOf('chatModel: gpt-5.2')).toBeLessThan(first.indexOf('chatTimeoutSec: 300'))
    expect(await store.write({ chatModel: 'gpt-6-sol' })).toEqual({
      ...DEFAULT_SETTINGS,
      foldLevel: 'moderate',
      chatAgent: 'codex',
      chatModel: 'gpt-6-sol',
      chatTimeoutSec: 300,
    })
    const second = await readFile(store.file, 'utf8')
    expect(second.match(/^chatModel:/gm)).toHaveLength(1)
    expect(second).toContain('chatModel: gpt-6-sol')
    expect(second).not.toMatch(/^(agent|model):/m)
  })

  it('keeps the new spelling when a file has both, and drops the old one', () => {
    expect(parseSettings('agent: codex\nchatAgent: claude\n').chatAgent).toBe('claude')
    const { text } = applySettings('agent: codex\nchatAgent: claude\n', {})
    expect(text).not.toMatch(/^agent:/m)
    expect(text).toContain('chatAgent: claude')
  })
})

describe('applySettings', () => {
  it('leaves an empty model as null rather than an empty string', () => {
    expect(applySettings(SETTINGS_TEMPLATE, { chatModel: '' }).settings.chatModel).toBeNull()
  })

  it('starts from the template when the old text cannot be parsed', () => {
    const { text, settings } = applySettings('a: [1,\n', { chatAgent: 'codex' })
    expect(settings.chatAgent).toBe('codex')
    expect(text).toContain('# Personal pr-review settings')
  })

  it('writes every field the schema names, so a hand-edited file gains what it lacks', () => {
    const { text } = applySettings('chatAgent: claude\n', {})
    expect(text).toContain('version: 1')
    expect(text).toContain('layerView: all')
    expect(text).toContain('chatModel: null')
    expect(text).toContain('maxTurns: null')
  })

  it('saves the layer view under its comment, and refuses one it does not know', () => {
    const { text, settings } = applySettings(SETTINGS_TEMPLATE, { layerView: 'one' })
    expect(settings.layerView).toBe('one')
    expect(text).toContain('# How a review shows its layers')
    expect(text).toContain('layerView: one')
    expect(parseSettings('layerView: some\n')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('two saves that arrive together', () => {
  it('both land, instead of one overwriting the other', async () => {
    const store = createSettingsStore(dataDir)
    await store.ensureFile()
    const [agent, timeout] = await Promise.all([
      store.write({ chatAgent: 'codex' }),
      store.write({ chatTimeoutSec: 900 }),
    ])
    expect(agent.chatAgent).toBe('codex')
    expect(timeout.chatTimeoutSec).toBe(900)
    expect(await store.read()).toEqual({
      version: 1,
      skin: 'github',
      theme: 'auto',
      foldLevel: 'light',
      layerView: 'all',
      chatAgent: 'codex',
      chatModel: null,
      chatTimeoutSec: 900,
      maxTurns: null,
    })
  })

  it('keeps a save that the first run of the page writes its template beside', async () => {
    const store = createSettingsStore(dataDir)
    // The first settings GET writes the template while a save is in flight: the file is one
    // reader's, so the template waits for the save rather than landing on top of it.
    const [saved, written] = await Promise.all([store.write({ chatAgent: 'codex' }), store.ensureFile()])
    expect(saved.chatAgent).toBe('codex')
    expect(written).toBe(false)
    expect((await store.read()).chatAgent).toBe('codex')
  })

  it('writes a good file over one that is a YAML list', async () => {
    const store = createSettingsStore(dataDir)
    await writeFile(store.file, '- a\n- b\n', 'utf8')
    expect((await store.write({ chatAgent: 'codex' })).chatAgent).toBe('codex')
    expect(await readFile(store.file, 'utf8')).toContain('# Personal pr-review settings')
  })
})
