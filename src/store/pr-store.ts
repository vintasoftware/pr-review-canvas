import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { type CommentsPayload, CommentsPayloadSchema } from '../contract/comments.js'
import { type DiscoveryCache, DiscoveryCacheSchema } from '../contract/discovery.js'
import { type Pr, PrSchema } from '../contract/review-artifact.js'
import { readJson, readJsonOrDefault, writeJsonAtomic } from './atomic-json.js'

/** PR-keyed files: the cached PR meta and the last comments payload. */
export interface PrStore {
  prDir(number: number): string
  readPr(number: number): Promise<Pr | null>
  writePr(pr: Pr): Promise<void>
  readComments(number: number): Promise<CommentsPayload | null>
  writeComments(number: number, comments: CommentsPayload): Promise<void>
  /** The last attachment scan, so an unchanged PR is not scanned again. */
  readDiscovery(number: number): Promise<DiscoveryCache | null>
  writeDiscovery(number: number, discovery: DiscoveryCache): Promise<void>
  /** PR numbers with a cached pr.json, newest first by file mtime. */
  listRecent(limit: number): Promise<Array<{ number: number; title: string; updatedAt: string }>>
}

export function createPrStore(repoRoot: string): PrStore {
  const prDir = (number: number): string => {
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`not a pull request number: ${number}`)
    }
    return path.join(repoRoot, 'prs', String(number))
  }
  return {
    prDir,
    readPr: number => readJson(path.join(prDir(number), 'pr.json'), PrSchema),
    writePr: async pr => {
      if (pr.number === null) {
        throw new Error('cannot cache a pre-PR change set under prs/')
      }
      await writeJsonAtomic(path.join(prDir(pr.number), 'pr.json'), pr)
    },
    readComments: number => readJson(path.join(prDir(number), 'comments.json'), CommentsPayloadSchema),
    writeComments: (number, comments) => writeJsonAtomic(path.join(prDir(number), 'comments.json'), comments),
    readDiscovery: number =>
      readJsonOrDefault(path.join(prDir(number), 'discovery.json'), DiscoveryCacheSchema, () => null),
    writeDiscovery: (number, discovery) => writeJsonAtomic(path.join(prDir(number), 'discovery.json'), discovery),
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
