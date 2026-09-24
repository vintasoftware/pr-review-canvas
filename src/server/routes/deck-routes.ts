// The self-review deck's API: the deck with its picks and the code each card is anchored to, one
// route per pick, and the finish route that writes the fix list.
import { Hono } from 'hono'
import {
  type Deck,
  type DecisionCard,
  type Pick,
  type PickBody,
  PickBodySchema,
} from '../../contract/deck.js'
import { keyLabel, parseReviewKey, type ReviewKey } from '../../contract/review-key.js'
import { renderFixList, summarizePicks, type FixListSummary } from '../../deck/fix-list.js'
import { hunkForLine, splitHunks } from '../../git/patch-lines.js'
import type { Derived } from '../../store/derived-store.js'
import type { AppContext } from '../context.js'
import { AppError } from '../errors.js'

/** The chunk of the diff a card is anchored to, for the drawer. */
export interface CardExcerpt {
  path: string
  header: string
  /** Body lines with their leading marker (`+`, `-`, ` `). */
  lines: string[]
  oldStart: number
  newStart: number
  lang?: string
}

export interface DeckResponse {
  deck: Deck
  picks: Record<string, Pick>
  excerpts: Record<string, CardExcerpt>
  summary: FixListSummary
  /** The fix list as last written, when the author has finished the deck. */
  fixes: { path: string; markdown: string } | null
}

function parseKey(raw: string): ReviewKey {
  const key = parseReviewKey(raw)
  if (key === null) {
    throw new AppError(
      'BAD_REQUEST',
      `"${raw}" is not a review target`,
      400,
      'use a PR number, branch, or uncommitted'
    )
  }
  return key
}

async function requireDeck(ctx: AppContext, key: ReviewKey): Promise<Deck> {
  const deck = await ctx.decks.readDeck(key)
  if (deck === null) {
    throw new AppError(
      'DECK_NOT_FOUND',
      `${keyLabel(key)} has no self-review deck`,
      404,
      `run /pr-self-review ${key} to generate one`
    )
  }
  return deck
}

function excerptFor(card: DecisionCard, derived: Derived | null): CardExcerpt | null {
  const file = derived?.files.find(f => f.path === card.path)
  const patch = file === undefined ? undefined : derived?.patches[file.key]
  if (file === undefined || patch === undefined) {
    return null
  }
  const side = card.side ?? 'new'
  const hunk = hunkForLine(splitHunks(patch), side, card.line)
  if (hunk === null) {
    return null
  }
  const excerpt: CardExcerpt = {
    path: card.path,
    header: hunk.header,
    lines: hunk.lines.filter(l => !l.startsWith('\\')),
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
  }
  if (file.lang !== undefined) {
    excerpt.lang = file.lang
  }
  return excerpt
}

async function deckResponse(ctx: AppContext, key: ReviewKey, deck: Deck): Promise<DeckResponse> {
  const [{ picks }, derived, fixesText] = await Promise.all([
    ctx.decks.readPicks(key),
    ctx.derived.readOrBuild(deck.headSha, deck.mergeBaseSha),
    ctx.decks.readFixes(key),
  ])
  const excerpts: Record<string, CardExcerpt> = {}
  for (const card of deck.cards) {
    const excerpt = excerptFor(card, derived)
    if (excerpt !== null) {
      excerpts[card.key] = excerpt
    }
  }
  return {
    deck,
    picks,
    excerpts,
    summary: summarizePicks(deck, picks),
    fixes: fixesText === null ? null : { path: ctx.decks.fixesPath(key), markdown: fixesText },
  }
}

async function readPickBody(request: Request): Promise<PickBody> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    throw new AppError('BAD_REQUEST', 'send a JSON body: { headSha, choice, why?, note?, record? }', 400)
  }
  const parsed = PickBodySchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError(
      'BAD_REQUEST',
      'send a JSON body: { headSha, choice, why?, note?, record? }',
      400,
      parsed.error.issues[0]?.message
    )
  }
  return parsed.data
}

/** Picks are made on the deck the page shows; a regenerated deck asks its questions anew. */
function requireSameDeck(deck: Deck, headSha: string | undefined): void {
  if (headSha !== deck.headSha) {
    throw new AppError(
      'DECK_STALE',
      'the deck was regenerated since this page was drawn',
      409,
      'reload the page and pick again'
    )
  }
}

export function deckRoutes(ctx: AppContext): Hono {
  const app = new Hono()

  app.get('/:key', async c => {
    const key = parseKey(c.req.param('key'))
    return c.json(await deckResponse(ctx, key, await requireDeck(ctx, key)))
  })

  app.put('/:key/picks/:card', async c => {
    const key = parseKey(c.req.param('key'))
    const deck = await requireDeck(ctx, key)
    const body = await readPickBody(c.req.raw)
    requireSameDeck(deck, body.headSha)
    const card = deck.cards.find(k => k.key === c.req.param('card'))
    if (card === undefined) {
      throw new AppError('NOT_FOUND', `the deck has no card "${c.req.param('card')}"`, 404)
    }
    if (body.choice === 'neither' && (body.note ?? '').trim() === '') {
      throw new AppError('BAD_REQUEST', 'say what you want instead when neither side fits', 400)
    }
    const pick: Pick = { choice: body.choice, pickedAt: ctx.now().toISOString() }
    if (body.why !== undefined) pick.why = body.why
    if (body.note !== undefined) pick.note = body.note
    if (body.record !== undefined) pick.record = body.record
    const { picks } = await ctx.decks.setPick(key, card.key, pick)
    return c.json({ picks, summary: summarizePicks(deck, picks) })
  })

  app.delete('/:key/picks/:card', async c => {
    const key = parseKey(c.req.param('key'))
    const deck = await requireDeck(ctx, key)
    requireSameDeck(deck, c.req.query('headSha'))
    const { picks } = await ctx.decks.clearPick(key, c.req.param('card'))
    return c.json({ picks, summary: summarizePicks(deck, picks) })
  })

  app.post('/:key/finish', async c => {
    const key = parseKey(c.req.param('key'))
    const deck = await requireDeck(ctx, key)
    requireSameDeck(deck, c.req.query('headSha'))
    const { picks } = await ctx.decks.readPicks(key)
    const markdown = renderFixList(deck, picks)
    const file = await ctx.decks.writeFixes(key, markdown)
    return c.json({ path: file, markdown, summary: summarizePicks(deck, picks) })
  })

  return app
}
