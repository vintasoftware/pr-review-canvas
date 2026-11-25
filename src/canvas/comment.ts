import type { Repo } from '../contract/review-artifact.js'
import { type CanvasTally, tallyMarkdown } from '../review/self-review.js'
import type { CanvasZip } from './export.js'

export const CANVAS_COMMENT_MARKER = '<!-- pr-review-canvas:v1\n'

/** The static viewer's page for one pull request: the project's viewer address, `?pr=` added. */
export function viewerPrUrl(viewer: string, repo: Repo, number: number): string {
  const url = new URL(viewer)
  url.searchParams.set('pr', `${repo.owner}/${repo.name}/${number}`)
  // The parameter reads as the path it names; URLSearchParams would escape its slashes.
  return url.href.replace(/([?&]pr=)[^&#]*/, `$1${repo.owner}/${repo.name}/${number}`)
}

/** How the comment says to open the canvas: the viewer first when the project has one. */
function openLine(zip: CanvasZip, viewerUrl: string | undefined): string {
  const local = `\`pr-review serve\` and open #${zip.prNumber}. If already reviewing, click **refresh**.`
  return viewerUrl === undefined
    ? `Run ${local}`
    : `[Open the canvas in the viewer](${viewerUrl}), nothing to install. Or run ${local}`
}

/**
 * The ZIP stays in the raw comment body; the rendered comment says what the canvas leaves open for
 * the reviewer, what the author settled, and how to open it. `viewerUrl` is the static viewer's page
 * for this pull request, when the project links one (`sharing.viewerLink`).
 */
export function buildCanvasComment(
  zip: CanvasZip,
  tally: CanvasTally,
  limit: number,
  viewerUrl?: string
): string {
  const body = `PR Review Canvas for commit ${zip.headSha}.\n\n${tallyMarkdown(tally)}\n\n${openLine(zip, viewerUrl)}\n\n${CANVAS_COMMENT_MARKER}${zip.name}\n${Buffer.from(zip.bytes).toString('base64')}\n-->`
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
  return { name, bytes: Uint8Array.from(atob(encoded), c => c.charCodeAt(0)) }
}
