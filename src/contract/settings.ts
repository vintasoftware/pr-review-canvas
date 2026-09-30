import { z } from 'zod'
import type { GenerationModels, Sharing } from '../project-config.js'
import type { ReviewKey } from './review-key.js'
import { DEFAULT_FOLD_LEVEL, FOLD_LEVELS } from '../../static/js/fold-levels.js'
import { DEFAULT_LAYER_VIEW, LAYER_VIEWS } from '../../static/js/layer-views.js'
import { DEFAULT_SKIN, isSkin, SKINS, type Skin } from '../../static/js/skin.js'
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from '../../static/js/theme.js'

export type { Skin } from '../../static/js/skin.js'
// The skin and theme names live with the browser modules that apply them, because the page needs
// them before any server type could reach it.
export { DEFAULT_SKIN, SKINS } from '../../static/js/skin.js'
export type { Theme } from '../../static/js/theme.js'
export { DEFAULT_THEME, THEMES } from '../../static/js/theme.js'
export type { LayerView } from '../../static/js/layer-views.js'
export { DEFAULT_LAYER_VIEW, LAYER_VIEWS } from '../../static/js/layer-views.js'

/** The agents the chat knows how to reach through acpx. */
export const CHAT_AGENTS = ['claude', 'codex'] as const
export type ChatAgent = (typeof CHAT_AGENTS)[number]

export function isChatAgent(value: string): value is ChatAgent {
  return (CHAT_AGENTS as readonly string[]).includes(value)
}

export const CHAT_TIMEOUT_MIN_SEC = 30
export const CHAT_TIMEOUT_MAX_SEC = 3600

/** `checkoutIdleDays` that turns the idle cleanup of review checkouts off. */
export const CHECKOUT_IDLE_NEVER = -1
export const CHECKOUT_IDLE_MAX_DAYS = 365
export const CHECKOUT_SWEEP_MIN_MINUTES = 5
export const CHECKOUT_SWEEP_MAX_MINUTES = 1440

const CheckoutIdleDaysSchema = z
  .number()
  .int()
  .min(CHECKOUT_IDLE_NEVER)
  .max(CHECKOUT_IDLE_MAX_DAYS)
  .refine(days => days !== 0, { message: 'checkoutIdleDays is -1 or at least 1' })
const CheckoutSweepMinutesSchema = z
  .number()
  .int()
  .min(CHECKOUT_SWEEP_MIN_MINUTES)
  .max(CHECKOUT_SWEEP_MAX_MINUTES)

export const SettingsSchema = z.object({
  version: z.literal(1),
  skin: z.enum(SKINS),
  theme: z.enum(THEMES),
  /** The reading level every review opens at; the control on the page changes it for one page. */
  foldLevel: z.enum(FOLD_LEVELS),
  /** Whether a review shows every layer on one page, or the overview or one layer at a time. */
  layerView: z.enum(LAYER_VIEWS),
  /** The agent that answers in AI Chat. Canvas generation does not read it. */
  chatAgent: z.enum(CHAT_AGENTS),
  /** The model AI Chat runs, or null for the agent's default. Canvas generation does not read it. */
  chatModel: z.string().min(1).nullable(),
  chatTimeoutSec: z.number().int().min(CHAT_TIMEOUT_MIN_SEC).max(CHAT_TIMEOUT_MAX_SEC),
  maxTurns: z.number().int().positive().max(100).nullable(),
  /** Whether AI Chat reads a review checkout at the reviewed commit, or the reader's own checkout. */
  checkoutEnabled: z.boolean(),
  /** Days without a chat turn before a review checkout is removed; -1 never removes one for that. */
  checkoutIdleDays: CheckoutIdleDaysSchema,
  /** How often `serve` looks for idle review checkouts. */
  checkoutSweepMinutes: CheckoutSweepMinutesSchema,
  /** Overrides `sharing.canvasComment` in pr-review.config.yml; null follows the project. */
  canvasComment: z.boolean().nullable(),
  /** Overrides `sharing.mentionCanvas` in pr-review.config.yml; null follows the project. */
  mentionCanvas: z.boolean().nullable(),
  /** Overrides `tour.share` in pr-review.config.yml; null follows the project. */
  tourComment: z.boolean().nullable().default(null),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  skin: DEFAULT_SKIN,
  theme: DEFAULT_THEME,
  foldLevel: DEFAULT_FOLD_LEVEL,
  layerView: DEFAULT_LAYER_VIEW,
  chatAgent: 'claude',
  chatModel: null,
  chatTimeoutSec: 600,
  maxTurns: null,
  checkoutEnabled: true,
  checkoutIdleDays: 7,
  checkoutSweepMinutes: 60,
  canvasComment: null,
  mentionCanvas: null,
  tourComment: null,
}

/** The project's sharing rules with this user's overrides applied: a set personal key wins. */
export function resolveSharing(project: Sharing, settings: Settings): Sharing {
  return {
    canvasComment: settings.canvasComment ?? project.canvasComment,
    mentionCanvas: settings.mentionCanvas ?? project.mentionCanvas,
  }
}

/**
 * Whether a tour is shared on its pull request: the personal `tourComment` wins, then the project's
 * `tour.share`, whose `auto` follows canvas sharing.
 */
export function resolveTourSharing(
  project: { sharing: Sharing; tourShare: 'on' | 'off' | 'auto' },
  settings: Settings
): boolean {
  if (settings.tourComment !== null) return settings.tourComment
  if (project.tourShare !== 'auto') return project.tourShare === 'on'
  return resolveSharing(project.sharing, settings).canvasComment
}

/**
 * What `PUT /api/settings` accepts: every field optional, the rest stays as it was. Unknown keys
 * are refused, so a body with the old `agent` or `model` fails instead of saving nothing.
 */
export const SettingsInputSchema = z.strictObject({
  skin: z.enum(SKINS).optional(),
  theme: z.enum(THEMES).optional(),
  foldLevel: z.enum(FOLD_LEVELS).optional(),
  layerView: z.enum(LAYER_VIEWS).optional(),
  chatAgent: z.enum(CHAT_AGENTS).optional(),
  chatModel: z.string().max(200).nullable().optional(),
  chatTimeoutSec: z.number().int().min(CHAT_TIMEOUT_MIN_SEC).max(CHAT_TIMEOUT_MAX_SEC).optional(),
  maxTurns: z.number().int().positive().max(100).nullable().optional(),
  checkoutEnabled: z.boolean().optional(),
  checkoutIdleDays: CheckoutIdleDaysSchema.optional(),
  checkoutSweepMinutes: CheckoutSweepMinutesSchema.optional(),
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

/** A `serve --chat-agent/--chat-model` flag wins over the file, and the dialog says so. */
export interface SettingsOverrides {
  chatAgent?: ChatAgent
  chatModel?: string
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
    /** `generation.models`: the model each agent generates canvases with. AI Chat does not read it. */
    generationModels: GenerationModels
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

/** `GET /api/checkouts`: the review checkouts of this repository, newest use first. */
export interface CheckoutsResponse {
  /** The folder they live in. */
  root: string
  checkouts: Array<{
    key: ReviewKey
    sha: string
    lastUsedAt: string
    /** True while a chat turn holds it. */
    locked: boolean
    /** Bytes on disk, `.git` excluded. */
    bytes: number
  }>
}
