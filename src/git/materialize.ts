import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CollectedFile } from './diff-collector.js'
import type { Git } from './git.js'

export const MATERIALIZE_MAX_BYTES = 1024 * 1024

export interface MaterializeOptions {
  headSha: string
  mergeBaseSha: string
  files: readonly CollectedFile[]
  outDir: string
}

export interface MaterializeResult {
  written: string[]
  skipped: Array<{ path: string; reason: 'binary' | 'too-large' | 'missing' }>
}

/** Rejects paths that would escape the output directory. */
export function safeJoin(root: string, rel: string): string | null {
  const full = path.resolve(root, rel)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  return full.startsWith(rootWithSep) ? full : null
}

async function writeSide(
  git: Git,
  ref: string,
  filePath: string,
  sideDir: string,
  result: MaterializeResult
): Promise<void> {
  const target = safeJoin(sideDir, filePath)
  if (target === null) {
    result.skipped.push({ path: filePath, reason: 'missing' })
    return
  }
  const size = await git.blobSize(ref, filePath)
  if (size === null) {
    result.skipped.push({ path: filePath, reason: 'missing' })
    return
  }
  if (size > MATERIALIZE_MAX_BYTES) {
    result.skipped.push({ path: filePath, reason: 'too-large' })
    return
  }
  const content = await git.show(ref, filePath)
  if (content === null) {
    result.skipped.push({ path: filePath, reason: 'missing' })
    return
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
  result.written.push(path.relative(path.dirname(sideDir), target))
}

/**
 * Writes the changed files as they are at the PR head (`head/<path>`) and at the merge base
 * (`base/<path>`), so the agent and the context route read the PR without a checkout.
 */
export async function materialize(git: Git, opts: MaterializeOptions): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: [], skipped: [] }
  const headDir = path.join(opts.outDir, 'head')
  const baseDir = path.join(opts.outDir, 'base')
  for (const f of opts.files) {
    if (f.status === 'binary') {
      result.skipped.push({ path: f.path, reason: 'binary' })
      continue
    }
    if (f.status !== 'deleted') {
      await writeSide(git, opts.headSha, f.path, headDir, result)
    }
    if (f.status !== 'added') {
      await writeSide(git, opts.mergeBaseSha, f.oldPath ?? f.path, baseDir, result)
    }
  }
  return result
}
