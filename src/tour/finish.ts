// Finishing a tour: the plan is settled, so the re-implementation prompt is written to the tour's
// directory, the record says who finished and, for the author, what they picked, and the record
// is shared on the pull request once.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { TourFinished, TourFinishResponse, TourReaderState, TourSharing } from '../contract/tour-api.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import type { AuthorPick, Decision, TourArtifact, TourRecord } from '../contract/tour.js'
import type { AppContext } from '../server/context.js'
import { AppError } from '../server/errors.js'
import { buildTourPrompt, planOf, unansweredQuiz, unsettledDecisions } from './plan.js'
import { writeReaderState } from './reader.js'
import { shareTourOnPr } from './share.js'

export interface FinishTourInput {
  key: ReviewKey
  headSha: string
  artifact: TourArtifact
  reader: TourReaderState
  reviewer: { login: string | null; author: boolean }
  /** True when the tour describes the pull request's head, so its lines are the head's lines. */
  current?: boolean | undefined
}

/** A reviewer's approved change as the comment their pending review will carry. */
export function changeRequestBody(
  decision: Decision,
  r: { what: string; where: string[]; unchanged: string }
): string {
  return `**Change requested in the tour:** ${decision.title}\n\n${r.what}\n\nWhere: ${r.where.join(', ')}\n\nStays the same: ${r.unchanged}`
}

/** The fingerprint a queued change request carries, so finishing twice queues it once. */
export function changeRequestFingerprint(key: string): string {
  return `tour:${key}`
}

/** The record after this reader finished: listed once, and the author's picks when it is the author. */
export function finishedRecord(
  previous: TourRecord,
  input: Pick<FinishTourInput, 'reader' | 'reviewer'>,
  prompt: string,
  at: string
): TourRecord {
  const { login, author } = input.reviewer
  const touredBy =
    login === null ? previous.touredBy : [...previous.touredBy.filter(t => t.login !== login), { login, at }]
  const record: TourRecord = { ...previous, touredBy }
  if (author) {
    const picks: Record<string, AuthorPick> = {}
    for (const [key, pick] of Object.entries(input.reader.picks)) {
      if (!pick.approved) continue
      const entry: AuthorPick = { pick: pick.pick }
      if (pick.pick === 'change' && pick.restatement !== undefined) entry.restatement = pick.restatement
      picks[key] = entry
    }
    record.author = { finishedAt: at, picks, prompt }
  }
  return record
}

export async function finishTour(ctx: AppContext, input: FinishTourInput): Promise<TourFinishResponse> {
  const { key, headSha, artifact, reader } = input
  const open = unsettledDecisions(artifact, reader)
  if (open.length > 0) {
    throw new AppError(
      'SIGNOFF_INCOMPLETE',
      `${open.length} decision${open.length === 1 ? ' is' : 's are'} not settled: ${open.join('; ')}`,
      409,
      'keep or change each decision first'
    )
  }
  if (ctx.projectConfig.config.tour.finalQuiz === 'required') {
    const left = unansweredQuiz(artifact, reader)
    if (left > 0) {
      throw new AppError(
        'SIGNOFF_INCOMPLETE',
        `${left} quiz question${left === 1 ? '' : 's'} still to answer right`,
        409,
        'this project requires the quiz before the prompt is written'
      )
    }
  }
  const at = ctx.now().toISOString()
  const prompt = buildTourPrompt(artifact, reader, keyToString(key))
  const promptPath = path.join(ctx.tours.tourDir(headSha), 'prompt.md')
  await writeFile(promptPath, `${prompt}\n`, 'utf8')
  const record = finishedRecord(artifact.record, input, prompt, at)
  // A reviewer's changes go into their pending review, only for the tour of the head: a line of an
  // older commit means something else on the head a comment would land on.
  const queues = !isLocalKey(key) && input.current === true && !input.reviewer.author
  const queued = queues ? await queueChangeRequests(ctx, key as number, headSha, artifact, reader) : 0
  await ctx.tours.revise(headSha, { ...artifact, record, revisedAt: at })
  const sharing: TourSharing = isLocalKey(key) ? { status: 'local' } : await shareTourOnPr(ctx, headSha, key)
  const finished: TourFinished = { at, promptPath, prompt, sharing }
  if (queues) finished.queued = queued
  const next: TourReaderState = { ...reader, finished }
  await writeReaderState(ctx, headSha, next)
  return { finished, record, reader: next }
}

/** A reviewer's approved changes, each queued once in their pending review on the decision's line. */
async function queueChangeRequests(
  ctx: AppContext,
  number: number,
  headSha: string,
  artifact: TourArtifact,
  reader: TourReaderState
): Promise<number> {
  const state = await ctx.state.read(number)
  const already = new Set(state.pending.map(p => p.proposalFingerprint))
  let queued = 0
  for (const { decision, restatement } of planOf(artifact, reader).changes) {
    const proposalFingerprint = changeRequestFingerprint(decision.key)
    if (already.has(proposalFingerprint)) continue
    await ctx.state.addPending(
      number,
      {
        path: decision.anchor.path,
        line: decision.anchor.line,
        side: 'new',
        body: changeRequestBody(decision, restatement),
        proposalFingerprint,
        headSha,
      },
      headSha
    )
    queued += 1
  }
  return queued
}
