// The refusals a write and a review go through, in the local app's routes and in the static
// viewer alike, so the two never disagree on what they refuse or how they word it.
import type { ReviewEvent } from '../contract/reviews.js'
import type { Pr, ReviewArtifact } from '../contract/review-artifact.js'
import type { PrState } from '../contract/state.js'
import { AppError } from '../server/app-error.js'
import type { DiffedCommit } from '../store/derived-store.js'
import { unreviewedLayers } from './review-body.js'
import { authorSignOffReason } from './self-review.js'

/** Refuses a write from a page drawn on another head or base than the pull request has now. */
export function requireSameDiff(
  page: { headSha?: string | undefined; mergeBaseSha?: string | undefined },
  current: DiffedCommit
): void {
  const moved = (seen: string | undefined, now: string) => seen !== undefined && seen !== now
  if (moved(page.headSha, current.headSha) || moved(page.mergeBaseSha, current.mergeBaseSha)) {
    throw new AppError(
      'CANVAS_STALE',
      'the pull request has a new head commit or base since this page was drawn',
      409,
      'reload the page and try again'
    )
  }
}

/** A review signs off on a canvas that describes the head; any other is refused with this. */
export function signOffOnStaleCanvas(): AppError {
  return new AppError(
    'SIGNOFF_INCOMPLETE',
    'the canvas on screen was generated for another commit or another base',
    409,
    'regenerate the canvas for the current head, then review its layers'
  )
}

/**
 * Refuses an approval or a request for changes from the pull request's author, even when the forge
 * allows it. A comment-only review goes through. When the login is unknown, the forge decides.
 */
export function refuseAuthorSignOff(
  login: string | null,
  pr: Pick<Pr, 'author'>,
  noun: string,
  event: ReviewEvent
): void {
  if (event === 'COMMENT') return
  const reason = authorSignOffReason(login, pr, noun)
  if (reason !== null) {
    throw new AppError(
      'SIGNOFF_BY_AUTHOR',
      reason,
      403,
      'ask another reviewer to sign off, or post a comment-only review'
    )
  }
}

/** Refuses an approval while a layer of the canvas is not marked reviewed. */
export function requireLayersReviewed(artifact: ReviewArtifact, state: PrState, event: ReviewEvent): void {
  if (event !== 'APPROVE') return
  const missing = unreviewedLayers(artifact, state)
  if (missing.length > 0) {
    throw new AppError(
      'SIGNOFF_INCOMPLETE',
      `${missing.length} ${missing.length === 1 ? 'layer is' : 'layers are'} not reviewed yet`,
      409,
      missing.map(l => l.title).join(', ')
    )
  }
}
