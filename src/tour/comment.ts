// The tour's envelope: its zip, the canvas's format with tour.json for the artifact and the tool
// named `pr-review-tour`, and its own pull request comment, with a rendered line on what the tour
// holds and who has taken it. Apart from the canvas comment on purpose (ADR 0005).
import { ZIP_COMMENT_MARKERS, zipComment } from '../canvas/comment.js'
import type { CanvasZip } from '../canvas/export.js'
import type { ZipFormat } from '../canvas/zip.js'
import { type TourArtifact, TourArtifactSchema } from '../contract/tour.js'

export const TOUR_COMMENT_MARKER = ZIP_COMMENT_MARKERS.tour
export const TOUR_TOOL_NAME = 'pr-review-tour'

export const TOUR_ZIP: ZipFormat<TourArtifact> = {
  entry: 'tour.json',
  schema: TourArtifactSchema,
  noun: 'a tour',
  headShaOf: artifact => artifact.headSha,
  prNumberOf: artifact => artifact.pr.number,
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

export function buildTourComment(zip: CanvasZip, artifact: TourArtifact, limit: number): string {
  return zipComment(
    `PR Review Tour for commit ${zip.headSha}.\n\n${tourCommentSummary(artifact)}\n\nRun \`pr-review serve\` and open /tour/${zip.prNumber ?? ''}.`,
    TOUR_COMMENT_MARKER,
    zip,
    limit
  )
}
