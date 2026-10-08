import { z } from 'zod'
import type { ErrorEnvelope } from './api.js'
import type { ReviewKey } from './review-key.js'
import type { CanvasSharing } from './self-review.js'
import { CHAT_AGENTS } from './settings.js'

/**
 * What the generate button sends: `force` starts from a blank page instead of updating the
 * earlier canvas. A head that already has a canvas is written again from one whatever it says.
 * `pr-review generate` can also send the rest, for this job only: `base` compares a local review
 * against another ref, `share: false` keeps the canvas off the pull request whatever the sharing
 * settings say, and `agent` and `model` win over the chat agent and `generation.models`.
 */
export const GenerateInputSchema = z
  .object({
    force: z.boolean(),
    base: z.string().trim().min(1).optional(),
    share: z.boolean().optional(),
    agent: z.enum(CHAT_AGENTS).optional(),
    model: z.string().trim().min(1).optional(),
  })
  .strict()
export type GenerateInput = z.infer<typeof GenerateInputSchema>

/**
 * Where a generation the server runs is. `checkout` puts the review checkout at the head,
 * `generating` waits for the agent's first model, `repairing` for a corrected one after publish
 * rejected the last, and the last three are where a job ends.
 */
export const GENERATION_PHASES = [
  'preparing',
  'checkout',
  'generating',
  'publishing',
  'repairing',
  'done',
  'failed',
  'cancelled',
] as const
export type GenerationPhase = (typeof GENERATION_PHASES)[number]

/**
 * What the agent did last in the turn that runs now, and when. A turn can go minutes with no tool
 * call while the agent thinks or writes the canvas, so the dialog shows this to tell a working
 * agent from a stuck one. `written` is how much of the answer it has written since its last tool
 * call; `starting` is the time before the agent says anything.
 */
export interface AgentPulse {
  doing: 'starting' | 'thinking' | 'writing' | 'tool'
  at: string
  written: number
}

/**
 * How a project copy of the skill compares with the shipped one: `current` when its body and stamp
 * are the shipped ones, `other-version` when its body is still the one another pr-review version stamped, and
 * `edited` otherwise (a changed body, or no stamp).
 */
export type SkillState = 'current' | 'other-version' | 'edited'

/**
 * The pr-review-canvas skill a generation follows: the project's own copy, by its path from the
 * repository root, or the one the server's pr-review ships when the project has none. A project
 * copy's state is the one `doctor` and `upgrade` go by.
 */
export type GenerationSkill =
  | { source: 'project'; path: string; state: SkillState }
  | { source: 'default'; version: string }

/** What a generation would follow if it started now. */
export interface GenerationSkillResponse {
  skill: GenerationSkill
}

/** What publish did with the canvas: shared it on the pull request, or kept it local. */
export type GenerationSharing = CanvasSharing | { status: 'local' }

export interface GenerationJob {
  key: ReviewKey
  force: boolean
  agent: string
  /** The `--model` the agent runs with, or null for the agent's own default. */
  model: string | null
  /** The skill the agent was given. */
  skill: GenerationSkill
  phase: GenerationPhase
  /** True once a stop was asked for, until the job ends. */
  stopping?: boolean
  /** The publish attempt the job is on, from 1; at most `maxRounds`. */
  round: number
  maxRounds: number
  startedAt: string
  endedAt?: string
  headSha?: string
  /** The latest tool calls the agent made, newest last: their titles only, never their output. */
  activity: string[]
  /** Set while an agent turn runs. */
  pulse?: AgentPulse
  /** The problems the last rejected publish named, one line each. */
  problems?: string[]
  /** Set on a done job, which always published: what publish did with the canvas. */
  sharing?: GenerationSharing
  error?: ErrorEnvelope['error']
}

/** The open PR of the checked-out branch, which `pr-review generate` with no target generates for. */
export interface GenerationTargetResponse {
  prNumber: number | null
}

export interface GenerationResponse {
  /** The job of this review the server ran last, running or ended; null when it ran none. */
  job: GenerationJob | null
}

// The page's dialog and `pr-review generate` name the phases in the same words.
export { isRunning, PHASE_LABELS } from '../../static/js/generation-phases.js'
