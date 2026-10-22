// The author's settled decisions, read from the commits under review. A decision the author already
// took, in the review loop or by hand, is a `Settled-decision` line of the commit that carries it:
// `<path>:<line>[:old] [<the question>? ]<the decision and its reason>`. `prepare` reads them, and
// publish shows each one in the diff as a resolved point, so the canvas does not ask the question again.
import type { SettledDecision } from '../contract/generation-context.js'
import {
  ARTIFACT_MAX_POINTS,
  type FileEntry,
  LIMITS,
  SETTLEMENT_REASON_MAX,
  type Side,
} from '../contract/review-artifact.js'
import type { Git } from '../git/git.js'
import { hunkForLine } from '../git/patch-lines.js'
import { normalizeTitle } from './normalize.js'
import { rowsOnSide, unchangedLines } from './point-carry.js'

export const SETTLED_DECISION_KEY = 'Settled-decision'

/**
 * How many decisions a canvas shows as points: the room a canvas has left once the generator has
 * written all it may. Past it, the oldest decisions in the diff are kept as context.
 */
export const MAX_DECISION_POINTS = ARTIFACT_MAX_POINTS - LIMITS.maxPoints

export interface ParsedDecision {
  path: string
  line: number
  side: Side
  /** The question the decision answers, up to its first ending `?`; absent when the line states none. */
  question?: string
  /**
   * The decision and its reason: the answer, after the question when there is one. Absent when the
   * line asks a question and stops there: the question was raised, not answered.
   */
  text?: string
}

// A colon after the line number, as in `src/app.ts:4: keep it`, is read as part of the anchor.
const DECISION_VALUE = /^(\S+):(\d+)(:old)?:?\s+(\S.*)$/
// The question runs to the first `?` that a space follows outside a code span, so a `?` inside a
// URL or quoted code such as `x ?? 0` stays in place. A backtick with no closing one ends nothing.
const QUESTION = /^((?:[^`?]|`[^`]*`|\?(?!\s))*\?)\s+(\S.*)$/
// A line that is all question, with no answer after it.
const QUESTION_ONLY = /^(?:[^`?]|`[^`]*`|\?(?!\s))*\?$/

/** One value, or null when it does not read as `<path>:<line>[:old] [<question>? ]<text>`. */
export function parseSettledDecision(value: string): ParsedDecision | null {
  const match = DECISION_VALUE.exec(value.trim())
  if (match === null) {
    return null
  }
  const [, anchor = '', lineText = '', old, rest = ''] = match
  const line = Number(lineText)
  if (line < 1) {
    return null
  }
  // Paths in the diff are relative to the repository root, so a leading `./` names the same file.
  const path = anchor.replace(/^(\.\/)+/, '')
  if (path === '') {
    return null
  }
  const side = old === undefined ? 'new' : 'old'
  const said = rest.trim()
  if (QUESTION_ONLY.test(said)) {
    return { path, line, side, question: said }
  }
  const asked = QUESTION.exec(said)
  const [, question = '', answer = ''] = asked ?? []
  return asked === null
    ? { path, line, side, text: said }
    : { path, line, side, question: question.trim(), text: answer.trim() }
}

export interface DecisionSources {
  git: Pick<Git, 'commitKeyedLines' | 'show'>
  mergeBaseSha: string
  headSha: string
  files: readonly FileEntry[]
  /** Each file's patch, by its key: the rows that say whether the diff deletes a line. */
  patches: Readonly<Record<string, string>>
  /**
   * The email of whoever prepares the canvas, as they commit. Only their own commits' decisions
   * count, so a commit someone else pushed to the branch cannot answer the author's questions;
   * with no address, none count.
   */
  authorEmail: string | null
}

async function fileLines(git: DecisionSources['git'], ref: string, path: string): Promise<string[] | null> {
  const content = await git.show(ref, path)
  return content === null ? null : content.toString('utf8').split('\n')
}

/**
 * The decision's line in this diff, or null. A new-side line is numbered as in the commit that wrote
 * it and is carried to the head, and kept when it falls inside a chunk; an old-side line, one the
 * change deleted, is numbered as in that commit's parent and is carried to the merge base, and kept
 * while the diff still deletes it. Either is carried only while it reads the same at both ends, as
 * a shortest edit script between the two versions leaves it. The number trusts the commit's own
 * version, which a rebase rewrites without touching the message.
 */
async function lineInDiff(
  src: DecisionSources,
  commit: string,
  decision: ParsedDecision
): Promise<number | null> {
  const entry = src.files.find(file => file.path === decision.path)
  if (entry === undefined) {
    return null
  }
  // A renamed file has its old name at the merge base, and in the parent of the commit that renamed it.
  const [written, shown] = await Promise.all(
    decision.side === 'new'
      ? [fileLines(src.git, commit, decision.path), fileLines(src.git, src.headSha, decision.path)]
      : [
          fileLines(src.git, `${commit}^`, decision.path).then(lines =>
            lines === null && entry.oldPath !== undefined
              ? fileLines(src.git, `${commit}^`, entry.oldPath)
              : lines
          ),
          fileLines(src.git, src.mergeBaseSha, entry.oldPath ?? entry.path),
        ]
  )
  const line =
    written === null || shown === null ? undefined : unchangedLines(written, shown)?.get(decision.line)
  if (line === undefined) {
    return null
  }
  // A later commit that restored a deleted line leaves it as context, where the decision about
  // deleting it no longer holds.
  const inDiff =
    decision.side === 'new'
      ? hunkForLine(entry.hunks, 'new', line) !== null
      : rowsOnSide(src.patches[entry.key] ?? '', 'old')
          .get(line)
          ?.startsWith('-') === true
  return inDiff ? line : null
}

function capReason(text: string): string {
  return text.length <= SETTLEMENT_REASON_MAX ? text : `${text.slice(0, SETTLEMENT_REASON_MAX - 1)}…`
}

/**
 * The author's decisions on `mergeBase..head`, oldest first. A value that does not parse is not a
 * decision and is skipped. When two decisions on the same line answer the same question, or both
 * state none, the later one stands; two questions on one line are two decisions. A question asked
 * without an answer is kept as context, where nothing resolves it, until a later line answers it.
 */
export async function readSettledDecisions(src: DecisionSources): Promise<SettledDecision[]> {
  if (src.authorEmail === null) {
    return []
  }
  const email = src.authorEmail.toLowerCase()
  const commits = await src.git.commitKeyedLines(src.mergeBaseSha, src.headSha, SETTLED_DECISION_KEY)
  const decisions: SettledDecision[] = []
  for (const commit of commits.filter(candidate => candidate.authorEmail.toLowerCase() === email)) {
    for (const [position, value] of commit.values.entries()) {
      const parsed = parseSettledDecision(value)
      if (parsed !== null) {
        decisions.push({
          id: `${commit.sha.slice(0, 7)}-${position + 1}`,
          commit: commit.sha,
          date: commit.date,
          ...(parsed.question === undefined ? {} : { question: capReason(parsed.question) }),
          ...(parsed.text === undefined ? {} : { text: capReason(parsed.text) }),
          path: parsed.path,
          side: parsed.side,
          line: await lineInDiff(src, commit.sha, parsed),
        })
      }
    }
  }
  // The question is compared as a title is: case and spacing aside.
  const asked = (decision: SettledDecision) =>
    `${decision.path}\n${decision.side}\n${decision.line}\n${normalizeTitle(decision.question ?? '')}`
  const standing = decisions
    .filter(
      (decision, index) =>
        decision.line === null || !decisions.slice(index + 1).some(later => asked(later) === asked(decision))
    )
    .map(decision => (decision.text === undefined ? { ...decision, line: null } : decision))
  const anchored = standing.filter(decision => decision.line !== null)
  const asContext = new Set(anchored.slice(0, Math.max(0, anchored.length - MAX_DECISION_POINTS)))
  return standing.map(decision => (asContext.has(decision) ? { ...decision, line: null } : decision))
}
