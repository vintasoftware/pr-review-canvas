// Sharing a stored tour on its pull request as the author's tour comment, and exporting it as a
// zip when the comment does not fit or the post fails.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveTourSharing } from '../contract/settings.js'
import type { CanvasSharing } from '../contract/self-review.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { TourArtifact } from '../contract/tour.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { defaultExportDir } from '../canvas/export.js'
import { buildTourComment, TOUR_COMMENT_MARKER, type TourZip } from './comment.js'
import { buildTourZip, buildTourZipName, TOUR_TOOL_NAME } from './zip.js'

export function tourManifest(artifact: TourArtifact, version: string): CanvasManifest {
  const manifest: CanvasManifest = {
    formatVersion: 1,
    tool: { name: TOUR_TOOL_NAME, version },
    repo: artifact.repo,
    headSha: artifact.headSha,
    mergeBaseSha: artifact.mergeBaseSha,
    baseRef: artifact.pr.baseRef,
    headRef: artifact.pr.headRef,
    generatedAt: artifact.generatedAt,
    generator: artifact.generator,
  }
  if (artifact.pr.number !== null) manifest.prNumber = artifact.pr.number
  return manifest
}

export async function zipStoredTour(
  ctx: AppContext,
  headSha: string,
  prNumber?: number | undefined
): Promise<{ zip: TourZip; artifact: TourArtifact }> {
  const artifact = await ctx.tours.read(headSha)
  if (artifact === null) {
    throw new AppError(
      'CANVAS_NOT_FOUND',
      `no tour for ${headSha.slice(0, 7)}`,
      404,
      'generate one with the pr-tour skill'
    )
  }
  const number = prNumber ?? (artifact.pr.number === null ? undefined : artifact.pr.number)
  const manifest = tourManifest(artifact, ctx.version)
  if (number !== undefined) manifest.prNumber = number
  const zip: TourZip = {
    name: buildTourZipName({
      repo: artifact.repo,
      headSha,
      prNumber: number,
      generatedAt: artifact.generatedAt,
    }),
    bytes: buildTourZip(manifest, artifact),
    headSha,
  }
  if (number !== undefined) zip.prNumber = number
  return { zip, artifact }
}

export interface TourExportResult {
  status: 'exported'
  path: string
  name: string
  headSha: string
}

export async function exportTour(
  ctx: AppContext,
  opts: { headSha: string; prNumber?: number | undefined }
): Promise<TourExportResult> {
  const { zip } = await zipStoredTour(ctx, opts.headSha, opts.prNumber)
  const file = path.join(defaultExportDir(ctx), zip.name)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, zip.bytes)
  return { status: 'exported', path: file, name: zip.name, headSha: zip.headSha }
}

/** Whether tours are shared on this repository's pull requests, for this user. */
export async function tourSharingOn(ctx: AppContext): Promise<boolean> {
  const config = ctx.projectConfig.config
  return resolveTourSharing(
    { sharing: config.sharing, tourShare: config.tour.share },
    await ctx.settings.read()
  )
}

/**
 * Creates or updates the tour comment, unless sharing is off. A failure is returned, not thrown:
 * the tour is stored either way, and the exported zip is the manual fallback.
 */
export async function shareTourOnPr(
  ctx: AppContext,
  headSha: string,
  number: number
): Promise<CanvasSharing> {
  if (!(await tourSharingOn(ctx))) return { status: 'off' }
  try {
    const { zip, artifact } = await zipStoredTour(ctx, headSha, number)
    const body = buildTourComment(zip, artifact, ctx.config.host.canvasCommentLimit)
    const comment = await ctx.prs.postComments(number, async () => {
      const shared = await ctx.config.host.shareCanvas(
        ctx.gh,
        ctx.config.repo,
        number,
        body,
        TOUR_COMMENT_MARKER
      )
      return { result: shared, comments: [{ kind: 'issue', comment: shared }] }
    })
    return { status: 'shared', url: comment.url }
  } catch (err) {
    const exported = await exportTour(ctx, { headSha, prNumber: number })
    return {
      status: 'failed',
      warning: `Automatic tour sharing failed: ${err instanceof Error ? err.message : String(err)}. Attach the ZIP to the ${ctx.config.host.noun} manually.`,
      zipPath: exported.path,
    }
  }
}
