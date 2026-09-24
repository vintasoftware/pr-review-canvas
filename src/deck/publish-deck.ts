// `pr-review deck validate` and `pr-review deck publish`: check the generated deck-model.json
// against the context `deck prepare` wrote, and publish it as the review's deck.
import path from 'node:path'
import { type Deck, type DeckContext, DeckContextSchema } from '../contract/deck.js'
import type { LocalKey } from '../contract/review-key.js'
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

export async function readDeckContext(ctx: AppContext, review: LocalKey): Promise<DeckContext> {
  const file = path.join(ctx.decks.workDir(review), 'context.json')
  const context = await readJson(file, DeckContextSchema)
  if (context === null) {
    throw new AppError(
      'DECK_NOT_FOUND',
      `no prepared deck for the ${review} review`,
      404,
      `run \`pr-review deck prepare --${review}\` first`
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

export interface PublishDeckResult {
  status: 'published'
  review: LocalKey
  headSha: string
  cards: number
  settled: number
  deckUrl: string
}

export async function publishDeck(
  ctx: AppContext,
  review: LocalKey,
  opts: { agent: string; model?: string | undefined; allowStale: boolean }
): Promise<PublishDeckResult> {
  const context = await readDeckContext(ctx, review)
  const checked = await checkDeckModel(context)
  if (!checked.ok) {
    throw new DeckInvalidError(checked.problems)
  }
  const head = await resolveLocalHead(ctx.git, review)
  if (head.headSha !== context.headSha && !opts.allowStale) {
    throw new AppError(
      'DECK_STALE',
      `the ${review} head moved to ${head.headSha.slice(0, 12)} while the deck was written for ${context.headSha.slice(0, 12)}`,
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
    cards: checked.cards,
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
