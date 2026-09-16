// One import path for the three ways a canvas arrives: the drop zone, `pr-review import`, and a
// zip discovered on the pull request. Everything is checked here, so no caller can skip a step.
import type { CanvasRelation, ImportResult } from '../contract/api.js'
import type { CanvasManifest } from '../contract/canvas-manifest.js'
import type { ReviewArtifact } from '../contract/review-artifact.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { CanvasZipError, readCanvasZip } from './zip.js'

export interface ImportOptions {
  bytes: Uint8Array
  /** The pull request the canvas is imported for; recorded on the canvas. */
  prNumber?: number | undefined
  /** The head the page is looking at. Absent means the canvas is taken as the current one. */
  currentHeadSha?: string | undefined
  /** Accepts a canvas exported from another repository. */
  force?: boolean | undefined
}

function sameRepo(a: { owner: string; name: string }, b: { owner: string; name: string }): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()
}

/**
 * The pull request a canvas was made for: the manifest's number, else the one review.json holds.
 * A canvas generated before the pull request existed names none, and joins the PR it is imported
 * for.
 */
function canvasPrNumber(manifest: CanvasManifest, artifact: ReviewArtifact): number | undefined {
  return manifest.prNumber ?? artifact.pr.number ?? undefined
}

/** The zip error as the HTTP envelope the routes and the CLI both report. */
export function toAppErrorFromZip(err: CanvasZipError): AppError {
  if (err.code === 'CANVAS_TOO_LARGE') {
    return new AppError('CANVAS_TOO_LARGE', err.message, 413, 'a review canvas is a few hundred kilobytes')
  }
  return new AppError('CANVAS_INVALID', err.message, 400, err.issues[0], err.issues)
}

/**
 * Fetches the head commit when the clone does not have it, so an imported canvas can show its
 * diffs. A clone that cannot reach the commit reports `derivable: false` instead of failing.
 */
async function ensureDerived(
  ctx: AppContext,
  headSha: string,
  mergeBaseSha: string,
  warnings: string[]
): Promise<boolean> {
  if (!(await ctx.derived.derivable(headSha, mergeBaseSha))) {
    try {
      await ctx.git.fetch('origin', [headSha, mergeBaseSha])
    } catch {
      // Servers may refuse a fetch by sha; the next check reports the canvas as not derivable.
    }
  }
  if (!(await ctx.derived.derivable(headSha, mergeBaseSha))) {
    warnings.push(`${headSha.slice(0, 7)} is not in this clone, so the diffs are not available`)
    return false
  }
  try {
    await ctx.derived.ensure(headSha, mergeBaseSha)
    return true
  } catch (err) {
    warnings.push(`the diffs for ${headSha.slice(0, 7)} could not be rebuilt: ${errorText(err)}`)
    return false
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function relateToHead(
  ctx: AppContext,
  headSha: string,
  currentHeadSha: string
): Promise<{ relation: CanvasRelation; commitsBehind?: number }> {
  if (!(await ctx.git.isAncestor(headSha, currentHeadSha))) {
    return { relation: 'unrelated' }
  }
  return { relation: 'ancestor', commitsBehind: await ctx.git.countCommitsBetween(headSha, currentHeadSha) }
}

/**
 * Validates the zip, stores it under its head sha, and says how it relates to the PR head. A
 * canvas already on disk is kept unless the incoming one was generated later.
 */
export async function importCanvas(ctx: AppContext, opts: ImportOptions): Promise<ImportResult> {
  let contents: { manifest: CanvasManifest; artifact: ReviewArtifact }
  try {
    contents = readCanvasZip(opts.bytes)
  } catch (err) {
    throw err instanceof CanvasZipError ? toAppErrorFromZip(err) : err
  }
  const { manifest, artifact } = contents
  const warnings: string[] = []
  if (!sameRepo(manifest.repo, ctx.config.repo)) {
    const from = `${manifest.repo.owner}/${manifest.repo.name}`
    if (opts.force !== true) {
      throw new AppError(
        'CANVAS_REPO_MISMATCH',
        `this canvas was exported from ${from}, and origin here is ${ctx.config.repo.owner}/${ctx.config.repo.name}`,
        400,
        'import it with --force to use it anyway'
      )
    }
    warnings.push(`imported a canvas exported from ${from}`)
  }

  // The wrong zip attached to a pull request is the common mistake, and the head check below does
  // not catch it: two open pull requests have unrelated heads either way. There is no way to force
  // this one: the canvas is stored under the pull request it names, and calling it another PR's
  // canvas would be a record that contradicts the zip it came from.
  const canvasPr = canvasPrNumber(manifest, artifact)
  if (opts.prNumber !== undefined && canvasPr !== undefined && canvasPr !== opts.prNumber) {
    throw new AppError(
      'CANVAS_PR_MISMATCH',
      `this canvas was exported for #${canvasPr}, and it is being imported for #${opts.prNumber}`,
      400,
      `import it without --pr to store it under #${canvasPr}, or generate a canvas for #${opts.prNumber}`
    )
  }

  const headSha = manifest.headSha
  const currentHeadSha = opts.currentHeadSha ?? headSha
  const index = await ctx.canvases.readIndex()
  const stored = index.canvases[headSha]
  const keepStored = stored !== undefined && stored.generatedAt >= artifact.generatedAt
  if (!keepStored) {
    const importedAt = ctx.now().toISOString()
    await ctx.canvases.write(headSha, { ...artifact, source: 'import', importedAt }, manifest, opts.prNumber)
  } else if (opts.prNumber !== undefined) {
    await ctx.canvases.attachPrNumber(headSha, opts.prNumber)
  }

  // On `exists` the stored canvas stays, so its own merge base decides what derived/ holds.
  const storedManifest = keepStored ? await ctx.canvases.readManifest(headSha) : null
  const mergeBaseSha = storedManifest?.mergeBaseSha ?? manifest.mergeBaseSha
  const derivable = await ensureDerived(ctx, headSha, mergeBaseSha, warnings)
  if (keepStored) {
    return { status: 'exists', headSha, currentHeadSha, derivable, warnings }
  }
  if (headSha === currentHeadSha) {
    return { status: 'ready', headSha, currentHeadSha, derivable, warnings }
  }
  const related = await relateToHead(ctx, headSha, currentHeadSha)
  const result: ImportResult = {
    status: 'stale',
    headSha,
    currentHeadSha,
    relation: related.relation,
    derivable,
    warnings,
  }
  if (related.commitsBehind !== undefined) {
    result.commitsBehind = related.commitsBehind
  }
  return result
}
