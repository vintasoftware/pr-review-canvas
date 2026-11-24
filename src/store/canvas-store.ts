import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { lock } from 'proper-lockfile'
import type { CarriedOverInfo, StaleRelation } from '../contract/api.js'
import {
  type CanvasIndex,
  CanvasIndexSchema,
  type CanvasManifest,
  CanvasManifestSchema,
} from '../contract/canvas-manifest.js'
import { type ReviewArtifact, ReviewArtifactSchema } from '../contract/review-artifact.js'
import { isLocalKey, type LocalKey, type ReviewKey } from '../contract/review-key.js'
import type { Git } from '../git/git.js'
import { readJson, readText, writeJsonAtomic } from './atomic-json.js'

export type CanvasLookup =
  /** `headSha` is the canvas's own commit: the head, or another commit with an identical diff. */
  { status: 'ready'; headSha: string; carriedOver?: CarriedOverInfo } | StaleCanvas | { status: 'missing' }

/** A canvas of another diff than the head's, and how it relates to the head. */
export type StaleCanvas = { status: 'stale'; headSha: string } & StaleRelation

/**
 * How a canvas of another commit relates to the head: built on by it, with the commits the head
 * gained since, or off a line the head no longer contains.
 */
export async function relateToHead(
  git: Git,
  sha: string,
  headSha: string
): Promise<Extract<StaleRelation, { relation: 'ancestor' | 'unrelated' }>> {
  return (await git.isAncestor(sha, headSha))
    ? { relation: 'ancestor', commitsBehind: await git.countCommitsBetween(sha, headSha) }
    : { relation: 'unrelated' }
}

/** One canvas as `index.json` lists it. */
export type CanvasEntry = CanvasIndex['canvases'][string]

/**
 * Whether a canvas is one of this target's. A canvas belongs to a pull request when it was
 * generated for it or before it existed; to a local review when it belongs to no pull request and
 * was made in the same checkout (`worktree` is the linked worktree's label, null for the main
 * checkout). A snapshot of uncommitted work sits on no branch, so only the `uncommitted` review
 * claims it.
 *
 * Every consumer asks through here, by way of the store's `belongsTo`: the lookups that pick the
 * canvas to show, and the routes that accept a canvas a mark was made on. Two answers to this
 * question is how marks end up keyed to a canvas their review will never show.
 */
export function canvasBelongsTo(entry: CanvasEntry, key: ReviewKey, worktree: string | null): boolean {
  if (isLocalKey(key)) {
    return (
      entry.prNumber === undefined &&
      (entry.checkout ?? null) === worktree &&
      (key === 'uncommitted' || entry.worktree !== true)
    )
  }
  return entry.worktree !== true && (entry.prNumber === undefined || entry.prNumber === key)
}

/**
 * Whether a target reads the canvas stored for a commit, given whether it owns it (`canvasBelongsTo`)
 * and whether the commit is its head. Its own it reads wherever they sit. For its head commit it
 * also reads one generated on this machine for another target, which describes the same commit. One
 * imported for another pull request it never reads: whoever shared that canvas was taken at their
 * word for that pull request alone.
 */
export function readsCanvas(entry: CanvasEntry, owned: boolean, atHead: boolean): boolean {
  return owned || (atHead && entry.source === 'local')
}

export interface CanvasStore {
  readonly root: string
  /** `canvasBelongsTo` for this store's checkout. */
  belongsTo(entry: CanvasEntry, key: ReviewKey): boolean
  /**
   * The index entry of the canvas `key` reads for `sha` (`readsCanvas`), or undefined when none is
   * stored or the one stored is not its to read. `headSha` is the target's head commit.
   */
  entryFor(key: ReviewKey, sha: string, headSha: string): Promise<CanvasEntry | undefined>
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
   * The best canvas for this PR: the one written for its current head, unless it was imported for
   * another pull request, else the newest one the head was built on top of, else one from a branch
   * the head no longer contains.
   */
  findForPr(prNumber: number, currentHeadSha: string): Promise<CanvasLookup>
  /**
   * The best canvas for a local review: the one for this head, else the newest canvas that belongs
   * to no pull request. A snapshot of uncommitted work counts only for the `uncommitted` review.
   */
  findForLocal(key: LocalKey, currentHeadSha: string): Promise<CanvasLookup>
  /**
   * Replaces the review.json of a stored canvas with the author's revision of it, and records the
   * revision time in the index. The manifest and every other index field stay as they are.
   */
  revise(headSha: string, artifact: ReviewArtifact & { revisedAt: string }): Promise<void>
  /** Records the PR number on a canvas that has none: one exported before the pull request existed. */
  attachPrNumber(headSha: string, prNumber: number): Promise<void>
}

const SHA_RE = /^[0-9a-f]{40}$/

/** `worktree` is the label of the linked worktree the store serves; null for the main checkout. */
export function createCanvasStore(repoRoot: string, git: Git, worktree: string | null): CanvasStore {
  const indexFile = path.join(repoRoot, 'index.json')
  const canvasDir = (headSha: string): string => {
    if (!SHA_RE.test(headSha)) {
      throw new Error(`not a commit sha: ${headSha}`)
    }
    return path.join(repoRoot, 'canvases', headSha)
  }
  const readIndex = async (): Promise<CanvasIndex> =>
    (await readJson(indexFile, CanvasIndexSchema)) ?? { canvases: {} }

  // All index writers share this lock, including other CLI/server processes. Atomic renames
  // keep readers safe; the lock keeps a writer from replacing another writer's newer entry.
  const updateIndex = async (update: (index: CanvasIndex) => Promise<void>): Promise<void> => {
    await mkdir(repoRoot, { recursive: true })
    const root = await realpath(repoRoot)
    const release = await lock(root, {
      lockfilePath: path.join(root, 'index.json.lock'),
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

  /**
   * The canvas for this head, or the closest one `accept` allows. Commits the head was built on
   * come first, newest wins inside a relation, and a canvas off a discarded branch is the last
   * resort.
   */
  const rank = async (
    currentHeadSha: string,
    accept: (entry: CanvasEntry) => boolean
  ): Promise<CanvasLookup> => {
    const index = await readIndex()
    const own = index.canvases[currentHeadSha]
    if (own !== undefined && readsCanvas(own, accept(own), true)) {
      return { status: 'ready', headSha: currentHeadSha }
    }
    const candidates = Object.entries(index.canvases).filter(
      ([sha, entry]) => sha !== currentHeadSha && accept(entry)
    )
    const ranked: Array<{ generatedAt: string; found: StaleCanvas }> = []
    for (const [sha, entry] of candidates) {
      const found: StaleCanvas = {
        status: 'stale',
        headSha: sha,
        ...(await relateToHead(git, sha, currentHeadSha)),
      }
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
    write: (headSha, artifact, manifest, prNumber, flags) =>
      updateIndex(async index => {
        const dir = canvasDir(headSha)
        await writeJsonAtomic(path.join(dir, 'review.json'), artifact)
        await writeJsonAtomic(path.join(dir, 'manifest.json'), manifest)
        const entry: CanvasEntry = {
          generatedAt: artifact.generatedAt,
          source: artifact.source,
        }
        const number = prNumber ?? manifest.prNumber
        if (number !== undefined) {
          entry.prNumber = number
        }
        if (artifact.revisedAt !== undefined) {
          entry.revisedAt = artifact.revisedAt
        }
        if (artifact.importedAt !== undefined) {
          entry.importedAt = artifact.importedAt
        }
        if (artifact.basisCanvasSha !== undefined) {
          entry.basisCanvasSha = artifact.basisCanvasSha
        }
        if (flags?.worktree === true) {
          entry.worktree = true
        }
        // A local review is this checkout's own; a pull request's canvas is every worktree's.
        if (number === undefined && worktree !== null) {
          entry.checkout = worktree
        }
        index.canvases[headSha] = entry
      }),
    belongsTo: (entry, key) => canvasBelongsTo(entry, key, worktree),
    entryFor: async (key, sha, headSha) => {
      const entry = (await readIndex()).canvases[sha]
      return entry !== undefined && readsCanvas(entry, canvasBelongsTo(entry, key, worktree), sha === headSha)
        ? entry
        : undefined
    },
    findForPr: (prNumber, currentHeadSha) =>
      rank(currentHeadSha, entry => canvasBelongsTo(entry, prNumber, worktree)),
    findForLocal: (key, currentHeadSha) =>
      rank(currentHeadSha, entry => canvasBelongsTo(entry, key, worktree)),
    revise: (headSha, artifact) =>
      updateIndex(async index => {
        const entry = index.canvases[headSha]
        if (entry === undefined) {
          throw new Error(`no canvas for ${headSha} to revise`)
        }
        await writeJsonAtomic(path.join(canvasDir(headSha), 'review.json'), artifact)
        index.canvases[headSha] = { ...entry, revisedAt: artifact.revisedAt }
      }),
    attachPrNumber: (headSha, prNumber) =>
      updateIndex(async index => {
        const entry = index.canvases[headSha]
        if (entry === undefined || entry.prNumber !== undefined) {
          return
        }
        index.canvases[headSha] = { ...entry, prNumber }
      }),
  }
}
