import { z } from 'zod'
import type { ErrorEnvelope } from './api.js'
import type { ReviewKey } from './review-key.js'
import type { CanvasSharing } from './self-review.js'

/** What the generate button sends: `force` regenerates a canvas that exists for the head already. */
export const GenerateInputSchema = z.object({ force: z.boolean().default(false) }).strict()

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

/** What publish did with the canvas: shared it on the pull request, or kept it local. */
export type GenerationSharing = CanvasSharing | { status: 'local' }

export interface GenerationJob {
  key: ReviewKey
  force: boolean
  agent: string
  /** The `--model` the agent runs with, or null for the agent's own default. */
  model: string | null
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
  /** The problems the last rejected publish named, one line each. */
  problems?: string[]
  /** Set on a done job: published, or prepare found a canvas for the head already. */
  outcome?: 'published' | 'exists'
  sharing?: GenerationSharing
  error?: ErrorEnvelope['error']
}

export interface GenerationResponse {
  /** The job of this review the server ran last, running or ended; null when it ran none. */
  job: GenerationJob | null
}

/** True while the job can still change. */
export function isRunning(job: Pick<GenerationJob, 'phase'>): boolean {
  return job.phase !== 'done' && job.phase !== 'failed' && job.phase !== 'cancelled'
}
