// The same reviewed rules the page uses, so the body and the header never disagree.
import { layerProgress } from '../../static/js/progress.js'
import type { CommentsPayload } from '../contract/comments.js'
import type { Layer, Pr, ReviewArtifact } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import type { CanvasLookup } from '../store/canvas-store.js'

export const REVIEW_BODY_FOOTER = 'Reviewed with the pr-review canvas (localhost).'

/**
 * Model text on one line of a list. Markdown characters are escaped so a title cannot open a
 * heading, a link, or a code span in the published review.
 */
export function inlineText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]<>#|])/g, '\\$1')
}

/**
 * The state as it applies to one commit. Marks made on another commit, and marks whose commit
 * is unknown, describe other code, so they count for nothing here.
 */
export function stateForHead(state: PrState, headSha: string): PrState {
  return state.reviewedHeadSha === headSha ? state : { ...state, reviewed: {} }
}

/**
 * The commit the marks on this page describe: the commit of the canvas on the page, whether it is
 * current, carried over, or read as outdated, since its diff is what the reviewer looked at. The
 * head only when there is no canvas. Keyed this way, a carried-over canvas keeps its marks however
 * often the head moves, and marks made on an outdated canvas never credit a later one. The page
 * sends this commit back with every mark it makes, as `bundle.canvas.headSha`.
 */
export function reviewedCommit(found: CanvasLookup, pr: Pr): string {
  return found.status === 'missing' ? pr.headSha : found.headSha
}

/** The layers a human still has to look at. Empty means approve is allowed. */
export function unreviewedLayers(artifact: ReviewArtifact, state: PrState): Layer[] {
  return artifact.layers.filter(l => l.kind !== 'other' && layerProgress(l, state) !== 'done')
}

function section(title: string, items: string[]): string {
  return items.length === 0 ? '' : `\n\n**${title}**\n${items.map(i => `- ${i}`).join('\n')}`
}

export interface ReviewBodyInput {
  artifact: ReviewArtifact
  state: PrState
  comments: CommentsPayload
  headSha: string
}

/**
 * The body of the review the canvas posts: what was read, what was set aside, and what was said
 * on the diff. The user sees it in the dialog and may edit it before it is sent.
 */
export function buildReviewBody(input: ReviewBodyInput): string {
  const { artifact, state, comments, headSha } = input
  const layers = artifact.layers.filter(l => l.kind !== 'other')
  const reviewed = layers.filter(l => layerProgress(l, state) === 'done')
  const dismissed = artifact.points.filter(p => state.dismissed[p.fingerprint] !== undefined)
  const urls = new Map<number, string>()
  for (const c of [...comments.reviewComments, ...comments.issueComments]) {
    urls.set(c.id, c.url)
  }
  const posted = state.posted.map(p => urls.get(p.commentId) ?? `comment ${p.commentId}`)
  const head = `Reviewed ${reviewed.length} of ${layers.length} ${layers.length === 1 ? 'layer' : 'layers'} on \`${headSha.slice(0, 7)}\`.`
  return (
    head +
    section(
      'Layers reviewed',
      reviewed.map(l => inlineText(l.title))
    ) +
    section(
      'Attention points dismissed',
      dismissed.map(p => inlineText(p.title))
    ) +
    section('Comments posted from the canvas', posted) +
    `\n\n${REVIEW_BODY_FOOTER}\n`
  )
}
