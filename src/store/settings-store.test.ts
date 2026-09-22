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
    const saved = await store.write({ agent: 'codex', model: 'gpt-5.2', chatTimeoutSec: 900, maxTurns: 6 })
    expect(saved).toEqual({
      version: 1,
      skin: 'terminal',
      theme: 'auto',
      foldLevel: 'light',
      agent: 'codex',
      model: 'gpt-5.2',
      chatTimeoutSec: 900,
      maxTurns: 6,
    })
    const text = await readFile(store.file, 'utf8')
    expect(text).toContain('# Which agent answers in the AI Chat pane')
    expect(text).toContain('agent: codex')
    expect(text).toContain('chatTimeoutSec: 900')
    expect(await store.read()).toEqual(saved)
  })

  it('changes only the fields the request names', async () => {
    const store = createSettingsStore(dataDir)
    await store.write({ agent: 'codex' })
    expect(await store.write({ chatTimeoutSec: 120 })).toEqual({
      version: 1,
      skin: 'terminal',
      theme: 'auto',
      foldLevel: 'light',
      agent: 'codex',
      model: null,
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
    await writeFile(store.file, 'agent: [unclosed\n', 'utf8')
    expect(await store.read()).toEqual(DEFAULT_SETTINGS)
    const saved = await store.write({ agent: 'codex' })
    expect(saved.agent).toBe('codex')
    expect(await readFile(store.file, 'utf8')).toContain('# Personal pr-review settings')
  })
})

describe('parseSettings', () => {
  it('fills the fields a partial file leaves out', () => {
    expect(parseSettings('agent: codex\n')).toEqual({ ...DEFAULT_SETTINGS, agent: 'codex' })
  })

  it('falls back to the defaults for values that do not fit', () => {
    expect(parseSettings('agent: gemini\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('chatTimeoutSec: 5\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('foldLevel: everything\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('- a\n- b\n')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettings('just a string')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('applySettings', () => {
  it('leaves an empty model as null rather than an empty string', () => {
    expect(applySettings(SETTINGS_TEMPLATE, { model: '' }).settings.model).toBeNull()
  })

  it('starts from the template when the old text cannot be parsed', () => {
    const { text, settings } = applySettings('a: [1,\n', { agent: 'codex' })
    expect(settings.agent).toBe('codex')
    expect(text).toContain('# Personal pr-review settings')
  })

  it('writes every field the schema names, so a hand-edited file gains what it lacks', () => {
    const { text } = applySettings('agent: claude\n', {})
    expect(text).toContain('version: 1')
    expect(text).toContain('model: null')
    expect(text).toContain('maxTurns: null')
  })
})

describe('two saves that arrive together', () => {
  it('both land, instead of one overwriting the other', async () => {
    const store = createSettingsStore(dataDir)
    await store.ensureFile()
    const [agent, timeout] = await Promise.all([
      store.write({ agent: 'codex' }),
      store.write({ chatTimeoutSec: 900 }),
    ])
    expect(agent.agent).toBe('codex')
    expect(timeout.chatTimeoutSec).toBe(900)
    expect(await store.read()).toEqual({
      version: 1,
      skin: 'terminal',
      theme: 'auto',
      foldLevel: 'light',
      agent: 'codex',
      model: null,
      chatTimeoutSec: 900,
      maxTurns: null,
    })
  })

  it('keeps a save that the first run of the page writes its template beside', async () => {
    const store = createSettingsStore(dataDir)
    // The first settings GET writes the template while a save is in flight: the file is one
    // reader's, so the template waits for the save rather than landing on top of it.
    const [saved, written] = await Promise.all([store.write({ agent: 'codex' }), store.ensureFile()])
    expect(saved.agent).toBe('codex')
    expect(written).toBe(false)
    expect((await store.read()).agent).toBe('codex')
  })

  it('writes a good file over one that is a YAML list', async () => {
    const store = createSettingsStore(dataDir)
    await writeFile(store.file, '- a\n- b\n', 'utf8')
    expect((await store.write({ agent: 'codex' })).agent).toBe('codex')
    expect(await readFile(store.file, 'utf8')).toContain('# Personal pr-review settings')
  })
})
