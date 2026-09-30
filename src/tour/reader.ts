// The reader's state of one tour, `reader.json` beside `tour.json`. One reader per machine: the
// server runs as one login, and what it keeps here is theirs.
import path from 'node:path'
import {
  freshReaderState,
  type ReaderPick,
  type TourReaderState,
  TourReaderStateSchema,
} from '../contract/tour-api.js'
import type { TourArtifact } from '../contract/tour.js'
import type { AppContext } from '../server/context.js'
import { readJson, writeJsonAtomic } from '../store/atomic-json.js'

export function readerFile(ctx: AppContext, headSha: string): string {
  return path.join(ctx.tours.tourDir(headSha), 'reader.json')
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
  const saved = await readJson(readerFile(ctx, headSha), TourReaderStateSchema)
  if (saved !== null) return saved
  const state = freshReaderState()
  const carried = author ? artifact.record.author?.picks : undefined
  if (carried !== undefined) {
    for (const decision of artifact.decisions) {
      const pick = carried[decision.key]
      if (pick === undefined) continue
      const entry: ReaderPick = { pick: pick.pick, approved: true }
      if (pick.place !== undefined) entry.place = pick.place
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
