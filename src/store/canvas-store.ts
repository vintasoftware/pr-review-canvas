import path from 'node:path'
import type { CarriedOverInfo } from '../contract/api.js'
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

/** A canvas of a commit the head was built on, and how many commits the head gained since. */
export interface AncestorCanvas {
  status: 'stale'
  headSha: string
  relation: 'ancestor'
  commitsBehind: number
}

export type CanvasLookup =
  /** `headSha` is the canvas's own commit: the head, or another commit with an identical diff. */
  { status: 'ready'; headSha: string; carriedOver?: CarriedOverInfo } | StaleCanvas | { status: 'missing' }

/** A canvas of another commit: one the head was built on, or one from a line the head no longer contains. */
export type StaleCanvas = AncestorCanvas | { status: 'stale'; headSha: string; relation: 'unrelated' }

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
    const ranked: Array<{ generatedAt: string; found: StaleCanvas }> = []
    for (const [sha, entry] of candidates) {
      const found: StaleCanvas = (await git.isAncestor(sha, currentHeadSha))
        ? {
            status: 'stale',
            headSha: sha,
            relation: 'ancestor',
            commitsBehind: await git.countCommitsBetween(sha, currentHeadSha),
          }
        : { status: 'stale', headSha: sha, relation: 'unrelated' }
      ranked.push({ generatedAt: entry.generatedAt, found })
    }
    ranked.sort((a, b) => {
      if (a.found.relation !== b.found.relation) {
        return a.found.relation === 'ancestor' ? -1 : 1
      }
      return a.generatedAt < b.generatedAt ? 1 : a.generatedAt > b.generatedAt ? -1 : 0
    })
    return ranked[0]?.found ?? { status: 'missing' }
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
