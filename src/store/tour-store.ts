// Tours live beside the canvases: `<repo dir>/tours/<headSha>/tour.json`, with an index of their
// own in the canvas index's shape, so one ownership rule and one ranking serve both stores. A tour
// is filed under its head commit and, for a pull request, under its number; a reviewer's server
// finds the tour for the head it shows, or the newest older one to say so.
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import { type CanvasEntry, CanvasEntrySchema } from '../contract/canvas-manifest.js'
import type { ReviewKey } from '../contract/review-key.js'
import { type TourArtifact, TourArtifactSchema } from '../contract/tour.js'
import type { Git } from '../git/git.js'
import { readJson, readText, writeJsonAtomic } from './atomic-json.js'
import { canvasBelongsTo, type CanvasLookup, findForHead } from './canvas-store.js'

export const TourIndexSchema = z.object({ tours: z.record(z.string(), CanvasEntrySchema) })
export type TourIndex = z.infer<typeof TourIndexSchema>

export interface TourStore {
  readonly root: string
  /** `canvasBelongsTo` for this store's checkout: the one rule every lookup and route applies. */
  belongsTo(entry: CanvasEntry, key: ReviewKey): boolean
  tourDir(headSha: string): string
  /** Where the generator writes a landmark's scene and micro-world files. */
  scenesDir(headSha: string): string
  readIndex(): Promise<TourIndex>
  exists(headSha: string): Promise<boolean>
  read(headSha: string): Promise<TourArtifact | null>
  /** Writes tour.json atomically and records the tour in index.json. */
  write(headSha: string, artifact: TourArtifact, flags?: { worktree?: boolean }): Promise<void>
  /** Replaces tour.json with a revised record, and notes the revision time in the index. */
  revise(headSha: string, artifact: TourArtifact & { revisedAt: string }): Promise<void>
  /** The tour for this head, else the newest one of this target, else nothing. */
  findFor(key: ReviewKey, currentHeadSha: string): Promise<CanvasLookup>
}

const SHA_RE = /^[0-9a-f]{40}$/

/** `worktree` is the label of the linked worktree the store serves; null for the main checkout. */
export function createTourStore(repoRoot: string, git: Git, worktree: string | null): TourStore {
  const root = path.join(repoRoot, 'tours')
  const indexFile = path.join(root, 'index.json')
  const tourDir = (headSha: string): string => {
    if (!SHA_RE.test(headSha)) throw new Error(`not a commit sha: ${headSha}`)
    return path.join(root, headSha)
  }
  const readIndex = async (): Promise<TourIndex> =>
    (await readJson(indexFile, TourIndexSchema)) ?? { tours: {} }

  const updateIndex = async (update: (index: TourIndex) => Promise<void>): Promise<void> => {
    await mkdir(root, { recursive: true })
    const real = await realpath(root)
    const release = await lock(real, {
      lockfilePath: path.join(real, 'index.json.lock'),
      retries: { retries: 100, factor: 1, minTimeout: 100, maxTimeout: 100 },
    })
    try {
      const index = await readIndex()
      await update(index)
      await writeJsonAtomic(indexFile, index)
    } finally {
      await release()
    }
  }

  const belongsTo = (entry: CanvasEntry, key: ReviewKey): boolean => canvasBelongsTo(entry, key, worktree)

  return {
    root,
    belongsTo,
    tourDir,
    scenesDir: headSha => path.join(tourDir(headSha), 'scenes'),
    readIndex,
    exists: async headSha => (await readText(path.join(tourDir(headSha), 'tour.json'))) !== null,
    read: headSha => readJson(path.join(tourDir(headSha), 'tour.json'), TourArtifactSchema),
    write: (headSha, artifact, flags) =>
      updateIndex(async index => {
        await writeJsonAtomic(path.join(tourDir(headSha), 'tour.json'), artifact)
        const entry: CanvasEntry = { generatedAt: artifact.generatedAt, source: artifact.source }
        if (artifact.pr.number !== null) entry.prNumber = artifact.pr.number
        if (artifact.revisedAt !== undefined) entry.revisedAt = artifact.revisedAt
        if (flags?.worktree === true) entry.worktree = true
        // A local review is this checkout's own; a pull request's tour is every worktree's.
        if (artifact.pr.number === null && worktree !== null) entry.checkout = worktree
        index.tours[headSha] = entry
      }),
    revise: (headSha, artifact) =>
      updateIndex(async index => {
        const entry = index.tours[headSha]
        if (entry === undefined) throw new Error(`no tour for ${headSha} to revise`)
        await writeJsonAtomic(path.join(tourDir(headSha), 'tour.json'), artifact)
        index.tours[headSha] = { ...entry, revisedAt: artifact.revisedAt }
      }),
    findFor: async (key, currentHeadSha) =>
      findForHead(git, currentHeadSha, (await readIndex()).tours, entry => belongsTo(entry, key)),
  }
}
