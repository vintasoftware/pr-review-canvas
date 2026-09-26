import path from 'node:path'
import { type Document, isMap, isScalar, parseDocument } from 'yaml'
import { DEFAULT_SETTINGS, type Settings, type SettingsInput, SettingsSchema } from '../contract/settings.js'
import { readText, writeTextAtomic } from './atomic-json.js'

export const SETTINGS_FILE = 'settings.yml'

/** Written once, the first time the file is needed, so the user can edit it by hand too. */
export const SETTINGS_TEMPLATE = `# Personal pr-review settings. Gitignored: this file is yours, not the project's.
# Project-wide settings (layers, caps, canvas generation models, chat.enabled) live in
# pr-review.config.yml at the repo root.
version: 1

# The look of the page: terminal or github.
skin: ${DEFAULT_SETTINGS.skin}

# Light or dark: auto follows the operating system, light and dark pin one.
theme: auto

# How much code a review hides when it opens: light, moderate, or aggressive. The Hide code
# control on the page changes it for that page only.
foldLevel: light

# How a review shows its layers: all on one page, or one at a time with the rail to move between
# them.
layerView: all

# Which agent answers in the AI Chat pane: claude or codex. Canvas generation does not read
# this; generation.models in pr-review.config.yml sets the canvas generation models.
chatAgent: claude

# The model AI Chat runs, or null for the chat agent's own default. Canvas generation does not
# read this either.
chatModel: null

# How long one chat turn may take, in seconds.
chatTimeoutSec: 600

# Cap on agent turns per message, or null for the agent's own default.
maxTurns: null
`

export interface SettingsStore {
  /** The file's path, shown in the settings dialog. */
  file: string
  /** The saved settings, or the defaults when the file is missing or unreadable. */
  read(): Promise<Settings>
  /**
   * Writes the changed fields back. Comments and key order in the file survive, because the
   * document is edited rather than re-serialized from a plain object.
   */
  write(input: SettingsInput): Promise<Settings>
  /** Writes the commented template when the file does not exist yet. */
  ensureFile(): Promise<boolean>
}

export function createSettingsStore(dataDir: string): SettingsStore {
  const file = path.join(dataDir, SETTINGS_FILE)

  const read = async (): Promise<Settings> => {
    const text = await readText(file)
    if (text === null) {
      return DEFAULT_SETTINGS
    }
    return parseSettings(text)
  }

  /**
   * Every write runs after the one before it, so two that arrive together both land and the
   * first run's template never lands on top of a save.
   */
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const chained = chain.then(task, task)
    chain = chained.catch(() => undefined)
    return chained
  }

  const write = async (input: SettingsInput): Promise<Settings> => {
    const current = (await readText(file)) ?? SETTINGS_TEMPLATE
    const next = applySettings(current, input)
    await writeTextAtomic(file, next.text)
    return next.settings
  }

  const ensureFile = async (): Promise<boolean> => {
    if ((await readText(file)) !== null) {
      return false
    }
    await writeTextAtomic(file, SETTINGS_TEMPLATE)
    return true
  }

  return {
    file,
    read,
    ensureFile: () => queued(ensureFile),
    write: input => queued(() => write(input)),
  }
}

/**
 * The settings a file holds. A file that is not YAML, or whose values do not fit, falls back to
 * the defaults rather than failing the page: the dialog can then write a good file over it.
 */
export function parseSettings(text: string): Settings {
  let raw: unknown
  try {
    raw = parseDocument(text).toJS() as unknown
  } catch {
    return DEFAULT_SETTINGS
  }
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_SETTINGS
  }
  const merged = { ...DEFAULT_SETTINGS, ...withChatKeys(raw), version: 1 }
  const parsed = SettingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : DEFAULT_SETTINGS
}

/**
 * The chat keys of files written before they were named for the chat: `agent` became `chatAgent`
 * and `model` became `chatModel`. A file that has both spellings keeps the new one.
 */
const LEGACY_KEYS = { agent: 'chatAgent', model: 'chatModel' } as const

function withChatKeys(raw: object): object {
  const out: Record<string, unknown> = { ...raw }
  for (const [legacy, key] of Object.entries(LEGACY_KEYS)) {
    if (legacy in out && !(key in out)) {
      out[key] = out[legacy]
    }
    delete out[legacy]
  }
  return out
}

/**
 * Renames a legacy chat key where it stands, so its position survives, and gives it the template's
 * comment, which says the key is for the chat only. A legacy key next to its new spelling goes.
 */
function renameLegacyKeys(doc: Document): void {
  if (!isMap(doc.contents)) {
    return
  }
  const templateKeys = parseDocument(SETTINGS_TEMPLATE).contents
  for (const [legacy, key] of Object.entries(LEGACY_KEYS)) {
    if (doc.has(key)) {
      doc.delete(legacy)
      continue
    }
    const found = doc.contents.items.find(p => isScalar(p.key) && p.key.value === legacy)?.key
    if (isScalar(found)) {
      found.value = key
      const template = isMap(templateKeys)
        ? templateKeys.items.find(p => isScalar(p.key) && p.key.value === key)?.key
        : undefined
      found.commentBefore = isScalar(template) ? (template.commentBefore ?? null) : null
    }
  }
}

/** The new file text and the settings it holds, given the old text and the changed fields. */
export function applySettings(text: string, input: SettingsInput): { text: string; settings: Settings } {
  const wanted = { ...parseSettings(text), ...stripUndefined(input) }
  const parsed = SettingsSchema.safeParse({ ...wanted, version: 1 })
  const settings = parsed.success ? parsed.data : DEFAULT_SETTINGS
  let doc = parseDocument(text)
  // Only a mapping can hold these keys; a file that is a list or a scalar starts over from the
  // template, which is also what a file that does not parse gets.
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    doc = parseDocument(SETTINGS_TEMPLATE)
  }
  renameLegacyKeys(doc)
  doc.set('version', 1)
  doc.set('skin', settings.skin)
  doc.set('theme', settings.theme)
  doc.set('foldLevel', settings.foldLevel)
  doc.set('layerView', settings.layerView)
  doc.set('chatAgent', settings.chatAgent)
  doc.set('chatModel', settings.chatModel)
  doc.set('chatTimeoutSec', settings.chatTimeoutSec)
  doc.set('maxTurns', settings.maxTurns)
  return { text: String(doc), settings }
}

function stripUndefined(input: SettingsInput): Partial<Settings> {
  const out: Partial<Settings> = {}
  if (input.skin !== undefined) {
    out.skin = input.skin
  }
  if (input.theme !== undefined) {
    out.theme = input.theme
  }
  if (input.foldLevel !== undefined) {
    out.foldLevel = input.foldLevel
  }
  if (input.layerView !== undefined) {
    out.layerView = input.layerView
  }
  if (input.chatAgent !== undefined) {
    out.chatAgent = input.chatAgent
  }
  if (input.chatModel !== undefined) {
    out.chatModel = input.chatModel === '' ? null : input.chatModel
  }
  if (input.chatTimeoutSec !== undefined) {
    out.chatTimeoutSec = input.chatTimeoutSec
  }
  if (input.maxTurns !== undefined) {
    out.maxTurns = input.maxTurns
  }
  return out
}
