// `pr-review deck validate` and `pr-review deck publish`: check the generated deck-model.json
// against the context `deck prepare` wrote, and publish it as the review's deck.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { type Deck, type DeckContext, DeckContextSchema, type DecisionCard } from '../contract/deck.js'
import { isLocalKey, keyLabel, type ReviewKey } from '../contract/review-key.js'
import { resolveLocalHead } from '../git/local-target.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { readJson, readText } from '../store/atomic-json.js'
import { type DeckProblem, validateDeckModel } from './validate-deck.js'

export class DeckInvalidError extends Error {
  readonly problems: DeckProblem[]

  constructor(problems: DeckProblem[]) {
    super(`deck-model.json has ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    this.name = 'DeckInvalidError'
    this.problems = problems
  }
}

export async function readDeckContext(ctx: AppContext, review: ReviewKey): Promise<DeckContext> {
  const file = path.join(ctx.decks.workDir(review), 'context.json')
  const context = await readJson(file, DeckContextSchema)
  if (context === null) {
    throw new AppError(
      'DECK_NOT_FOUND',
      `no prepared deck for ${keyLabel(review)}`,
      404,
      `run \`pr-review deck prepare ${isLocalKey(review) ? `--${review}` : `--pr ${review}`}\` first`
    )
  }
  return context
}

/** The deck's cards once they pass, or the problems that stop them. */
export async function checkDeckModel(
  context: DeckContext
): Promise<{ ok: true; cards: Deck['cards'] } | { ok: false; problems: DeckProblem[] }> {
  const text = await readText(context.modelPath)
  if (text === null) {
    throw new AppError(
      'DECK_NOT_FOUND',
      `${context.modelPath} does not exist`,
      404,
      'write the deck there first'
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      problems: [{ code: 'DECK_SCHEMA', where: '(root)', message: `not valid JSON: ${reason}` }],
    }
  }
  const result = validateDeckModel(raw, { files: context.files, maxCards: context.maxCards })
  return result.ok ? { ok: true, cards: result.model.cards } : result
}

/**
 * Swaps sides A and B on about half the cards, chosen by the card's key. Generators put the code
 * as it is on side A almost every time, which would make "keep it" always the left swipe; the
 * author should read both sides, not learn a direction. The key decides, so a card asked again
 * keeps its layout.
 */
export function shuffleSides(card: DecisionCard): DecisionCard {
  const swap = (createHash('sha256').update(card.key).digest()[0] ?? 0) % 2 === 1
  if (!swap) return card
  const current = card.current === null ? null : card.current === 'a' ? 'b' : 'a'
  return { ...card, a: card.b, b: card.a, current }
}

/** Where the target's head is now: the forge's answer for a pull request, the clone's otherwise. */
async function currentHead(ctx: AppContext, review: ReviewKey): Promise<string> {
  if (isLocalKey(review)) {
    return (await resolveLocalHead(ctx.git, review)).headSha
  }
  return (await ctx.config.host.fetchPrMeta(ctx.gh, ctx.config.repo, review)).headSha
}

export interface PublishDeckResult {
  status: 'published'
  review: ReviewKey
  headSha: string
  cards: number
  settled: number
  deckUrl: string
}

export async function publishDeck(
  ctx: AppContext,
  review: ReviewKey,
  opts: { agent: string; model?: string | undefined; allowStale: boolean }
): Promise<PublishDeckResult> {
  const context = await readDeckContext(ctx, review)
  const checked = await checkDeckModel(context)
  if (!checked.ok) {
    throw new DeckInvalidError(checked.problems)
  }
  const headSha = await currentHead(ctx, review)
  if (headSha !== context.headSha && !opts.allowStale) {
    throw new AppError(
      'DECK_STALE',
      `the head of ${keyLabel(review)} moved to ${headSha.slice(0, 12)} while the deck was written for ${context.headSha.slice(0, 12)}`,
      409,
      'prepare the deck again, or pass --allow-stale to publish it for the old head'
    )
  }
  // A settled decision asked again means the code still contradicts it: the new card replaces it.
  const asked = new Set(checked.cards.map(c => c.key))
  const deck: Deck = {
    version: 1,
    review,
    headSha: context.headSha,
    mergeBaseSha: context.mergeBaseSha,
    baseRef: context.base,
    headRef: context.headRef,
    generatedAt: ctx.now().toISOString(),
    generator: opts.model === undefined ? { agent: opts.agent } : { agent: opts.agent, model: opts.model },
    cards: checked.cards.map(shuffleSides),
    settled: context.settled.filter(c => !asked.has(c.key)),
  }
  await ctx.decks.writeDeck(review, deck)
  return {
    status: 'published',
    review,
    headSha: deck.headSha,
    cards: deck.cards.length,
    settled: deck.settled.length,
    deckUrl: `http://localhost:${ctx.config.port}/deck/${review}`,
  }
}
