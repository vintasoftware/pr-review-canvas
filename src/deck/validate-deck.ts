// Checks a generated deck-model.json against the prepared diff: the schema, the visible-length
// caps that keep one card on one screen, the card cap, and anchors that sit inside the diff.
import type { z } from 'zod'
import {
  CARD_SIDES,
  DECK_CAPS,
  type DeckModel,
  DeckModelSchema,
  type DecisionCard,
  SNIPPET_MAX_LINES,
} from '../contract/deck.js'
import type { FileEntry } from '../contract/review-artifact.js'
import { hunkForLine, hunkLineRanges } from '../git/patch-lines.js'
import { visibleLength } from '../review/text-length.js'
import { sceneProblems } from './validate-scene.js'

export type DeckProblemCode =
  | 'DECK_SCHEMA'
  | 'TOO_MANY_CARDS'
  | 'DUPLICATE_CARD'
  | 'TEXT_TOO_LONG'
  | 'SNIPPET_TOO_LONG'
  | 'CARD_OUTSIDE_DIFF'
  | 'SIDES_ALIKE'
  | 'SCENE_INVALID'

export interface DeckProblem {
  code: DeckProblemCode
  /** Where in the model: `card:<key>`, `card:<key>.a.why`. */
  where: string
  message: string
}

export type DeckValidation = { ok: true; model: DeckModel } | { ok: false; problems: DeckProblem[] }

export interface DeckValidationInput {
  files: readonly FileEntry[]
  maxCards: number
}

/** The line a human reads: the code, then the message. */
export function formatDeckProblem(p: DeckProblem): string {
  return `${p.code} ${p.message}`
}

function schemaProblems(issues: readonly z.core.$ZodIssue[]): DeckProblem[] {
  return issues.map(issue => {
    const where = issue.path.map(String).join('.') || '(root)'
    return { code: 'DECK_SCHEMA', where, message: `${where}: ${issue.message}` }
  })
}

function checkText(card: DecisionCard, problems: DeckProblem[]): void {
  const fields: Array<[string, string, number]> = [
    ['title', card.title, DECK_CAPS.title],
    ['topic', card.topic, DECK_CAPS.topic],
    ['context', card.context, DECK_CAPS.context],
  ]
  for (const side of CARD_SIDES) {
    fields.push(
      [`${side}.label`, card[side].label, DECK_CAPS.label],
      [`${side}.consequence`, card[side].consequence, DECK_CAPS.consequence],
      [`${side}.why`, card[side].why, DECK_CAPS.why]
    )
  }
  for (const [field, text, cap] of fields) {
    const n = visibleLength(text)
    if (n > cap) {
      const where = `card:${card.key}.${field}`
      problems.push({ code: 'TEXT_TOO_LONG', where, message: `${where}: ${n} visible chars, cap ${cap}` })
    }
  }
  for (const side of CARD_SIDES) {
    const snippet = card[side].snippet
    const lines = snippet === undefined ? 0 : snippet.code.replace(/\n$/, '').split('\n').length
    if (lines > SNIPPET_MAX_LINES) {
      const where = `card:${card.key}.${side}.snippet`
      problems.push({
        code: 'SNIPPET_TOO_LONG',
        where,
        message: `${where}: ${lines} lines, cap ${SNIPPET_MAX_LINES}; the diff drawer shows the rest`,
      })
    }
  }
  for (const side of CARD_SIDES) {
    const scene = card[side].scene
    for (const message of scene === undefined ? [] : sceneProblems(scene)) {
      const where = `card:${card.key}.${side}.scene`
      problems.push({ code: 'SCENE_INVALID', where, message: `${where}: ${message}` })
    }
  }
  if (card.a.label.trim().toLowerCase() === card.b.label.trim().toLowerCase()) {
    const where = `card:${card.key}`
    problems.push({ code: 'SIDES_ALIKE', where, message: `${where}: sides A and B have the same label` })
  }
}

function checkAnchor(card: DecisionCard, byPath: Map<string, FileEntry>, problems: DeckProblem[]): void {
  const where = `card:${card.key}`
  const side = card.side ?? 'new'
  const file = byPath.get(card.path)
  if (file === undefined) {
    problems.push({ code: 'CARD_OUTSIDE_DIFF', where, message: `${where}: ${card.path} is not in the diff` })
    return
  }
  if (hunkForLine(file.hunks, side, card.line) === null) {
    problems.push({
      code: 'CARD_OUTSIDE_DIFF',
      where,
      message: `${where}: ${card.path}:${card.line} (${side}) is not in the diff (${hunkLineRanges(file.hunks, side)})`,
    })
  }
}

export function validateDeckModel(raw: unknown, input: DeckValidationInput): DeckValidation {
  const parsed = DeckModelSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, problems: schemaProblems(parsed.error.issues) }
  }
  const model = parsed.data
  const problems: DeckProblem[] = []
  if (model.cards.length > input.maxCards) {
    problems.push({
      code: 'TOO_MANY_CARDS',
      where: 'cards',
      message: `${model.cards.length} cards, cap ${input.maxCards} for this change; keep the ones that matter most`,
    })
  }
  const byPath = new Map(input.files.map(f => [f.path, f]))
  const seen = new Set<string>()
  for (const card of model.cards) {
    if (seen.has(card.key)) {
      problems.push({
        code: 'DUPLICATE_CARD',
        where: `card:${card.key}`,
        message: `card:${card.key}: two cards share this key`,
      })
    }
    seen.add(card.key)
    checkText(card, problems)
    checkAnchor(card, byPath, problems)
  }
  return problems.length === 0 ? { ok: true, model } : { ok: false, problems }
}
