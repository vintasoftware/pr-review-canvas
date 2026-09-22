import path from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { DEFAULT_SETTINGS, type Settings, type SettingsInput, SettingsSchema } from '../contract/settings.js'
import { readText, writeTextAtomic } from './atomic-json.js'

export const SETTINGS_FILE = 'settings.yml'

/** Written once, the first time the file is needed, so the user can edit it by hand too. */
export const SETTINGS_TEMPLATE = `# Personal pr-review settings. Gitignored: this file is yours, not the project's.
# Project-wide settings (layers, caps, chat.enabled) live in pr-review.config.yml at the repo root.
version: 1

# The look of the page: terminal or github.
skin: ${DEFAULT_SETTINGS.skin}

# Light or dark: auto follows the operating system, light and dark pin one.
theme: auto

# How much code a review hides when it opens: light, moderate, or aggressive. The Hide code
# control on the page changes it for that page only.
foldLevel: light

# Which agent answers in the AI Chat pane: claude or codex.
agent: claude

# Model id for that agent, or null for the agent's own default.
model: null

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
  const merged = { ...DEFAULT_SETTINGS, ...raw, version: 1 }
  const parsed = SettingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : DEFAULT_SETTINGS
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
  doc.set('version', 1)
  doc.set('skin', settings.skin)
  doc.set('theme', settings.theme)
  doc.set('foldLevel', settings.foldLevel)
  doc.set('agent', settings.agent)
  doc.set('model', settings.model)
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
  if (input.agent !== undefined) {
    out.agent = input.agent
  }
  if (input.model !== undefined) {
    out.model = input.model === '' ? null : input.model
  }
  if (input.chatTimeoutSec !== undefined) {
    out.chatTimeoutSec = input.chatTimeoutSec
  }
  if (input.maxTurns !== undefined) {
    out.maxTurns = input.maxTurns
  }
  return out
}
