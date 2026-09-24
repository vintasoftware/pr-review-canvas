// The fix list: what the author's picks ask a coding agent to do, as the markdown the page shows
// and `/pr-self-review-fix` reads. It is written from the deck and the picks alone, so the same
// answers always give the same file.
import { type Deck, type DecisionCard, type Pick, pickNeedsFix } from '../contract/deck.js'
import { recordFor, whyFor } from './settled-for-pr.js'

export interface FixListSummary {
  /** Cards whose pick asks the code to change. */
  fixes: number
  /** Kept sides whose justification belongs in the code or the docs. */
  records: number
  /** Justifications kept as the author's own comments for the pull request. */
  comments: number
  /** Cards handed to reviewers as open decisions. */
  skipped: number
  /** Cards with no answer yet. */
  open: number
}

function anchor(card: DecisionCard): string {
  return `${card.path}:${card.line}${card.side === 'old' ? ' (old side)' : ''}`
}

function sideLabel(card: DecisionCard, choice: 'a' | 'b'): string {
  return `${choice.toUpperCase()}: ${card[choice].label}`
}

function fixEntry(card: DecisionCard, pick: Pick, n: number): string {
  const lines = [`### ${n}. ${card.title}`, '', `- Where: \`${anchor(card)}\``]
  if (card.current !== null) {
    lines.push(`- Now: ${sideLabel(card, card.current)}`)
  } else {
    lines.push('- Now: the code does neither side')
  }
  if (pick.choice === 'neither') {
    lines.push(`- Wanted: neither side. ${pick.note ?? ''}`.trimEnd())
  } else if (pick.choice === 'a' || pick.choice === 'b') {
    const side = card[pick.choice]
    lines.push(`- Wanted: ${sideLabel(card, pick.choice)}. ${side.consequence}`)
    if (side.snippet !== undefined) {
      lines.push(
        '',
        `  \`\`\`${side.snippet.lang ?? ''}`,
        ...side.snippet.code.split('\n').map(l => `  ${l}`),
        '  ```'
      )
    }
  }
  const reason = whyFor(card, pick)
  if (reason !== '') {
    lines.push(`- Why: ${reason}`)
  }
  const record = recordFor(card, pick)
  if (record === 'code') {
    lines.push('- Also record the reason next to the code, as a comment or a doc line.')
  }
  lines.push(`- Context: ${card.context}`)
  return lines.join('\n')
}

function recordEntry(card: DecisionCard, pick: Pick, n: number): string {
  return [
    `### ${n}. ${card.title}`,
    '',
    `- Where: \`${anchor(card)}\``,
    `- Write down: ${whyFor(card, pick)}`,
  ].join('\n')
}

export function summarizePicks(deck: Deck, picks: Readonly<Record<string, Pick>>): FixListSummary {
  const summary: FixListSummary = { fixes: 0, records: 0, comments: 0, skipped: 0, open: 0 }
  for (const card of deck.cards) {
    const pick = picks[card.key]
    if (pick === undefined) {
      summary.open++
    } else if (pick.choice === 'skip') {
      summary.skipped++
    } else if (pickNeedsFix(card, pick)) {
      summary.fixes++
    } else if (recordFor(card, pick) === 'code') {
      summary.records++
    }
    if (pick !== undefined && pick.choice !== 'skip' && recordFor(card, pick) === 'pr-comment') {
      summary.comments++
    }
  }
  return summary
}

/** The markdown of `fixes.md`. Only this deck's cards: settled ones were handled by an earlier run. */
export function renderFixList(deck: Deck, picks: Readonly<Record<string, Pick>>): string {
  const fixes: string[] = []
  const records: string[] = []
  const comments: string[] = []
  const skipped: string[] = []
  for (const card of deck.cards) {
    const pick = picks[card.key]
    if (pick === undefined || pick.choice === 'skip') {
      skipped.push(`- ${card.title} (\`${anchor(card)}\`)`)
      continue
    }
    const record = recordFor(card, pick)
    if (pickNeedsFix(card, pick)) {
      fixes.push(fixEntry(card, pick, fixes.length + 1))
    } else if (record === 'code') {
      records.push(recordEntry(card, pick, records.length + 1))
    }
    if (record === 'pr-comment') {
      comments.push(`- ${card.title} (\`${anchor(card)}\`): ${whyFor(card, pick)}`)
    }
  }
  const target =
    typeof deck.review === 'number'
      ? `pull request #${deck.review} (\`${deck.headRef}\`)`
      : deck.review === 'uncommitted'
        ? 'the working tree'
        : `branch \`${deck.headRef}\``
  const out = [
    '# Self-review fix list',
    '',
    `Decisions the author settled on ${target} against \`${deck.baseRef}\`, head \`${deck.headSha.slice(0, 12)}\`.`,
    'Apply the fixes in order. When an entry is unclear, ask the author before changing code.',
    '',
    '## Fixes',
    '',
    fixes.length === 0 ? '_No pick asks the code to change._' : fixes.join('\n\n'),
  ]
  if (records.length > 0) {
    out.push('', '## Reasons to write into the code', '', records.join('\n\n'))
  }
  if (comments.length > 0) {
    out.push(
      '',
      '## Queued as pull request comments',
      '',
      'Posted as the author’s own review when the pull request’s canvas is published. Do not write these into the code.',
      '',
      ...comments
    )
  }
  if (skipped.length > 0) {
    out.push('', '## Left for reviewers', '', ...skipped)
  }
  return `${out.join('\n')}\n`
}
