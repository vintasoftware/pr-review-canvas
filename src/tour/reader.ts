// The reader's state of one tour, `reader.json` beside `tour.json`. One reader per machine: the
// server runs as one login, and what it keeps here is theirs.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  freshReaderState,
  type ReaderPick,
  type TourReaderState,
  TourReaderStateSchema,
} from '../contract/tour-api.js'
import { standingDecisions, type TourArtifact } from '../contract/tour.js'
import type { AppContext } from '../server/context.js'
import { readJson, writeJsonAtomic } from '../store/atomic-json.js'

export function readerFile(ctx: AppContext, headSha: string): string {
  return path.join(ctx.tours.tourDir(headSha), 'reader.json')
}

/** Where finishing writes the re-implementation prompt, beside the tour. */
export function planPromptFile(ctx: AppContext, headSha: string): string {
  return path.join(ctx.tours.tourDir(headSha), 'plan-prompt.md')
}

/** The state as saved, or null before the first save. */
export function savedReaderState(ctx: AppContext, headSha: string): Promise<TourReaderState | null> {
  return readJson(readerFile(ctx, headSha), TourReaderStateSchema)
}

/**
 * The state as saved, else a fresh one. A fresh state for the author starts from the picks the
 * record carried over from the tour of an earlier commit, by decision key, so a regenerated tour
 * does not ask the same questions again.
 */
export async function readReaderState(
  ctx: AppContext,
  headSha: string,
  artifact: TourArtifact,
  author: boolean
): Promise<TourReaderState> {
  const saved = await savedReaderState(ctx, headSha)
  if (saved !== null) return saved
  const state = freshReaderState()
  const carried = author ? artifact.record.author?.picks : undefined
  if (carried !== undefined) {
    for (const decision of artifact.decisions) {
      const pick = carried[decision.key]
      if (pick === undefined) continue
      const entry: ReaderPick = { pick: pick.pick, approved: true }
      if (pick.restatement !== undefined) entry.restatement = pick.restatement
      state.picks[decision.key] = entry
    }
  }
  return state
}

export async function writeReaderState(
  ctx: AppContext,
  headSha: string,
  state: TourReaderState
): Promise<void> {
  await writeJsonAtomic(readerFile(ctx, headSha), state)
}

/**
 * The saved state as it applies to a regenerated tour of the same commit: the picks on decisions
 * that still stand, the notes, answers, and marks on landmarks and questions the new tour still
 * has, from the first step again. What was finished was finished on the old tour, so it goes,
 * and the plan prompt with it.
 */
export function readerStateCarriedTo(
  saved: TourReaderState,
  previous: TourArtifact,
  next: TourArtifact
): TourReaderState {
  const standing = standingDecisions(previous.decisions, next.decisions)
  const landmarks = new Set(next.landmarks.map(l => l.id))
  const questions = new Set(next.quiz.map(q => q.id))
  const byLandmark = <T>(entries: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(entries).filter(([id]) => landmarks.has(id)))
  return {
    ...freshReaderState(),
    picks: Object.fromEntries(Object.entries(saved.picks).filter(([key]) => standing.has(key))),
    quiz: Object.fromEntries(Object.entries(saved.quiz).filter(([id]) => questions.has(id))),
    notes: byLandmark(saved.notes),
    seen: byLandmark(saved.seen),
    codeOpen: byLandmark(saved.codeOpen),
    codeView: byLandmark(saved.codeView),
    audioNoticeSeen: saved.audioNoticeSeen,
    audioOff: saved.audioOff,
  }
}

/** Carries the saved state onto the tour just published, or clears it when there is nothing to carry from. */
export async function carryReaderState(
  ctx: AppContext,
  headSha: string,
  previous: TourArtifact | null,
  next: TourArtifact
): Promise<void> {
  await rm(planPromptFile(ctx, headSha), { force: true })
  const saved = await savedReaderState(ctx, headSha)
  if (saved === null) return
  if (previous === null) {
    await rm(readerFile(ctx, headSha), { force: true })
    return
  }
  await writeReaderState(ctx, headSha, readerStateCarriedTo(saved, previous, next))
}
