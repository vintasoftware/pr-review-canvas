import path from 'node:path'
import { z } from 'zod'
import { type FileEntry, FileEntrySchema } from '../contract/review-artifact.js'
import { collectDiffs, toFileEntry, toPatchMap } from '../git/diff-collector.js'
import type { Git } from '../git/git.js'
import { materialize } from '../git/materialize.js'
import { labelPatch } from '../git/patch-lines.js'
import { readJson, readText, writeJsonAtomic, writeTextAtomic } from './atomic-json.js'
import type { CanvasStore } from './canvas-store.js'

export interface Derived {
  files: FileEntry[]
  patches: Record<string, string>
}

const DerivedMetaSchema = z.object({ headSha: z.string(), mergeBaseSha: z.string(), builtAt: z.string() })
const FilesSchema = z.array(FileEntrySchema)
const PatchesSchema = z.record(z.string(), z.string())

export interface DerivedStore {
  derivedDir(headSha: string): string
  /** Both commits are local, so `ensure` can rebuild. */
  derivable(headSha: string, mergeBaseSha: string): Promise<boolean>
  /** Reads `derived/` when it matches the commits, otherwise rebuilds it from local git. */
  ensure(headSha: string, mergeBaseSha: string): Promise<Derived>
  read(headSha: string): Promise<Derived | null>
  /** Lines `from..to` (1-based, inclusive) of a materialized file, or null when not materialized. */
  readLines(
    headSha: string,
    side: 'head' | 'base',
    filePath: string,
    from: number,
    to: number
  ): Promise<string[] | null>
}

export function createDerivedStore(canvases: CanvasStore, git: Git, now: () => Date): DerivedStore {
  const derivedDir = (headSha: string): string => path.join(canvases.canvasDir(headSha), 'derived')

  const read = async (headSha: string): Promise<Derived | null> => {
    const dir = derivedDir(headSha)
    const files = await readJson(path.join(dir, 'files.json'), FilesSchema)
    const patches = await readJson(path.join(dir, 'patches.json'), PatchesSchema)
    if (files === null || patches === null) {
      return null
    }
    return { files, patches }
  }

  return {
    derivedDir,
    derivable: async (headSha, mergeBaseSha) =>
      (await git.commitExists(headSha)) && (await git.commitExists(mergeBaseSha)),
    ensure: async (headSha, mergeBaseSha) => {
      const dir = derivedDir(headSha)
      const meta = await readJson(path.join(dir, 'meta.json'), DerivedMetaSchema)
      if (meta !== null && meta.mergeBaseSha === mergeBaseSha) {
        const cached = await read(headSha)
        if (cached !== null) {
          return cached
        }
      }
      const collected = await collectDiffs(git, mergeBaseSha, headSha)
      const files = collected.map(toFileEntry)
      const patches = toPatchMap(collected)
      await writeJsonAtomic(path.join(dir, 'files.json'), files)
      await writeJsonAtomic(path.join(dir, 'patches.json'), patches)
      for (const f of collected) {
        await writeTextAtomic(path.join(dir, 'patches', `${f.key}.diff`), `${labelPatch(f.key, f.patch)}\n`)
      }
      await materialize(git, { headSha, mergeBaseSha, files: collected, outDir: dir })
      await writeJsonAtomic(path.join(dir, 'meta.json'), { headSha, mergeBaseSha, builtAt: now().toISOString() })
      return { files, patches }
    },
    read,
    readLines: async (headSha, side, filePath, from, to) => {
      const root = path.join(derivedDir(headSha), side)
      const full = path.resolve(root, filePath)
      if (!full.startsWith(root + path.sep)) {
        return null
      }
      const text = await readText(full)
      if (text === null) {
        return null
      }
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') {
        lines.pop()
      }
      return lines.slice(Math.max(from, 1) - 1, Math.max(to, 0))
    },
  }
}
