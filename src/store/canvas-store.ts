import path from 'node:path'
import type { CanvasRelation } from '../contract/api.js'
import {
  type CanvasIndex,
  CanvasIndexSchema,
  type CanvasManifest,
  CanvasManifestSchema,
} from '../contract/canvas-manifest.js'
import { type ReviewArtifact, ReviewArtifactSchema } from '../contract/review-artifact.js'
import type { LocalKey } from '../contract/review-key.js'
import type { Git } from '../git/git.js'
import { readJson, readText, writeJsonAtomic } from './atomic-json.js'

export type CanvasLookup =
  | { status: 'ready'; headSha: string }
  | { status: 'stale'; headSha: string; relation: CanvasRelation; commitsBehind?: number }
  | { status: 'missing' }

export interface CanvasStore {
  readonly root: string
  canvasDir(headSha: string): string
  readIndex(): Promise<CanvasIndex>
  /** True when a review.json exists for the sha, whatever its format. */
  exists(headSha: string): Promise<boolean>
  readArtifact(headSha: string): Promise<ReviewArtifact | null>
  readManifest(headSha: string): Promise<CanvasManifest | null>
  /** Writes review.json + manifest.json atomically and records the canvas in index.json. */
  write(
    headSha: string,
    artifact: ReviewArtifact,
    manifest: CanvasManifest,
    prNumber?: number,
    flags?: { worktree?: boolean }
  ): Promise<void>
  /**
   * The best canvas for this PR: the one written for its current head, else the newest one the
   * head was built on top of, else one from a branch the head no longer contains.
   */
  findForPr(prNumber: number, currentHeadSha: string): Promise<CanvasLookup>
  /**
   * The best canvas for a local review: the one for this head, else the newest canvas that belongs
   * to no pull request. A snapshot of uncommitted work counts only for the `uncommitted` review.
   */
  findForLocal(key: LocalKey, currentHeadSha: string): Promise<CanvasLookup>
  /** Records the PR number on a canvas that was exported before the pull request existed. */
  attachPrNumber(headSha: string, prNumber: number): Promise<void>
}

const SHA_RE = /^[0-9a-f]{40}$/

export function createCanvasStore(repoRoot: string, git: Git): CanvasStore {
  const indexFile = path.join(repoRoot, 'index.json')
  const canvasDir = (headSha: string): string => {
    if (!SHA_RE.test(headSha)) {
      throw new Error(`not a commit sha: ${headSha}`)
    }
    return path.join(repoRoot, 'canvases', headSha)
  }
  const readIndex = async (): Promise<CanvasIndex> =>
    (await readJson(indexFile, CanvasIndexSchema)) ?? { canvases: {} }

  /**
   * The canvas for this head, or the closest one `accept` allows. Commits the head was built on
   * come first, newest wins inside a relation, and a canvas off a discarded branch is the last
   * resort.
   */
  const rank = async (
    currentHeadSha: string,
    accept: (entry: CanvasIndex['canvases'][string]) => boolean
  ): Promise<CanvasLookup> => {
    const index = await readIndex()
    if (index.canvases[currentHeadSha] !== undefined) {
      return { status: 'ready', headSha: currentHeadSha }
    }
    const candidates = Object.entries(index.canvases).filter(
      ([sha, entry]) => sha !== currentHeadSha && accept(entry)
    )
    const ranked: Array<{
      headSha: string
      generatedAt: string
      relation: CanvasRelation
      commitsBehind?: number
    }> = []
    for (const [sha, entry] of candidates) {
      if (await git.isAncestor(sha, currentHeadSha)) {
        ranked.push({
          headSha: sha,
          generatedAt: entry.generatedAt,
          relation: 'ancestor',
          commitsBehind: await git.countCommitsBetween(sha, currentHeadSha),
        })
      } else {
        ranked.push({ headSha: sha, generatedAt: entry.generatedAt, relation: 'unrelated' })
      }
    }
    ranked.sort((a, b) => {
      if (a.relation !== b.relation) {
        return a.relation === 'ancestor' ? -1 : 1
      }
      return a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0
    })
    const best = ranked[0]
    if (best === undefined) {
      return { status: 'missing' }
    }
    return best.commitsBehind === undefined
      ? { status: 'stale', headSha: best.headSha, relation: best.relation }
      : {
          status: 'stale',
          headSha: best.headSha,
          relation: best.relation,
          commitsBehind: best.commitsBehind,
        }
  }

  return {
    root: repoRoot,
    canvasDir,
    readIndex,
    exists: async headSha => (await readText(path.join(canvasDir(headSha), 'review.json'))) !== null,
    readArtifact: headSha => readJson(path.join(canvasDir(headSha), 'review.json'), ReviewArtifactSchema),
    readManifest: headSha => readJson(path.join(canvasDir(headSha), 'manifest.json'), CanvasManifestSchema),
    write: async (headSha, artifact, manifest, prNumber, flags) => {
      const dir = canvasDir(headSha)
      await writeJsonAtomic(path.join(dir, 'review.json'), artifact)
      await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest)
      const index = await readIndex()
      const entry: CanvasIndex['canvases'][string] = {
        generatedAt: artifact.generatedAt,
        source: artifact.source,
      }
      const number = prNumber ?? manifest.prNumber
      if (number !== undefined) {
        entry.prNumber = number
      }
      if (artifact.importedAt !== undefined) {
        entry.importedAt = artifact.importedAt
      }
      if (flags?.worktree === true) {
        entry.worktree = true
      }
      index.canvases[headSha] = entry
      await writeJsonAtomic(indexFile, index)
    },
    findForPr: (prNumber, currentHeadSha) =>
      // A canvas belongs to this PR when it was exported for it, or before the PR existed. A
      // snapshot of uncommitted work never does: its commit is on no branch at all.
      rank(
        currentHeadSha,
        entry => entry.worktree !== true && (entry.prNumber === undefined || entry.prNumber === prNumber)
      ),
    findForLocal: (key, currentHeadSha) =>
      rank(
        currentHeadSha,
        entry => entry.prNumber === undefined && (key === 'uncommitted' || entry.worktree !== true)
      ),
    attachPrNumber: async (headSha, prNumber) => {
      const index = await readIndex()
      const entry = index.canvases[headSha]
      if (entry === undefined || entry.prNumber === prNumber) {
        return
      }
      index.canvases[headSha] = { ...entry, prNumber }
      await writeJsonAtomic(indexFile, index)
    },
  }
}
