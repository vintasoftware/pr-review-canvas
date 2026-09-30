// Tours live beside the canvases: `<repo dir>/tours/<headSha>/tour.json`, with an index of their
// own. A tour is filed under its head commit and, for a pull request, under its number; a
// reviewer's server finds the tour for the head it shows, or the newest older one to say so.
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { lock } from 'proper-lockfile'
import { z } from 'zod'
import { isLocalKey, type ReviewKey } from '../contract/review-key.js'
import { type TourArtifact, TourArtifactSchema } from '../contract/tour.js'
import type { Git } from '../git/git.js'
import { readJson, readText, writeJsonAtomic } from './atomic-json.js'

export const TourIndexSchema = z.object({
  tours: z.record(
    z.string(),
    z.object({
      prNumber: z.number().int().positive().optional(),
      generatedAt: z.string(),
      revisedAt: z.string().optional(),
      source: z.enum(['local', 'import']),
      /** A snapshot of uncommitted work: it sits on no branch, so no pull request can claim it. */
      worktree: z.boolean().optional(),
    })
  ),
})
export type TourIndex = z.infer<typeof TourIndexSchema>
export type TourEntry = TourIndex['tours'][string]

export type TourLookup =
  | { status: 'ready'; headSha: string }
  | { status: 'stale'; headSha: string; relation: 'ancestor' | 'unrelated'; commitsBehind?: number }
  | { status: 'missing' }

/** The same ownership rule the canvas store applies. */
export function tourBelongsTo(entry: TourEntry, key: ReviewKey): boolean {
  if (isLocalKey(key)) {
    return entry.prNumber === undefined && (key === 'uncommitted' || entry.worktree !== true)
  }
  return entry.worktree !== true && (entry.prNumber === undefined || entry.prNumber === key)
}

export interface TourStore {
  readonly root: string
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
  findFor(key: ReviewKey, currentHeadSha: string): Promise<TourLookup>
}

const SHA_RE = /^[0-9a-f]{40}$/

export function createTourStore(repoRoot: string, git: Git): TourStore {
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

  return {
    root,
    tourDir,
    scenesDir: headSha => path.join(tourDir(headSha), 'scenes'),
    readIndex,
    exists: async headSha => (await readText(path.join(tourDir(headSha), 'tour.json'))) !== null,
    read: headSha => readJson(path.join(tourDir(headSha), 'tour.json'), TourArtifactSchema),
    write: (headSha, artifact, flags) =>
      updateIndex(async index => {
        await writeJsonAtomic(path.join(tourDir(headSha), 'tour.json'), artifact)
        const entry: TourEntry = { generatedAt: artifact.generatedAt, source: artifact.source }
        if (artifact.pr.number !== null) entry.prNumber = artifact.pr.number
        if (artifact.revisedAt !== undefined) entry.revisedAt = artifact.revisedAt
        if (flags?.worktree === true) entry.worktree = true
        index.tours[headSha] = entry
      }),
    revise: (headSha, artifact) =>
      updateIndex(async index => {
        const entry = index.tours[headSha]
        if (entry === undefined) throw new Error(`no tour for ${headSha} to revise`)
        await writeJsonAtomic(path.join(tourDir(headSha), 'tour.json'), artifact)
        index.tours[headSha] = { ...entry, revisedAt: artifact.revisedAt }
      }),
    findFor: async (key, currentHeadSha) => {
      const index = await readIndex()
      const own = index.tours[currentHeadSha]
      if (own !== undefined && tourBelongsTo(own, key)) return { status: 'ready', headSha: currentHeadSha }
      const candidates = Object.entries(index.tours)
        .filter(([sha, entry]) => sha !== currentHeadSha && tourBelongsTo(entry, key))
        .sort(([, a], [, b]) => (a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0))
      const newest = candidates[0]
      if (newest === undefined) return { status: 'missing' }
      const [sha] = newest
      if (await git.isAncestor(sha, currentHeadSha)) {
        return {
          status: 'stale',
          headSha: sha,
          relation: 'ancestor',
          commitsBehind: await git.countCommitsBetween(sha, currentHeadSha),
        }
      }
      return { status: 'stale', headSha: sha, relation: 'unrelated' }
    },
  }
}
