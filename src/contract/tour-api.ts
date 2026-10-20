// The tour page's side of the contract: the bundle it opens with, the reader's own state as the
// server keeps it between visits, and what finishing answers with.
import { z } from 'zod'
import {
  NOTE_MAX,
  RESTATEMENT_FIELD_MAX,
  RESTATEMENT_PLACE_MAX,
  RESTATEMENT_PLACES_MAX,
} from '../../static/js/tour/grill-cards.js'
import type { Pr } from './review-artifact.js'
import type { LocalKey, ReviewKey } from './review-key.js'
import type { CanvasRelation, ChatStatus, PublicHost } from './api.js'
import { type Landmark, READER_PICKS, type TourArtifact, type TourRecord } from './tour.js'

/**
 * The reader's approved restatement of a change, what changes, where, and what stays the same,
 * under the caps the page's card and form apply, so no state the page builds is refused here.
 */
export const RestatementSchema = z.object({
  what: z.string().min(1).max(RESTATEMENT_FIELD_MAX),
  where: z.array(z.string().min(1).max(RESTATEMENT_PLACE_MAX)).max(RESTATEMENT_PLACES_MAX),
  unchanged: z.string().min(1).max(RESTATEMENT_FIELD_MAX),
})
export type Restatement = z.infer<typeof RestatementSchema>

/**
 * The reader's answer to one decision. A keep or the tour's alternative is settled once approved;
 * something else is settled once its restatement was approved, which is what enters the plan.
 */
export const ReaderPickSchema = z.object({
  pick: z.enum(READER_PICKS),
  approved: z.boolean(),
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
  /** A reviewer's approved changes added to their pending review, this time. */
  queued: z.number().int().nonnegative().optional(),
  /** The page's summary of the picks and notes the prompt was written from. */
  basis: z.string().optional(),
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
  notes: z.record(z.string(), z.string().max(NOTE_MAX)).default({}),
  /** The landmarks the reader has had on screen, so the rail marks only those as read. */
  seen: z.record(z.string(), z.boolean()).default({}),
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
export const TourFinishInputSchema = z.object({
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** What the plan was made of when confirmed, as the page sums it up; stored to tell a later change. */
  basis: z.string().max(200_000).optional(),
})

export interface TourFinishResponse {
  finished: TourFinished
  record: TourRecord
  reader: TourReaderState
}

/** A landmark as the page gets it: whether it has a scene or a micro-world, never their HTML. */
export type TourPageLandmark = Omit<Landmark, 'scene' | 'micro'> & { scene: boolean; micro: boolean }
export type TourPageTour = Omit<TourArtifact, 'landmarks'> & { landmarks: TourPageLandmark[] }

/** What importing a tour zip did: stored it, or kept the stored one, which is at least as new. */
export interface TourImportResult {
  status: 'imported' | 'exists'
  headSha: string
  warnings: string[]
}

/** The answer of `POST /api/tours/:n/shared-tour/fetch`. */
export interface SharedTourFetchResponse {
  /** A tour comment was on the pull request. */
  found: boolean
  /** Its tour was stored; false when the stored one was as new, or no comment's zip would import. */
  imported: boolean
  warnings: string[]
}

export interface TourStaleInfo {
  tourHeadSha: string
  currentHeadSha: string
  relation: CanvasRelation
  commitsBehind?: number
}

/** The tour's own options, as the page needs them; the rest belongs to the generator. */
export interface TourPageOptions {
  finalQuiz: 'on' | 'off' | 'required'
  grill: 'change' | 'off'
  audio: 'on' | 'off'
}

export type TourGeneratePermission = 'allowed' | 'not-author' | 'off'

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
  /**
   * Whether this reader may generate the tour from the page (`tour.generate`): `allowed`, or why
   * not: `off` for everyone, `not-author` when only the change's author may.
   */
  generate: TourGeneratePermission
  skillCommand: string
  warnings: string[]
}

/** The JSON the tour page carries in its bootstrap script. */
export interface TourBootstrap {
  key: ReviewKey
  owner: string
  repo: string
  /** Where the project's pages and API live on the server, with a trailing slash. */
  base: string
  /** The project's name on the server: `<owner>/<repo>`, or `<owner>/<repo>~<worktree>`. */
  project: string
  /** The project as the header shows it: a linked worktree by its folder. */
  projectName: string
  /** The checkout's folder when the project runs under the server's environment, not the shell's. */
  reopenIn?: string
  version: string
  host: PublicHost
  preview: boolean
  /** `?landmark=<id>`: open on that landmark, for the preview screenshots. */
  landmark?: string
}
