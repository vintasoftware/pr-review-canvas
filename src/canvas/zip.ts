// The shared canvas format: a zip holding manifest.json and review.json at the root, and nothing
// else. Everything that reads a zip goes through readCanvasZip, so a file from a teammate, from a
// pull request attachment, and from the CLI is checked the same way.
import { unzipSync, zipSync } from 'fflate'
import { type CanvasManifest, CanvasManifestSchema } from '../contract/canvas-manifest.js'
import { type ReviewArtifact, ReviewArtifactSchema } from '../contract/review-artifact.js'

export const MANIFEST_ENTRY = 'manifest.json'
export const REVIEW_ENTRY = 'review.json'
export const CANVAS_ZIP_MAX_BYTES = 20 * 1024 * 1024
/** `PK\x03\x04`, the first bytes of every zip. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const

export interface CanvasZipContents {
  manifest: CanvasManifest
  artifact: ReviewArtifact
}

/** A zip that cannot be read as a canvas. `issues` names the problems, never the file's content. */
export class CanvasZipError extends Error {
  readonly code: 'CANVAS_INVALID' | 'CANVAS_TOO_LARGE'
  readonly issues: string[]

  constructor(code: 'CANVAS_INVALID' | 'CANVAS_TOO_LARGE', message: string, issues: string[] = []) {
    super(message)
    this.name = 'CanvasZipError'
    this.code = code
    this.issues = issues
  }
}

export function hasZipMagic(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, i) => bytes[i] === byte)
}

export function buildCanvasZip(manifest: CanvasManifest, artifact: ReviewArtifact): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  // Copied into a plain buffer, so the bytes can be handed straight to a Blob or a Response.
  return Uint8Array.from(
    zipSync(
      {
        [MANIFEST_ENTRY]: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
        [REVIEW_ENTRY]: encoder.encode(`${JSON.stringify(artifact, null, 2)}\n`),
      },
      { level: 6, mtime: new Date(manifest.generatedAt) }
    )
  )
}

function decode(entry: Uint8Array | undefined, name: string, issues: string[]): unknown {
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

/**
 * The two entries of the zip, both schema-checked. Names with a directory part are ignored rather
 * than written anywhere, so a zip carrying `../../etc/passwd` reads as a zip missing its entries.
 */
export function readCanvasZip(bytes: Uint8Array): CanvasZipContents {
  if (bytes.length > CANVAS_ZIP_MAX_BYTES) {
    throw new CanvasZipError(
      'CANVAS_TOO_LARGE',
      `the canvas zip is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`
    )
  }
  if (!hasZipMagic(bytes)) {
    throw new CanvasZipError('CANVAS_INVALID', 'this file is not a zip', [
      'the file does not start with the zip signature',
    ])
  }
  let entries: Record<string, Uint8Array>
  // Only the first copy of each of the two root entries is inflated, and the two together may
  // not claim more than the cap, so a small archive cannot inflate into gigabytes.
  const taken = new Set<string>()
  let claimed = 0
  try {
    entries = unzipSync(bytes, {
      filter: file => {
        if (file.name !== MANIFEST_ENTRY && file.name !== REVIEW_ENTRY) {
          return false
        }
        if (taken.has(file.name) || claimed + file.originalSize > CANVAS_ZIP_MAX_BYTES) {
          return false
        }
        taken.add(file.name)
        claimed += file.originalSize
        return true
      },
    })
  } catch (err) {
    throw new CanvasZipError('CANVAS_INVALID', 'the zip could not be read', [
      err instanceof Error ? err.message : String(err),
    ])
  }
  const issues: string[] = []
  const rawManifest = decode(entries[MANIFEST_ENTRY], MANIFEST_ENTRY, issues)
  const rawArtifact = decode(entries[REVIEW_ENTRY], REVIEW_ENTRY, issues)
  if (issues.length > 0) {
    throw new CanvasZipError('CANVAS_INVALID', 'the zip is not a review canvas', issues)
  }
  const manifest = CanvasManifestSchema.safeParse(rawManifest)
  const artifact = ReviewArtifactSchema.safeParse(rawArtifact)
  if (!manifest.success) {
    issues.push(...manifest.error.issues.map(i => `${MANIFEST_ENTRY}: ${i.path.join('.')} ${i.message}`))
  }
  if (!artifact.success) {
    issues.push(...artifact.error.issues.map(i => `${REVIEW_ENTRY}: ${i.path.join('.')} ${i.message}`))
  }
  if (!(manifest.success && artifact.success)) {
    throw new CanvasZipError('CANVAS_INVALID', 'the zip is not a review canvas', issues)
  }
  if (artifact.data.pr.headSha !== manifest.data.headSha) {
    throw new CanvasZipError('CANVAS_INVALID', 'the zip is not a review canvas', [
      `${REVIEW_ENTRY} is for ${artifact.data.pr.headSha.slice(0, 7)} while ${MANIFEST_ENTRY} says ${manifest.data.headSha.slice(0, 7)}`,
    ])
  }
  // A canvas generated before the pull request existed carries no number in review.json, and the
  // export stamps one on the manifest; only two numbers that are both there must agree.
  const artifactPr = artifact.data.pr.number
  const manifestPr = manifest.data.prNumber
  if (artifactPr !== null && manifestPr !== undefined && artifactPr !== manifestPr) {
    throw new CanvasZipError('CANVAS_INVALID', 'the zip is not a review canvas', [
      `${REVIEW_ENTRY} is for #${artifactPr} while ${MANIFEST_ENTRY} says #${manifestPr}`,
    ])
  }
  return { manifest: manifest.data, artifact: artifact.data }
}
