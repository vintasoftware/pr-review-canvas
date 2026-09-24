import { rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type Deck,
  DeckSchema,
  type Pick,
  type Picks,
  PicksSchema,
  type Posted,
  PostedSchema,
} from '../contract/deck.js'
import { keyToString, type ReviewKey } from '../contract/review-key.js'
import { readJson, readJsonOrDefault, readText, writeJsonAtomic, writeTextAtomic } from './atomic-json.js'

/**
 * The self-review deck of each review target, under `decks/<branch|uncommitted|number>/`:
 *
 * - `deck.json`, the published deck;
 * - `picks.json`, the author's answers to its cards;
 * - `fixes.md`, the fix list written when the author finishes the deck;
 * - `work/`, where `deck prepare` leaves the prompt and the generator writes `deck-model.json`;
 * - `posted.json`, for a pull request, the settled decisions already posted on it.
 */
export interface DeckStore {
  deckDir(key: ReviewKey): string
  workDir(key: ReviewKey): string
  fixesPath(key: ReviewKey): string
  readDeck(key: ReviewKey): Promise<Deck | null>
  /**
   * Publishes a deck and starts its picks afresh. The decisions settled in the deck it replaces
   * travel inside it, as `settled`; a card asked again is a new question.
   */
  writeDeck(key: ReviewKey, deck: Deck): Promise<void>
  readPicks(key: ReviewKey): Promise<Picks>
  setPick(key: ReviewKey, card: string, pick: Pick): Promise<Picks>
  clearPick(key: ReviewKey, card: string): Promise<Picks>
  writeFixes(key: ReviewKey, markdown: string): Promise<string>
  readFixes(key: ReviewKey): Promise<string | null>
  /** Empties `work/` for a fresh generation. */
  clearWork(key: ReviewKey): Promise<void>
  /** The settled decisions already posted on pull request `number`. */
  readPosted(number: number): Promise<Posted>
  writePosted(number: number, posted: Posted): Promise<void>
}

export function createDeckStore(repoRoot: string): DeckStore {
  const deckDir = (key: ReviewKey): string => path.join(repoRoot, 'decks', keyToString(key))
  const picksFile = (key: ReviewKey): string => path.join(deckDir(key), 'picks.json')
  const fixesPath = (key: ReviewKey): string => path.join(deckDir(key), 'fixes.md')
  const readPicks = (key: ReviewKey): Promise<Picks> =>
    readJsonOrDefault(picksFile(key), PicksSchema, () => ({ picks: {} }))
  const writePicks = async (key: ReviewKey, picks: Picks): Promise<Picks> => {
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
    readPosted: number =>
      readJsonOrDefault(path.join(deckDir(number), 'posted.json'), PostedSchema, () => ({ posted: {} })),
    writePosted: (number, posted) => writeJsonAtomic(path.join(deckDir(number), 'posted.json'), posted),
  }
}
