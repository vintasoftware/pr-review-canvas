import { type CanvasTally, tallyMarkdown } from '../review/self-review.js'
import type { CanvasZip } from './export.js'
import type { ZipKind } from './name.js'

/** What opens the hidden block a comment carries a zip in, by what the zip holds. */
export const ZIP_COMMENT_MARKERS: Record<ZipKind, string> = {
  canvas: '<!-- pr-review-canvas:v1\n',
  tour: '<!-- pr-review-tour:v1\n',
}
export const CANVAS_COMMENT_MARKER = ZIP_COMMENT_MARKERS.canvas

/**
 * A pull request comment carrying a zip: the rendered lines, then the zip as base64 in a hidden
 * block opened by `marker`. Refused when the host would refuse it, before anything is posted.
 */
export function zipComment(
  lines: string,
  marker: string,
  zip: Pick<CanvasZip, 'name' | 'bytes'>,
  limit: number
): string {
  const body = `${lines}\n\n${marker}${zip.name}\n${Buffer.from(zip.bytes).toString('base64')}\n-->`
  if (body.length > limit) {
    throw new Error(`the compressed comment needs ${body.length} characters; the host limit is ${limit}`)
  }
  return body
}

/** Only the versioned envelope is decoded. The zip's contents are checked by the importer. */
export function readZipEnvelope(marker: string, body: string): { name: string; bytes: Uint8Array } | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}([A-Za-z0-9._-]+\\.zip)\\n([A-Za-z0-9+/]+={0,2})\\n-->`).exec(body)
  if (match === null) return null
  const name = match[1]!
  const encoded = match[2]!
  if (encoded.length > 1_000_000 || encoded.length % 4 !== 0) return null
  return { name, bytes: Buffer.from(encoded, 'base64') }
}

/**
 * The ZIP stays in the raw comment body; the rendered comment says what the canvas leaves open for
 * the reviewer, what the author settled, and how to open it.
 */
export function buildCanvasComment(zip: CanvasZip, tally: CanvasTally, limit: number): string {
  return zipComment(
    `PR Review Canvas for commit ${zip.headSha}.\n\n${tallyMarkdown(tally)}\n\nRun \`pr-review serve\` and open #${zip.prNumber}. If already reviewing, click **refresh**.`,
    CANVAS_COMMENT_MARKER,
    zip,
    limit
  )
}
