import { tallyCanvas, tallyMarkdown } from '../review/self-review.js'
import type { CanvasZip } from './export.js'

export const CANVAS_COMMENT_MARKER = '<!-- pr-review-canvas:v1\n'

/**
 * The ZIP stays in the raw comment body; the rendered comment says what the canvas leaves open for
 * the reviewer, what the author settled, and how to open it.
 */
export function buildCanvasComment(zip: CanvasZip, limit: number): string {
  const tally = tallyMarkdown(tallyCanvas(zip.artifact))
  const body = `PR Review Canvas for commit ${zip.headSha}.\n\n${tally}\n\nRun \`pr-review serve\` and open #${zip.prNumber}. If already reviewing, click **refresh**.\n\n${CANVAS_COMMENT_MARKER}${zip.name}\n${Buffer.from(zip.bytes).toString('base64')}\n-->`
  if (body.length > limit) {
    throw new Error(
      `the compressed canvas comment needs ${body.length} characters; the host limit is ${limit}`
    )
  }
  return body
}

/** Only the versioned envelope is decoded. ZIP contents are checked by the normal importer. */
export function readCanvasComment(body: string): { name: string; bytes: Uint8Array } | null {
  const match = /<!-- pr-review-canvas:v1\n([A-Za-z0-9._-]+\.zip)\n([A-Za-z0-9+/]+={0,2})\n-->/.exec(body)
  if (match === null) return null
  const name = match[1]!
  const encoded = match[2]!
  if (encoded.length > 1_000_000 || encoded.length % 4 !== 0) return null
  return { name, bytes: Buffer.from(encoded, 'base64') }
}
