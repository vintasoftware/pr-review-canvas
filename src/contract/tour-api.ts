// The tour page's side of the contract: the bundle it opens with, the reader's own state as the
// server keeps it between visits, and what finishing answers with.
import { z } from 'zod'
import type { Pr } from './review-artifact.js'
import type { LocalKey, ReviewKey } from './review-key.js'
import type { CanvasRelation, ChatStatus, PublicHost } from './api.js'
import { type Landmark, PICKS, REASON_PLACES, type TourArtifact, type TourRecord } from './tour.js'

/** The reader's approved restatement of a change, what changes, where, and what stays the same. */
export const RestatementSchema = z.object({
  what: z.string().min(1).max(2000),
  where: z.array(z.string().min(1).max(300)).max(20),
  unchanged: z.string().min(1).max(2000),
})
export type Restatement = z.infer<typeof RestatementSchema>

/**
 * The reader's answer to one decision. A keep is settled once approved; a change is settled once
 * its restatement was approved, which is what enters the plan.
 */
export const ReaderPickSchema = z.object({
  pick: z.enum(PICKS),
  approved: z.boolean(),
  place: z.enum(REASON_PLACES).optional(),
  restatement: RestatementSchema.optional(),
  tried: z.boolean().optional(),
})
export type ReaderPick = z.infer<typeof ReaderPickSchema>

/** How the record reached the pull request when the tour was finished. */
export const TourSharingSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('shared'), url: z.string() }),
  z.object({ status: z.literal('failed'), warning: z.string(), zipPath: z.string() }),
  z.object({ status: z.literal('off') }),
  z.object({ status: z.literal('local') }),
])
export type TourSharing = z.infer<typeof TourSharingSchema>

export const TourFinishedSchema = z.object({
  at: z.string(),
  /** Where the re-implementation prompt was written, in the tour's directory. */
  promptPath: z.string(),
  prompt: z.string(),
  sharing: TourSharingSchema,
  /** The author's kept reasons posted as comments on their lines, this time. */
  posted: z.number().int().nonnegative().optional(),
  /** A reviewer's approved changes added to their pending review, this time. */
  queued: z.number().int().nonnegative().optional(),
  /** A comment that could not be posted: the finish stands, the reason is said. */
  warnings: z.array(z.string()).optional(),
})
export type TourFinished = z.infer<typeof TourFinishedSchema>

/**
 * Where the reader is in the tour and what they answered, kept in `reader.json` beside the tour so
 * a reload, or another browser on this machine, lands where they left off. Nothing here reaches the
 * pull request until the tour is finished, and the quiz never does.
 */
export const TourReaderStateSchema = z.object({
  step: z.number().int().nonnegative().default(0),
  picks: z.record(z.string(), ReaderPickSchema).default({}),
  quiz: z
    .record(z.string(), z.object({ answered: z.number().int().nonnegative(), right: z.boolean() }))
    .default({}),
  /** A thought per landmark, written while reading, carried into the plan and the prompt. */
  notes: z.record(z.string(), z.string().max(4000)).default({}),
  codeOpen: z.record(z.string(), z.boolean()).default({}),
  codeView: z.record(z.string(), z.enum(['literate', 'raw'])).default({}),
  /** The step a jump came from, so the page can offer the way back. */
  returnTo: z.number().int().nonnegative().nullable().default(null),
  audioNoticeSeen: z.boolean().default(false),
  /** The reader turned speech off for themselves, whatever the project says. */
  audioOff: z.boolean().default(false),
  finished: TourFinishedSchema.optional(),
})
export type TourReaderState = z.infer<typeof TourReaderStateSchema>

export function freshReaderState(): TourReaderState {
  return TourReaderStateSchema.parse({})
}

/** The body of `PUT /api/tours/:n/reader`: the whole state, keyed to the tour on screen. */
export const TourReaderInputSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  reader: TourReaderStateSchema,
})
export type TourReaderInput = z.infer<typeof TourReaderInputSchema>

/** The body of `POST /api/tours/:n/finish`. */
export const TourFinishInputSchema = z.object({ headSha: z.string().regex(/^[0-9a-f]{40}$/) })

export interface TourFinishResponse {
  finished: TourFinished
  record: TourRecord
  reader: TourReaderState
}

/** A landmark as the page gets it: whether it has a scene or a micro-world, never their HTML. */
export type TourPageLandmark = Omit<Landmark, 'scene' | 'micro'> & { scene: boolean; micro: boolean }
export type TourPageTour = Omit<TourArtifact, 'landmarks'> & { landmarks: TourPageLandmark[] }

export interface TourStaleInfo {
  tourHeadSha: string
  currentHeadSha: string
  relation: CanvasRelation
  commitsBehind?: number
}

/** The tour's own options, as the page needs them; the rest belongs to the generator. */
export interface TourPageOptions {
  finalQuiz: 'on' | 'off' | 'required'
  reverseQuiz: 'on' | 'off'
  grill: 'change' | 'always' | 'off'
  audio: 'on' | 'off'
}

export interface TourBundle {
  status: 'ready' | 'stale' | 'missing'
  key: ReviewKey
  pr: Pr
  /** Set on a local review: work that has no pull request, so nothing is shared. */
  local?: LocalKey
  tour?: TourPageTour
  stale?: TourStaleInfo
  reader: TourReaderState
  /** Who is reading: the login the server runs as, and whether it wrote the change. */
  reviewer: { login: string | null; author: boolean }
  /** The tour as written in `tour-model.json`, before it is published: nothing is saved. */
  preview: boolean
  /** Whether finishing shares the record on the pull request. */
  shares: boolean
  options: TourPageOptions
  /** Whether the grilling can run through AI Chat, and with which agent. */
  chat: ChatStatus
  skillCommand: string
  warnings: string[]
}

/** The JSON the tour page carries in its bootstrap script. */
export interface TourBootstrap {
  key: ReviewKey
  owner: string
  repo: string
  version: string
  host: PublicHost
  preview: boolean
  /** `?landmark=<id>`: open on that landmark, for the preview screenshots. */
  landmark?: string
}
