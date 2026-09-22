import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { type CommentsPayload, CommentsPayloadSchema } from '../contract/comments.js'
import { type DiscoveryCache, DiscoveryCacheSchema } from '../contract/discovery.js'
import { type LocalPrepareTarget, LocalPrepareTargetSchema } from '../contract/generation-context.js'
import { isLocalKey, keyToString, type LocalKey, type ReviewKey } from '../contract/review-key.js'
import { type Pr, PrSchema } from '../contract/review-artifact.js'
import { readJson, readJsonOrDefault, writeJsonAtomic } from './atomic-json.js'

/** Target-keyed files: the cached PR meta and the last comments payload. */
export interface PrStore {
  prDir(key: ReviewKey): string
  readPr(key: ReviewKey): Promise<Pr | null>
  /** The key is passed in, because the local review's meta carries no number of its own. */
  writePr(key: ReviewKey, pr: Pr): Promise<void>
  readComments(number: number): Promise<CommentsPayload | null>
  writeComments(number: number, comments: CommentsPayload): Promise<void>
  /** The last attachment scan, so an unchanged PR is not scanned again. */
  readDiscovery(number: number): Promise<DiscoveryCache | null>
  writeDiscovery(number: number, discovery: DiscoveryCache): Promise<void>
  /** PR numbers with a cached pr.json, newest first by file mtime. Local reviews are not ones. */
  listRecent(limit: number): Promise<Array<{ number: number; title: string; updatedAt: string }>>
  /** What this local review was last prepared for, so the page can resolve the same head again. */
  readLocalTarget(key: LocalKey): Promise<LocalPrepareTarget | null>
  writeLocalTarget(key: LocalKey, target: LocalPrepareTarget): Promise<void>
}

export function createPrStore(repoRoot: string): PrStore {
  const prDir = (key: ReviewKey): string => {
    if (!isLocalKey(key) && (!Number.isInteger(key) || key <= 0)) {
      throw new Error(`not a pull request number: ${String(key)}`)
    }
    return path.join(repoRoot, 'prs', keyToString(key))
  }
  return {
    prDir,
    readPr: key => readJson(path.join(prDir(key), 'pr.json'), PrSchema),
    writePr: async (key, pr) => {
      if (!isLocalKey(key) && pr.number !== key) {
        throw new Error(`pull request ${String(key)} cannot hold the meta of ${String(pr.number)}`)
      }
      await writeJsonAtomic(path.join(prDir(key), 'pr.json'), pr)
    },
    readLocalTarget: key =>
      readJsonOrDefault(path.join(prDir(key), 'target.json'), LocalPrepareTargetSchema, () => null),
    writeLocalTarget: (key, target) => writeJsonAtomic(path.join(prDir(key), 'target.json'), target),
    readComments: number => readJson(path.join(prDir(number), 'comments.json'), CommentsPayloadSchema),
    writeComments: (number, comments) => writeJsonAtomic(path.join(prDir(number), 'comments.json'), comments),
    readDiscovery: number =>
      readJsonOrDefault(path.join(prDir(number), 'discovery.json'), DiscoveryCacheSchema, () => null),
    writeDiscovery: (number, discovery) =>
      writeJsonAtomic(path.join(prDir(number), 'discovery.json'), discovery),
    listRecent: async limit => {
      let names: string[]
      try {
        names = await readdir(path.join(repoRoot, 'prs'))
      } catch {
        return []
      }
      const rows: Array<{ number: number; title: string; updatedAt: string; mtime: number }> = []
      for (const name of names) {
        const number = Number(name)
        if (!Number.isInteger(number) || number <= 0) {
          continue
        }
        const file = path.join(prDir(number), 'pr.json')
        // A directory without pr.json, or one written by an older tool version, is skipped.
        const pr = await readJsonOrDefault(file, PrSchema, () => null)
        if (pr === null) {
          continue
        }
        const s = await stat(file)
        rows.push({ number, title: pr.title, updatedAt: s.mtime.toISOString(), mtime: s.mtimeMs })
      }
      rows.sort((a, b) => b.mtime - a.mtime)
      return rows.slice(0, limit).map(({ number, title, updatedAt }) => ({ number, title, updatedAt }))
    },
  }
}
