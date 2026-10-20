// The block that goes above the reader's message: what they pointed at, in the agent's terms.
// Every value is checked against the canvas first, so a made-up path never reaches a file read.
import type { ChatContext, TourPlace } from '../contract/chat.js'
import { chatContextLabel } from '../contract/chat.js'
import { pointLevelText } from '../../static/js/point-level.js'
import { pointRef } from '../../static/js/proposed-comment.js'
import type { FileEntry, Hunk, Layer, ReviewArtifact } from '../contract/review-artifact.js'
import type { TourReaderState } from '../contract/tour-api.js'
import type { TourArtifact } from '../contract/tour.js'
import { pickSettled, planOf } from '../tour/plan.js'

/** A file's patch goes into the message up to this many lines; past it the agent reads the file. */
export const INLINE_PATCH_MAX_LINES = 400
/** A line range the reader can select and the agent can read in one block. */
export const LINE_RANGE_MAX = 400

export class ChatContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatContextError'
  }
}

/** The tour a turn on the tour page talks about, and where its reader stands. */
export interface TourSources {
  artifact: TourArtifact
  reader: TourReaderState
}

export interface ContextSources {
  artifact: ReviewArtifact
  files: readonly FileEntry[]
  patches: Record<string, string>
  /** Lines of a materialized file, or null when this head has none. */
  readLines: (side: 'head' | 'base', path: string, from: number, to: number) => Promise<string[] | null>
}

function layerById(artifact: ReviewArtifact, id: string): Layer {
  const layer = artifact.layers.find(l => l.id === id)
  if (layer === undefined) {
    throw new ChatContextError(`this canvas has no layer ${id}`)
  }
  return layer
}

function fileByPath(sources: ContextSources, path: string): FileEntry {
  const entry = sources.files.find(f => f.path === path)
  if (entry === undefined) {
    throw new ChatContextError(`${path} is not a file of this pull request`)
  }
  return entry
}

/** The hunk a line sits in, on the side the reader selected. */
export function enclosingHunk(entry: FileEntry, side: 'new' | 'old', line: number): Hunk | undefined {
  return entry.hunks.find(h => {
    const start = side === 'new' ? h.newStart : h.oldStart
    // A hunk that adds lines shows none on the old side, and the other way round.
    const count = side === 'new' ? h.newLines : h.oldLines
    return count > 0 && line >= start && line < start + count
  })
}

function fence(body: string, lang = ''): string {
  return `\`\`\`${lang}\n${body}\n\`\`\``
}

function patchOf(sources: ContextSources, entry: FileEntry): string | null {
  const patch = sources.patches[entry.key]
  if (patch === undefined || patch === '') {
    return null
  }
  return patch.split('\n').length > INLINE_PATCH_MAX_LINES ? null : patch
}

/**
 * The context block for one message. The label is the same text the chip on screen shows, so the
 * reader and the agent are talking about the same thing.
 */
export async function renderChatContext(context: ChatContext, sources: ContextSources): Promise<string> {
  const label = chatContextLabel(
    context,
    id => sources.artifact.layers.find(l => l.id === id)?.title,
    fp => sources.artifact.points.find(p => p.fingerprint === fp)?.title
  )
  switch (context.kind) {
    case 'pr':
      return '## Context: the whole pull request\n\nThe reader is asking about the pull request as a whole.'
    case 'layer': {
      const layer = layerById(sources.artifact, context.layerId)
      const files = layer.files.map(f => `- \`${f.path}\` (${f.hunks.join(', ')})`).join('\n')
      return [`## Context: ${label}`, '', layer.rationale, '', files === '' ? '_no files_' : files].join('\n')
    }
    case 'file': {
      const entry = fileByPath(sources, context.path)
      const patch = patchOf(sources, entry)
      const body =
        patch === null
          ? `The patch is too long to inline. Read the file at the materialized head path for \`${entry.path}\`.`
          : fence(patch, 'diff')
      return [
        `## Context: \`${entry.path}\``,
        '',
        `${entry.status}, +${entry.additions} −${entry.deletions}`,
        '',
        body,
      ].join('\n')
    }
    case 'lines':
      return renderLines(context, sources, label)
    case 'point':
      return renderPoint(context, sources)
  }
}

/**
 * The context block of a turn on the tour page: the place of the tour it is about. The grilling
 * names a decision or the plan; the tour's AI Chat names any place.
 */
export function renderTourContext(place: TourPlace, tour: TourSources): string {
  switch (place.kind) {
    case 'tour':
      return '## Context: the whole tour\n\nThe reader asks about the tour as a whole, or the change it explains.'
    case 'tour-landmark':
      return renderTourLandmark(place.id, tour)
    case 'tour-decision':
      return renderTourDecision(place.key, tour)
    case 'tour-question':
      return renderTourQuestion(place.id, tour)
    case 'tour-plan':
      return renderTourPlan(tour)
  }
}

/** A landmark as the reader reads it: its story, the files of its code, and the reader's note. */
function renderTourLandmark(id: string, tour: TourSources): string {
  const landmark = tour.artifact.landmarks.find(l => l.id === id)
  if (landmark === undefined) {
    throw new ChatContextError(`this tour has no landmark ${id}`)
  }
  const files = [...new Set(landmark.code.map(chunk => chunk.path))]
  const note = (tour.reader.notes[id] ?? '').trim()
  return [
    `## Context: landmark "${landmark.title}"`,
    '',
    `${landmark.stage}${landmark.state === true ? ', the state landmark' : ''} · ${landmark.lead}`,
    '',
    ...landmark.body.flatMap(paragraph => [paragraph, '']),
    files.length === 0 ? 'Its code: none quoted.' : `Its code: ${files.map(f => `\`${f}\``).join(', ')}`,
    ...(note === '' ? [] : ['', `The reader's note on it: ${note}`]),
  ].join('\n')
}

/**
 * A quiz question. Until the reader has it right, the agent is not told the answer, so it helps
 * them reason from the code instead of giving the answer away.
 */
function renderTourQuestion(id: string, tour: TourSources): string {
  const question = tour.artifact.quiz.find(q => q.id === id)
  if (question === undefined) {
    throw new ChatContextError(`this tour has no question ${id}`)
  }
  const landmark = tour.artifact.landmarks.find(l => l.id === question.landmark)
  const answered = tour.reader.quiz[id]
  const stands =
    answered === undefined
      ? 'The reader has not answered yet.'
      : answered.right
        ? `The reader answered right. Why: ${question.why}`
        : `The reader answered ${answered.answered + 1}, which is wrong.`
  return [
    `## Context: quiz question — ${question.question}`,
    '',
    ...(landmark === undefined ? [] : [`From the landmark "${landmark.title}".`, '']),
    ...question.options.map((option, i) => `${i + 1}. ${option}`),
    '',
    stands,
    ...(answered?.right === true
      ? []
      : ['', 'Do not say which option is right: help the reader reason about it from the code.']),
  ].join('\n')
}

/** A decision the reader wants changed: both sides, the tour's reason, and where the reader stands. */
function renderTourDecision(key: string, tour: TourSources): string {
  const decision = tour.artifact.decisions.find(d => d.key === key)
  if (decision === undefined) {
    throw new ChatContextError(`this tour has no decision ${key}`)
  }
  const landmark = tour.artifact.landmarks.find(l => l.id === decision.landmark)
  const pick = tour.reader.picks[decision.key]
  const stands =
    pick === undefined
      ? 'The reader has not answered yet.'
      : pick.pick === 'keep'
        ? `The reader keeps it${pickSettled(pick) ? '' : ' so far'}.`
        : pick.pick === 'change'
          ? `The reader picks the tour's alternative${pickSettled(pick) ? '' : ' so far'}.`
          : pick.restatement === undefined
            ? 'The reader wants something else and has not said what yet.'
            : `The reader wants something else; the restatement so far: ${pick.restatement.what} (where: ${pick.restatement.where.join(', ')}; unchanged: ${pick.restatement.unchanged}).`
  const note = (tour.reader.notes[decision.landmark] ?? '').trim()
  return [
    `## Context: decision \`${decision.key}\` — ${decision.title}`,
    '',
    `${decision.category}${landmark === undefined ? '' : ` · from the landmark "${landmark.title}"`} · \`${decision.anchor.path}:${decision.anchor.line}\``,
    '',
    decision.context,
    '',
    `- keep: ${decision.keep.label}. ${decision.keep.consequence}`,
    `- change: ${decision.change.label}. ${decision.change.consequence}`,
    `- the tour recommended: ${decision.recommended}`,
    '',
    stands,
    ...(note === '' ? [] : ['', `The reader's note on that landmark: ${note}`]),
  ].join('\n')
}

/** The plan as it stands: what the reader kept, what they approved changing, what is still open. */
function renderTourPlan(tour: TourSources): string {
  const plan = planOf(tour.artifact, tour.reader)
  const open = tour.artifact.decisions.filter(d => !pickSettled(tour.reader.picks[d.key]))
  const list = (items: string[]) => (items.length === 0 ? '_none_' : items.join('\n'))
  return [
    '## Context: the plan',
    '',
    'Kept:',
    list(plan.kept.map(({ decision }) => `- \`${decision.key}\`: ${decision.keep.label}`)),
    '',
    'Approved changes:',
    list(
      plan.changes.map(
        ({ decision, restatement }) =>
          `- \`${decision.key}\`: ${restatement.what} (where: ${restatement.where.join(', ')}${restatement.unchanged === undefined ? '' : `; unchanged: ${restatement.unchanged}`})`
      )
    ),
    '',
    'Still open:',
    list(open.map(d => `- \`${d.key}\`: ${d.title}`)),
  ].join('\n')
}

/**
 * An attention point: what it says, plus the lines it sits on. The agent needs the text to know
 * what the reader is reacting to; the lines alone leave it guessing. One context, one heading.
 */
async function renderPoint(
  context: Extract<ChatContext, { kind: 'point' }>,
  sources: ContextSources
): Promise<string> {
  const point = sources.artifact.points.find(p => p.fingerprint === context.fingerprint)
  if (point === undefined) {
    throw new ChatContextError('this canvas has no such attention point')
  }
  const at: Extract<ChatContext, { kind: 'lines' }> = {
    kind: 'lines',
    path: point.path,
    side: point.side === 'old' ? 'old' : 'new',
    start: point.line,
    end: point.endLine ?? point.line,
  }
  return [
    `## Context: attention point — ${point.title}`,
    '',
    `${point.kind} · ${pointLevelText(point)} · point \`${pointRef(point.fingerprint)}\``,
    '',
    point.body,
    '',
    `It sits on ${chatContextLabel(at)}:`,
    '',
    await linesBody(at, sources),
  ].join('\n')
}

async function renderLines(
  context: Extract<ChatContext, { kind: 'lines' }>,
  sources: ContextSources,
  label: string
): Promise<string> {
  return `## Context: ${label}\n\n${await linesBody(context, sources)}`
}

/** The quoted lines and the hunk around them, with no heading of their own. */
async function linesBody(
  context: Extract<ChatContext, { kind: 'lines' }>,
  sources: ContextSources
): Promise<string> {
  if (context.end < context.start) {
    throw new ChatContextError('the last line of a selection comes after the first')
  }
  if (context.end - context.start + 1 > LINE_RANGE_MAX) {
    throw new ChatContextError(`select at most ${LINE_RANGE_MAX} lines`)
  }
  const entry = fileByPath(sources, context.path)
  const side = context.side === 'new' ? 'head' : 'base'
  const lines = await sources.readLines(side, entry.path, context.start, context.end)
  const hunk = enclosingHunk(entry, context.side, context.start)
  const numbered =
    lines === null || lines.length === 0
      ? '_these lines are not available locally_'
      : fence(lines.map((text, i) => `${context.start + i}: ${text}`).join('\n'))
  const hunkBlock =
    hunk === undefined ? '' : `\n\nThe hunk around them is \`${hunk.id}\` (\`${hunk.header}\`).`
  return `${numbered}${hunkBlock}`
}
