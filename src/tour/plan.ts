// The plan a finished tour settles on: the decisions kept with their reasons, the changes approved
// in the grilling, and the reader's notes, written as the prompt whoever touches the change next
// runs from.
import type { ReaderPick, Restatement, TourReaderState } from '../contract/tour-api.js'
import type { Decision, Landmark, TourArtifact } from '../contract/tour.js'

export interface PlanEntry {
  decision: Decision
  pick: ReaderPick
}

/** An approved change: settled, so its restatement is there. */
export interface PlanChange extends PlanEntry {
  restatement: Restatement
}

export interface TourPlan {
  changes: PlanChange[]
  kept: PlanEntry[]
  notes: Array<{ landmark: Landmark; text: string }>
}

/** A decision is settled by an approved keep, or by a change whose restatement was approved. */
export function pickSettled(pick: ReaderPick | undefined): boolean {
  if (pick === undefined || !pick.approved) return false
  return pick.pick === 'keep' || pick.restatement !== undefined
}

/** The decisions the reader has not settled yet, by title. */
export function unsettledDecisions(tour: Pick<TourArtifact, 'decisions'>, reader: TourReaderState): string[] {
  return tour.decisions.filter(d => !pickSettled(reader.picks[d.key])).map(d => d.title)
}

/** The quiz questions not answered right yet. */
export function unansweredQuiz(tour: Pick<TourArtifact, 'quiz'>, reader: TourReaderState): number {
  return tour.quiz.filter(q => reader.quiz[q.id]?.right !== true).length
}

export function planOf(
  tour: Pick<TourArtifact, 'decisions' | 'landmarks'>,
  reader: TourReaderState
): TourPlan {
  const entries = tour.decisions
    .map(decision => ({ decision, pick: reader.picks[decision.key] }))
    .filter((e): e is PlanEntry => pickSettled(e.pick))
  return {
    changes: entries.flatMap(e =>
      e.pick.pick === 'change' && e.pick.restatement !== undefined
        ? [{ ...e, restatement: e.pick.restatement }]
        : []
    ),
    kept: entries.filter(e => e.pick.pick === 'keep'),
    notes: tour.landmarks
      .map(landmark => ({ landmark, text: (reader.notes[landmark.id] ?? '').trim() }))
      .filter(n => n.text !== ''),
  }
}

/** The landmark that says what the change means; the prompt leads with it. */
export function worldLandmark(tour: Pick<TourArtifact, 'landmarks'>): Landmark {
  const world = tour.landmarks.find(l => l.stage === 'world') ?? tour.landmarks[0]
  if (world === undefined) throw new Error('a tour has landmarks')
  return world
}

function respectLandmark(tour: Pick<TourArtifact, 'landmarks'>): Landmark {
  const last = [...tour.landmarks].reverse().find(l => l.stage === 'respect') ?? tour.landmarks.at(-1)
  if (last === undefined) throw new Error('a tour has landmarks')
  return last
}

/**
 * The re-implementation prompt: the intent, what a change must respect, the decisions kept (not
 * to be reopened), the changes as approved, the reader's notes, and what to do after.
 */
export function buildTourPrompt(tour: TourArtifact, reader: TourReaderState, key: string): string {
  const plan = planOf(tour, reader)
  const first = worldLandmark(tour)
  const respect = respectLandmark(tour)
  const what = tour.pr.number === null ? `the ${key} change` : `PR #${tour.pr.number}`
  const lines = [
    `# ${plan.changes.length > 0 ? 'Re-implement' : 'Keep'} ${what} as the tour settled it`,
    '',
    `Change: ${tour.pr.title} (${tour.repo.owner}/${tour.repo.name}, head ${tour.headSha.slice(0, 7)}).`,
    '',
    '## Intent',
    first.lead,
    ...first.body,
    '',
    '## What a change must respect',
    respect.lead,
    ...respect.body,
    '',
    '## Decisions kept by the author (do not reopen)',
    ...(plan.kept.length === 0
      ? ['- none']
      : plan.kept.map(({ decision, pick }) => {
          const place =
            pick.place === 'code'
              ? ` (write this as a comment near ${decision.anchor.path}:${decision.anchor.line})`
              : pick.place === 'lint'
                ? ' (enforce this with a lint rule)'
                : ''
          return `- ${decision.key}: ${decision.keep.label}. ${decision.reason.text}${place}`
        })),
  ]
  if (plan.changes.length > 0) {
    lines.push('', '## Changes to make, as approved in the tour')
    plan.changes.forEach(({ decision, restatement: r }, i) => {
      lines.push(
        `${i + 1}. ${decision.title}`,
        `   What: ${r.what}`,
        `   Where: ${r.where.join(', ')}`,
        `   Stays the same: ${r.unchanged}`
      )
    })
  }
  if (plan.notes.length > 0) {
    lines.push('', '## Notes the reader left while reading')
    for (const note of plan.notes) lines.push(`- On "${note.landmark.title}": ${note.text}`)
  }
  lines.push(
    '',
    '## Then',
    '- Run the project checks.',
    `- Run /pr-tour ${key} again; picks carry by decision key.`
  )
  return lines.join('\n')
}
