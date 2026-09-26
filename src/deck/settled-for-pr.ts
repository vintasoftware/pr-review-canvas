// What the self-review decks of a pull request's author hand to the pull request: the decisions
// settled on it, which the canvas does not ask again and whose justifications become the author's
// own comments, and the cards skipped for reviewers. A pull request collects its own deck and the
// local decks of the branch it was opened from, since the author often settles them before it exists.
import type { Deck, DecisionCard, Pick, RecordTarget, SettledCard } from '../contract/deck.js'
import { LOCAL_KEYS } from '../contract/review-key.js'
import type { Pr, Side } from '../contract/review-artifact.js'
import { hunkForLine } from '../git/patch-lines.js'
import { lineInHead } from '../review/point-carry.js'
import type { AppContext } from '../server/context.js'
import type { Derived } from '../store/derived-store.js'

/**
 * The decisions a new deck carries: those settled before the previous deck, and the previous
 * deck's cards the author answered with a side or with a note. A skipped card is not settled; the
 * generator may ask it again.
 */
export function settledFrom(
  previous: Deck | null,
  picks: Readonly<Record<string, SettledCard['pick']>>
): SettledCard[] {
  if (previous === null) {
    return []
  }
  const answered = previous.cards.flatMap(card => {
    const pick = picks[card.key]
    return pick === undefined || pick.choice === 'skip' ? [] : [{ ...card, pick, headSha: previous.headSha }]
  })
  const keys = new Set(answered.map(c => c.key))
  return [...previous.settled.filter(c => !keys.has(c.key)), ...answered]
}

export interface PrDecisions {
  /** Newest first per key; a decision settled in several decks counts once. */
  settled: SettledCard[]
  /** Cards skipped or never answered, which the author left for reviewers. */
  open: Array<DecisionCard & { headSha: string }>
}

/**
 * The decks that speak for this pull request: its own, then the local decks whose branch is the
 * pull request's head branch, newest first. A local deck of another branch says nothing about it.
 */
async function decksFor(
  ctx: AppContext,
  pr: Pr & { number: number }
): Promise<Array<{ deck: Deck; picks: Record<string, Pick> }>> {
  const own = await ctx.decks.readDeck(pr.number)
  const local = (await Promise.all(LOCAL_KEYS.map(key => ctx.decks.readDeck(key)))).filter(
    (deck): deck is Deck => deck !== null && deck.headRef === pr.headRef
  )
  // ISO timestamps sort as text: newest first.
  local.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
  const decks = own === null ? local : [own, ...local]
  return Promise.all(
    decks.map(async deck => ({ deck, picks: (await ctx.decks.readPicks(deck.review)).picks }))
  )
}

export async function decisionsForPr(ctx: AppContext, pr: Pr & { number: number }): Promise<PrDecisions> {
  const settled = new Map<string, SettledCard>()
  const open = new Map<string, DecisionCard & { headSha: string }>()
  for (const { deck, picks } of await decksFor(ctx, pr)) {
    for (const card of settledFrom(deck, picks)) {
      if (!settled.has(card.key)) settled.set(card.key, card)
    }
    for (const card of deck.cards) {
      const pick = picks[card.key]
      if ((pick === undefined || pick.choice === 'skip') && !open.has(card.key)) {
        open.set(card.key, { ...card, headSha: deck.headSha })
      }
    }
  }
  for (const key of settled.keys()) open.delete(key)
  return { settled: [...settled.values()], open: [...open.values()] }
}

/**
 * Where a pick's justification goes: where the author moved it, else where the picked side says.
 * Neither side and a skip say nowhere.
 */
export function recordFor(card: DecisionCard, pick: Pick): RecordTarget {
  if (pick.record !== undefined) return pick.record
  return pick.choice === 'a' || pick.choice === 'b' ? card[pick.choice].record : 'none'
}

/** The side the author picked, in words a reviewer reads. */
export function pickedLabelFor(card: DecisionCard, pick: Pick): string {
  if (pick.choice === 'neither') return `neither side; instead: ${pick.note ?? ''}`.trim()
  if (pick.choice === 'skip') return 'skipped'
  return `${pick.choice.toUpperCase()}, ${card[pick.choice].label}`
}

/** The justification the author wrote, else the one the picked side offered. */
export function whyFor(card: DecisionCard, pick: Pick): string {
  if (pick.why !== undefined) return pick.why
  return pick.choice === 'a' || pick.choice === 'b' ? card[pick.choice].why : ''
}

/** Ends `text` with one full stop, whatever the author typed. */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export const recordOf = (card: SettledCard): RecordTarget => recordFor(card, card.pick)
export const pickedLabel = (card: SettledCard): string => pickedLabelFor(card, card.pick)
export const whyOf = (card: SettledCard): string => whyFor(card, card.pick)

/**
 * Where a card's anchor sits on the pull request's head: the same line when the card was dealt for
 * this head, else the line it moved to when its code is unchanged. Null when the code under it
 * changed or the file is no longer in the diff; the caller says so instead of guessing a line.
 */
export async function anchorOnHead(
  ctx: AppContext,
  card: { path: string; line: number; side?: Side | undefined; headSha: string },
  head: { sha: string; derived: Derived }
): Promise<{ path: string; line: number; side: Side } | null> {
  const side = card.side ?? 'new'
  const file = head.derived.files.find(f => f.path === card.path)
  if (file === undefined) return null
  if (card.headSha === head.sha) {
    return hunkForLine(file.hunks, side, card.line) === null
      ? null
      : { path: card.path, line: card.line, side }
  }
  const basis = await ctx.derived.read(card.headSha)
  if (basis === null) return null
  const line = await lineInHead(
    ctx.derived,
    { path: card.path, side, line: card.line },
    { sha: card.headSha, derived: basis },
    head
  )
  return line === null ? null : { path: card.path, line, side }
}
