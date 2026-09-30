// The tour's own pull request comment: a zip of the tour in a hidden block, and a rendered line
// on what it holds and who has taken it. Apart from the canvas comment on purpose (ADR 0005).
import type { TourArtifact } from '../contract/tour.js'

export const TOUR_COMMENT_MARKER = '<!-- pr-review-tour:v1\n'

export interface TourZip {
  name: string
  bytes: Uint8Array<ArrayBuffer>
  headSha: string
  prNumber?: number
}

/** The visible lines: the tour's shape, and the shared record of who took it. */
export function tourCommentSummary(artifact: TourArtifact): string {
  const lines = [
    `**Tour:** ${artifact.landmarks.length} landmarks, ${artifact.decisions.length} decisions, ${artifact.quiz.length} quiz questions.`,
  ]
  if (artifact.blastRadius.length > 0) lines.push(`**Touches:** ${artifact.blastRadius.join(', ')}.`)
  const toured = artifact.record.touredBy
  lines.push(
    toured.length === 0
      ? '**Toured by:** nobody yet.'
      : `**Toured by:** ${toured.map(t => `${t.login} (${t.at.slice(0, 10)})`).join(', ')}.`
  )
  return lines.join('\n')
}

export function buildTourComment(zip: TourZip, artifact: TourArtifact, limit: number): string {
  const body = `PR Review Tour for commit ${zip.headSha}.\n\n${tourCommentSummary(artifact)}\n\nRun \`pr-review serve\` and open /tour/${zip.prNumber ?? ''}.\n\n${TOUR_COMMENT_MARKER}${zip.name}\n${Buffer.from(zip.bytes).toString('base64')}\n-->`
  if (body.length > limit) {
    throw new Error(`the compressed tour comment needs ${body.length} characters; the host limit is ${limit}`)
  }
  return body
}

/** Only the versioned envelope is decoded. ZIP contents are checked by the tour importer. */
export function readTourComment(body: string): { name: string; bytes: Uint8Array } | null {
  const match = /<!-- pr-review-tour:v1\n([A-Za-z0-9._-]+\.zip)\n([A-Za-z0-9+/]+={0,2})\n-->/.exec(body)
  if (match === null) return null
  const name = match[1]!
  const encoded = match[2]!
  if (encoded.length > 1_000_000 || encoded.length % 4 !== 0) return null
  return { name, bytes: Buffer.from(encoded, 'base64') }
}
