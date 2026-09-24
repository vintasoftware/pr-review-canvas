// Posts the justifications the author kept for reviewers, from the self-review decks, as the
// author's own review on the pull request: one COMMENT review, each justification inline on the
// code it concerns. A decision whose code changed since the card was dealt is listed in the review
// body instead of landing on a line it no longer describes.
import type { SettledCard } from '../contract/deck.js'
import type { PendingComment } from '../contract/pending.js'
import type { Pr } from '../contract/review-artifact.js'
import type { AppContext } from '../server/context.js'
import { anchorOnHead, decisionsForPr, pickedLabel, recordOf, sentence, whyOf } from './settled-for-pr.js'

export type SelfReviewSharing =
  /** No settled decision is waiting to be posted. */
  | { status: 'none' }
  | { status: 'posted'; url: string; comments: number; listed: number }
  | { status: 'failed'; warning: string }
  | { status: 'skipped' }

/** Marks a comment as the tool's, so a reader, or a later tool, can tell where it came from. */
function marker(card: SettledCard): string {
  return `<!-- pr-review:self-review card=${card.key} -->`
}

/** `Picked A, Keep it. Because …`: the side, then the author's reason when there is one. */
function pickedSentence(card: SettledCard): string {
  const why = whyOf(card)
  return `${sentence(pickedLabel(card))}${why === '' ? '' : ` ${why}`}`
}

function commentBody(card: SettledCard): string {
  return [`**Self-review: ${card.title}**`, '', `Picked ${pickedSentence(card)}`, '', marker(card)].join('\n')
}

function listedLine(card: SettledCard): string {
  return `- **${card.title}** (\`${card.path}\`): picked ${pickedSentence(card)}`
}

export async function postSettledComments(
  ctx: AppContext,
  pr: Pr & { number: number }
): Promise<SelfReviewSharing> {
  const { settled } = await decisionsForPr(ctx, pr)
  const { posted } = await ctx.decks.readPosted(pr.number)
  const waiting = settled.filter(
    card => recordOf(card) === 'pr-comment' && posted[card.key]?.pickedAt !== card.pick.pickedAt
  )
  if (waiting.length === 0) {
    return { status: 'none' }
  }
  try {
    const derived = await ctx.derived.ensure(pr.headSha, pr.mergeBaseSha)
    const now = ctx.now().toISOString()
    const comments: PendingComment[] = []
    const listed: SettledCard[] = []
    for (const card of waiting) {
      const anchor = await anchorOnHead(ctx, card, { sha: pr.headSha, derived })
      if (anchor === null) {
        listed.push(card)
        continue
      }
      comments.push({
        id: `self-review-${card.key}`,
        ...anchor,
        body: commentBody(card),
        headSha: pr.headSha,
        createdAt: now,
        updatedAt: now,
      })
    }
    const body = [
      'Decisions I settled in a self-review before asking for review, and why.',
      ...(listed.length === 0
        ? []
        : [
            '',
            'The code under these changed since, so they are not on a line:',
            '',
            ...listed.map(listedLine),
          ]),
    ].join('\n')
    const review = await ctx.config.host.postReview(
      ctx.gh,
      ctx.config.repo,
      pr.number,
      pr.headSha,
      { event: 'COMMENT', body, comments },
      derived
    )
    const next = { ...posted }
    for (const card of waiting) {
      next[card.key] = { pickedAt: card.pick.pickedAt, url: review.url }
    }
    await ctx.decks.writePosted(pr.number, { posted: next })
    return { status: 'posted', url: review.url, comments: comments.length, listed: listed.length }
  } catch (err) {
    return {
      status: 'failed',
      warning: `The canvas is published, but the self-review justifications were not posted: ${err instanceof Error ? err.message : String(err)}. Publishing again retries them.`,
    }
  }
}
