// The shared zip format: manifest.json and one artifact entry at the root, and nothing else. A
// canvas travels as review.json, a tour as tour.json; `readZip` checks both the same way, so a
// file from a teammate, from a pull request attachment, and from the CLI get one set of guards.
import { unzipSync, zipSync } from 'fflate'
import type { z } from 'zod'
import { type CanvasManifest, CanvasManifestSchema } from '../contract/canvas-manifest.js'
import { type ReviewArtifact, ReviewArtifactSchema } from '../contract/review-artifact.js'

export const MANIFEST_ENTRY = 'manifest.json'
export const CANVAS_ZIP_MAX_BYTES = 20 * 1024 * 1024
/** `PK\x03\x04`, the first bytes of every zip. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const

/** What a zip carries beside the manifest, and how its artifact names its commit and pull request. */
export interface ZipFormat<A> {
  entry: string
  schema: z.ZodType<A>
  /** The words of a refusal: "the zip is not <noun>". */
  noun: string
  headShaOf(artifact: A): string
  prNumberOf(artifact: A): number | null
}

export const CANVAS_ZIP: ZipFormat<ReviewArtifact> = {
  entry: 'review.json',
  schema: ReviewArtifactSchema,
  noun: 'a review canvas',
  headShaOf: artifact => artifact.pr.headSha,
  prNumberOf: artifact => artifact.pr.number,
}

export interface ZipContents<A> {
  manifest: CanvasManifest
  artifact: A
  /**
   * The pull request the artifact was made for, once for every reader: the two entries are proved
   * to agree below, and the two ways of holding "no pull request" are settled into one. One
   * generated before the pull request existed names none, and joins the PR that imports it.
   */
  prNumber?: number
}

/** A zip that cannot be read. `issues` names the problems, never the file's content. */
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

export function buildZip<A>(
  format: ZipFormat<A>,
  manifest: CanvasManifest,
  artifact: A
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  // Copied into a plain buffer, so the bytes can be handed straight to a Blob or a Response.
  return Uint8Array.from(
    zipSync(
      {
        [MANIFEST_ENTRY]: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`),
        [format.entry]: encoder.encode(`${JSON.stringify(artifact, null, 2)}\n`),
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
export function readZip<A>(bytes: Uint8Array, format: ZipFormat<A>): ZipContents<A> {
  const invalid = (issues: string[]) =>
    new CanvasZipError('CANVAS_INVALID', `the zip is not ${format.noun}`, issues)
  if (bytes.length > CANVAS_ZIP_MAX_BYTES) {
    throw new CanvasZipError('CANVAS_TOO_LARGE', `the zip is larger than ${CANVAS_ZIP_MAX_BYTES} bytes`)
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
        if (file.name !== MANIFEST_ENTRY && file.name !== format.entry) {
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
  const rawArtifact = decode(entries[format.entry], format.entry, issues)
  if (issues.length > 0) {
    throw invalid(issues)
  }
  const manifest = CanvasManifestSchema.safeParse(rawManifest)
  const artifact = format.schema.safeParse(rawArtifact)
  if (!manifest.success) {
    issues.push(...manifest.error.issues.map(i => `${MANIFEST_ENTRY}: ${i.path.join('.')} ${i.message}`))
  }
  if (!artifact.success) {
    issues.push(...artifact.error.issues.map(i => `${format.entry}: ${i.path.join('.')} ${i.message}`))
  }
  if (!(manifest.success && artifact.success)) {
    throw invalid(issues)
  }
  const headSha = format.headShaOf(artifact.data)
  if (headSha !== manifest.data.headSha) {
    throw invalid([
      `${format.entry} is for ${headSha.slice(0, 7)} while ${MANIFEST_ENTRY} says ${manifest.data.headSha.slice(0, 7)}`,
    ])
  }
  // An artifact generated before the pull request existed carries no number, and the export stamps
  // one on the manifest; only two numbers that are both there must agree.
  const artifactPr = format.prNumberOf(artifact.data)
  const manifestPr = manifest.data.prNumber
  if (artifactPr !== null && manifestPr !== undefined && artifactPr !== manifestPr) {
    throw invalid([`${format.entry} is for #${artifactPr} while ${MANIFEST_ENTRY} says #${manifestPr}`])
  }
  const contents: ZipContents<A> = { manifest: manifest.data, artifact: artifact.data }
  const prNumber = manifestPr ?? artifactPr
  if (prNumber !== null) {
    contents.prNumber = prNumber
  }
  return contents
}

/** The canvas's zip, as the tests and the fixtures build and read it. */
export const buildCanvasZip = (manifest: CanvasManifest, artifact: ReviewArtifact) =>
  buildZip(CANVAS_ZIP, manifest, artifact)
export const readCanvasZip = (bytes: Uint8Array) => readZip(bytes, CANVAS_ZIP)
