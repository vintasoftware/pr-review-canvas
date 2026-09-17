import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Repo } from '../contract/review-artifact.js'
import { readText } from './atomic-json.js'

/**
 * `.pr-review/` next to the git common dir, so every worktree of one clone shares canvases, PR
 * state, and settings. The common dir of a worktree is `<main checkout>/.git`, and its parent
 * is the main checkout root. An explicit override wins.
 */
export function resolveDataDir(opts: { override?: string | undefined; commonDir: string }): string {
  if (opts.override !== undefined && opts.override !== '') {
    return path.resolve(opts.override)
  }
  return path.join(path.dirname(path.resolve(opts.commonDir)), '.pr-review')
}

/** Creates the directory and the `.gitignore` with `*` so it never gets committed. */
export async function ensureDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const ignore = path.join(dataDir, '.gitignore')
  if ((await readText(ignore)) === null) {
    await writeFile(ignore, '*\n', 'utf8')
  }
}

export function repoDir(dataDir: string, repo: Repo): string {
  const owner = repo.owner.replaceAll('/', '__')
  return path.join(dataDir, 'repos', `${owner}__${repo.name}`)
}
