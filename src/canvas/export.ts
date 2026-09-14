// Building the zip a human attaches to the pull request. The bytes are built once and either
// written to a file (CLI) or streamed to the browser (the header's export command).
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { buildCanvasZipName } from './name.js'
import { buildCanvasZip } from './zip.js'

export interface CanvasZip {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  headSha: string
  prNumber?: number
}

/**
 * The zip for one stored canvas. `prNumber` stamps a canvas exported before the pull request
 * existed, so the file name and the manifest name the PR.
 */
export async function buildCanvasZipFor(
  ctx: AppContext,
  headSha: string,
  prNumber?: number | undefined
): Promise<CanvasZip> {
  const artifact = await ctx.canvases.readArtifact(headSha)
  const stored = await ctx.canvases.readManifest(headSha)
  if (artifact === null || stored === null) {
    throw new AppError(
      'CANVAS_NOT_FOUND',
      `no canvas for ${headSha.slice(0, 7)}`,
      404,
      'generate one with the pr-review-canvas skill, or pass a head that has one'
    )
  }
  const number = prNumber ?? stored.prNumber
  const manifest: CanvasManifest = number === undefined ? stored : { ...stored, prNumber: number }
  const zip: CanvasZip = {
    name: buildCanvasZipName({ repo: manifest.repo, headSha, prNumber: number }),
    bytes: buildCanvasZip(manifest, artifact),
    headSha,
  }
  if (number !== undefined) {
    zip.prNumber = number
  }
  return zip
}

export interface ExportResult {
  status: 'exported'
  path: string
  name: string
  headSha: string
  prNumber?: number
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** `--out` names a file when it ends in `.zip` or is not an existing directory. */
export async function resolveOutPath(out: string | undefined, defaultDir: string, name: string): Promise<string> {
  if (out === undefined) {
    return path.join(defaultDir, name)
  }
  const resolved = path.resolve(out)
  if (resolved.toLowerCase().endsWith('.zip')) {
    return resolved
  }
  return (await isDirectory(resolved)) ? path.join(resolved, name) : resolved
}

export function defaultExportDir(ctx: AppContext): string {
  return path.join(ctx.config.dataDir, 'exports')
}

export async function exportCanvas(
  ctx: AppContext,
  opts: { headSha: string; prNumber?: number | undefined; out?: string | undefined }
): Promise<ExportResult> {
  const zip = await buildCanvasZipFor(ctx, opts.headSha, opts.prNumber)
  const file = await resolveOutPath(opts.out, defaultExportDir(ctx), zip.name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, zip.bytes)
  const result: ExportResult = { status: 'exported', path: file, name: zip.name, headSha: zip.headSha }
  if (zip.prNumber !== undefined) {
    result.prNumber = zip.prNumber
  }
  return result
}
