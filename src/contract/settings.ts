import { z } from 'zod'
import { DEFAULT_FOLD_LEVEL, FOLD_LEVELS } from '../../static/js/fold-levels.js'
import { DEFAULT_SKIN, isSkin, SKINS, type Skin } from '../../static/js/skin.js'
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from '../../static/js/theme.js'

export type { Skin } from '../../static/js/skin.js'
// The skin and theme names live with the browser modules that apply them, because the page needs
// them before any server type could reach it.
export { DEFAULT_SKIN, SKINS } from '../../static/js/skin.js'
export type { Theme } from '../../static/js/theme.js'
export { DEFAULT_THEME, THEMES } from '../../static/js/theme.js'

/** The agents the chat knows how to reach through acpx. */
export const CHAT_AGENTS = ['claude', 'codex'] as const
export type ChatAgent = (typeof CHAT_AGENTS)[number]

export function isChatAgent(value: string): value is ChatAgent {
  return (CHAT_AGENTS as readonly string[]).includes(value)
}

export const CHAT_TIMEOUT_MIN_SEC = 30
export const CHAT_TIMEOUT_MAX_SEC = 3600

export const SettingsSchema = z.object({
  version: z.literal(1),
  skin: z.enum(SKINS),
  theme: z.enum(THEMES),
  /** The reading level every review opens at; the control on the page changes it for one page. */
  foldLevel: z.enum(FOLD_LEVELS),
  agent: z.enum(CHAT_AGENTS),
  model: z.string().min(1).nullable(),
  chatTimeoutSec: z.number().int().min(CHAT_TIMEOUT_MIN_SEC).max(CHAT_TIMEOUT_MAX_SEC),
  maxTurns: z.number().int().positive().max(100).nullable(),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  skin: DEFAULT_SKIN,
  theme: DEFAULT_THEME,
  foldLevel: DEFAULT_FOLD_LEVEL,
  agent: 'claude',
  model: null,
  chatTimeoutSec: 600,
  maxTurns: null,
}

/** What `PUT /api/settings` accepts: every field optional, the rest stays as it was. */
export const SettingsInputSchema = z.object({
  skin: z.enum(SKINS).optional(),
  theme: z.enum(THEMES).optional(),
  foldLevel: z.enum(FOLD_LEVELS).optional(),
  agent: z.enum(CHAT_AGENTS).optional(),
  model: z.string().max(200).nullable().optional(),
  chatTimeoutSec: z.number().int().min(CHAT_TIMEOUT_MIN_SEC).max(CHAT_TIMEOUT_MAX_SEC).optional(),
  maxTurns: z.number().int().positive().max(100).nullable().optional(),
})
export type SettingsInput = z.infer<typeof SettingsInputSchema>

/** How the page is painted: the skin, and light or dark. Both live in the settings file. */
export interface Appearance {
  skin: Skin
  theme: Theme
}

/** The `?skin` and `?theme` of one request, either of which may be absent. */
export interface AppearanceQuery {
  skin?: string | undefined
  theme?: string | undefined
}

/** The appearance for one request: `?skin=` and `?theme=` win over the saved ones, for that load. */
export function appearanceForRequest(saved: Appearance, query: AppearanceQuery): Appearance {
  return {
    skin: isSkin(query.skin) ? query.skin : saved.skin,
    theme: isTheme(query.theme) ? query.theme : saved.theme,
  }
}

/**
 * What `PUT /api/appearance` accepts. It is its own route, apart from the chat settings, because a
 * repository with chat turned off still has a page to paint. A body that names neither is refused
 * rather than saved as a no-op.
 */
export const AppearanceInputSchema = z
  .object({ skin: z.enum(SKINS).optional(), theme: z.enum(THEMES).optional() })
  .refine(input => input.skin !== undefined || input.theme !== undefined, {
    message: 'name a skin, a theme, or both',
  })
export type AppearanceInput = z.infer<typeof AppearanceInputSchema>

/** How the page is painted right now, as the server has it saved. */
export type AppearanceResponse = Appearance

/** A `serve --agent/--model` flag wins over the file, and the dialog says so. */
export interface SettingsOverrides {
  agent?: ChatAgent
  model?: string
}

export interface SettingsResponse {
  settings: Settings
  /** The flags that win over the file for this run. */
  overrides: SettingsOverrides
  /** Absolute path of `.pr-review/settings.yml`, shown in the dialog. */
  file: string
  /** The committed project config, read-only in the UI. */
  project: {
    file: string | null
    chatEnabled: boolean
    rulebook: string | null
    maxRepairRounds: number
    inlineDiffMaxLines: number
    smallPrHunks: number
    /** Whether a canvas still stands for a later head with an identical diff. */
    keepForIdenticalDiff: boolean
    layers: number
    highRisk: number
  }
}

/** Whether an agent can run right now, and why not when it cannot. */
export interface AgentAvailability {
  id: ChatAgent
  /** True when the binary is on PATH and its auth check passed. */
  available: boolean
  installed: boolean
  authenticated: boolean
  reason?: string
}

export interface AgentsResponse {
  /** False when `acpx` itself is missing: the whole pane is unusable then. */
  acpx: { installed: boolean; version: string | null }
  agents: AgentAvailability[]
}

/** The answer of `POST /api/settings/agents/:id/probe`: one real one-shot round trip. */
export interface AgentProbeResult {
  id: ChatAgent
  ok: boolean
  /** How long the round trip took, in milliseconds. */
  ms: number
  /** The agent's reply, cut to one short line; empty when it failed. */
  reply: string
  code?: string
  message?: string
  /** When this result was produced; results are reused for ten minutes. */
  at: string
  cached: boolean
}
