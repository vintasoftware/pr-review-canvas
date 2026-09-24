import { rm } from 'node:fs/promises'
import path from 'node:path'
import { type Deck, DeckSchema, type Pick, type Picks, PicksSchema } from '../contract/deck.js'
import type { LocalKey } from '../contract/review-key.js'
import { readJson, readJsonOrDefault, readText, writeJsonAtomic, writeTextAtomic } from './atomic-json.js'

/**
 * The self-review deck of each local review, under `decks/<branch|uncommitted>/`:
 *
 * - `deck.json`, the published deck;
 * - `picks.json`, the author's answers to its cards;
 * - `fixes.md`, the fix list written when the author finishes the deck;
 * - `work/`, where `deck prepare` leaves the prompt and the generator writes `deck-model.json`.
 */
export interface DeckStore {
  deckDir(key: LocalKey): string
  workDir(key: LocalKey): string
  fixesPath(key: LocalKey): string
  readDeck(key: LocalKey): Promise<Deck | null>
  /**
   * Publishes a deck and starts its picks afresh. The decisions settled in the deck it replaces
   * travel inside it, as `settled`; a card asked again is a new question.
   */
  writeDeck(key: LocalKey, deck: Deck): Promise<void>
  readPicks(key: LocalKey): Promise<Picks>
  setPick(key: LocalKey, card: string, pick: Pick): Promise<Picks>
  clearPick(key: LocalKey, card: string): Promise<Picks>
  writeFixes(key: LocalKey, markdown: string): Promise<string>
  readFixes(key: LocalKey): Promise<string | null>
  /** Empties `work/` for a fresh generation. */
  clearWork(key: LocalKey): Promise<void>
}

export function createDeckStore(repoRoot: string): DeckStore {
  const deckDir = (key: LocalKey): string => path.join(repoRoot, 'decks', key)
  const picksFile = (key: LocalKey): string => path.join(deckDir(key), 'picks.json')
  const fixesPath = (key: LocalKey): string => path.join(deckDir(key), 'fixes.md')
  const readPicks = (key: LocalKey): Promise<Picks> =>
    readJsonOrDefault(picksFile(key), PicksSchema, () => ({ picks: {} }))
  const writePicks = async (key: LocalKey, picks: Picks): Promise<Picks> => {
    await writeJsonAtomic(picksFile(key), picks)
    return picks
  }
  return {
    deckDir,
    workDir: key => path.join(deckDir(key), 'work'),
    fixesPath,
    readDeck: key => readJson(path.join(deckDir(key), 'deck.json'), DeckSchema),
    writeDeck: async (key, deck) => {
      await writeJsonAtomic(path.join(deckDir(key), 'deck.json'), deck)
      await writePicks(key, { picks: {} })
    },
    readPicks,
    setPick: async (key, card, pick) => {
      const { picks } = await readPicks(key)
      return writePicks(key, { picks: { ...picks, [card]: pick } })
    },
    clearPick: async (key, card) => {
      const { picks } = await readPicks(key)
      const { [card]: _dropped, ...rest } = picks
      return writePicks(key, { picks: rest })
    },
    writeFixes: async (key, markdown) => {
      await writeTextAtomic(fixesPath(key), markdown)
      return fixesPath(key)
    },
    readFixes: key => readText(fixesPath(key)),
    clearWork: key => rm(path.join(deckDir(key), 'work'), { recursive: true, force: true }),
  }
}
