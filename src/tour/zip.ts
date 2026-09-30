// The shared tour format: a zip holding manifest.json and tour.json at the root. The manifest is
// the canvas's, with the tool named `pr-review-tour`, so one reader recognises both.
import { unzipSync, zipSync } from 'fflate'
import { type CanvasManifest, CanvasManifestSchema } from '../contract/canvas-manifest.js'
import type { Repo } from '../contract/review-artifact.js'
import { type TourArtifact, TourArtifactSchema } from '../contract/tour.js'
import { CANVAS_ZIP_MAX_BYTES, hasZipMagic } from '../canvas/zip.js'
import { repoSlug } from '../canvas/name.js'
import { AppError } from '../server/errors.js'

export const TOUR_MANIFEST_ENTRY = 'manifest.json'
export const TOUR_ENTRY = 'tour.json'
export const TOUR_TOOL_NAME = 'pr-review-tour'

/** `pr-<n>-<time>-<sha8>-<repo>-tour.zip`, the canvas name's grammar with a tour suffix. */
export function buildTourZipName(opts: {
  repo: Repo
  headSha: string
  generatedAt: string
  prNumber?: number | undefined
}): string {
  const target = opts.prNumber === undefined ? 'ref' : `pr-${opts.prNumber}`
  const timestamp = new Date(opts.generatedAt).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z'
  return `${target}-${timestamp}-${opts.headSha.slice(0, 8)}-${repoSlug(opts.repo)}-tour.zip`
}

/** A name that is a tour zip of `repo`: its sha prefix and pull request number. */
export function parseTourZipName(
  filename: string,
  repo: Repo
): { prNumber?: number; shaPrefix: string } | null {
  const suffix = `-${repoSlug(repo)}-tour.zip`
  const lower = filename.toLowerCase()
  if (!lower.endsWith(suffix)) return null
  const m = /^(?:pr-([1-9]\d*)|ref)-\d{8}t\d{6}z-([0-9a-f]{8})$/.exec(lower.slice(0, -suffix.length))
  const shaPrefix = m?.[2]
  if (shaPrefix === undefined) return null
  const pr = m?.[1]
  return pr === undefined ? { shaPrefix } : { prNumber: Number(pr), shaPrefix }
}

export function buildTourZip(manifest: CanvasManifest, artifact: TourArtifact): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  return Uint8Array.from(
    zipSync(
      {
        [TOUR_MANIFEST_ENTRY]: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
        [TOUR_ENTRY]: encoder.encode(`${JSON.stringify(artifact, null, 2)}\n`),
      },
      { level: 6, mtime: new Date(manifest.generatedAt) }
    )
  )
}

export interface TourZipContents {
  manifest: CanvasManifest
  artifact: TourArtifact
}

/** The two entries of a tour zip, both schema-checked; the same guards as the canvas reader. */
export function readTourZip(bytes: Uint8Array): TourZipContents {
  const invalid = (issues: string[]) =>
    new AppError('CANVAS_INVALID', 'the zip is not a tour', 400, undefined, issues)
  if (bytes.length > CANVAS_ZIP_MAX_BYTES) {
    throw new AppError('CANVAS_TOO_LARGE', `the tour zip is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`, 413)
  }
  if (!hasZipMagic(bytes)) throw invalid(['the file does not start with the zip signature'])
  const taken = new Set<string>()
  let claimed = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter: file => {
        if (file.name !== TOUR_MANIFEST_ENTRY && file.name !== TOUR_ENTRY) return false
        if (taken.has(file.name) || claimed + file.originalSize > CANVAS_ZIP_MAX_BYTES) return false
        taken.add(file.name)
        claimed += file.originalSize
        return true
      },
    })
  } catch (err) {
    throw invalid([err instanceof Error ? err.message : String(err)])
  }
  const issues: string[] = []
  const decode = (name: string): unknown => {
    const entry = entries[name]
    if (entry === undefined) {
      issues.push(`${name} is missing from the zip`)
      return null
    }
    try {
      return JSON.parse(new TextDecoder().decode(entry)) as unknown
    } catch {
      issues.push(`${name} is not valid JSON`)
      return null
    }
  }
  const rawManifest = decode(TOUR_MANIFEST_ENTRY)
  const rawTour = decode(TOUR_ENTRY)
  if (issues.length > 0) throw invalid(issues)
  const manifest = CanvasManifestSchema.safeParse(rawManifest)
  const artifact = TourArtifactSchema.safeParse(rawTour)
  if (!manifest.success) {
    issues.push(...manifest.error.issues.map(i => `${TOUR_MANIFEST_ENTRY}: ${i.path.join('.')} ${i.message}`))
  }
  if (!artifact.success) {
    issues.push(...artifact.error.issues.map(i => `${TOUR_ENTRY}: ${i.path.join('.')} ${i.message}`))
  }
  if (!(manifest.success && artifact.success)) throw invalid(issues)
  if (artifact.data.headSha !== manifest.data.headSha) {
    throw invalid([
      `${TOUR_ENTRY} is for ${artifact.data.headSha.slice(0, 7)} while ${TOUR_MANIFEST_ENTRY} says ${manifest.data.headSha.slice(0, 7)}`,
    ])
  }
  return { manifest: manifest.data, artifact: artifact.data }
}
