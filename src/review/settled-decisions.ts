// The author's settled decisions, read from the commits under review. A decision the author already
// took, in the review loop or by hand, is a `Settled-decision` line of the commit that carries it:
// `<path>:<line>[:old] <the decision and its reason>`. `prepare` reads them, and publish shows each
// one in the diff as a resolved point, so the canvas does not ask the question again.
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
import { unchangedLines } from './point-carry.js'

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
  text: string
}

const DECISION_VALUE = /^(\S+):(\d+)(:old)?\s+(\S.*)$/

/** One value, or null when it does not read as `<path>:<line>[:old] <text>`. */
export function parseSettledDecision(value: string): ParsedDecision | null {
  const match = DECISION_VALUE.exec(value.trim())
  if (match === null) {
    return null
  }
  const [, path = '', lineText = '', old, text = ''] = match
  const line = Number(lineText)
  if (line < 1) {
    return null
  }
  return { path, line, side: old === undefined ? 'new' : 'old', text: text.trim() }
}

export interface DecisionSources {
  git: Pick<Git, 'commitKeyedLines' | 'show'>
  mergeBaseSha: string
  headSha: string
  files: readonly FileEntry[]
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
 * it and is carried to the head; an old-side line, one the change deleted, is numbered as in that
 * commit's parent and is carried to the merge base. Either is carried only while the commits in
 * between leave it as it was, and kept only when it falls inside a chunk. The number trusts the
 * commit's own version, which a rebase rewrites without touching the message.
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
  const [writtenAt, shownAt] =
    decision.side === 'new' ? [commit, src.headSha] : [`${commit}^`, src.mergeBaseSha]
  const [written, shown] = await Promise.all([
    fileLines(src.git, writtenAt, decision.path),
    fileLines(src.git, shownAt, decision.path),
  ])
  const line =
    written === null || shown === null ? undefined : unchangedLines(written, shown)?.get(decision.line)
  return line !== undefined && hunkForLine(entry.hunks, decision.side, line) !== null ? line : null
}

function capReason(text: string): string {
  return text.length <= SETTLEMENT_REASON_MAX ? text : `${text.slice(0, SETTLEMENT_REASON_MAX - 1)}…`
}

/**
 * The author's decisions on `mergeBase..head`, oldest first. A value that does not parse is not a
 * decision and is skipped. When two decisions land on the same line, the later commit's stands.
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
          text: capReason(parsed.text),
          path: parsed.path,
          side: parsed.side,
          line: await lineInDiff(src, commit.sha, parsed),
        })
      }
    }
  }
  const anchor = (decision: SettledDecision) => `${decision.path}\n${decision.side}\n${decision.line}`
  const standing = decisions.filter(
    (decision, index) =>
      decision.line === null || !decisions.slice(index + 1).some(later => anchor(later) === anchor(decision))
  )
  const anchored = standing.filter(decision => decision.line !== null)
  const asContext = new Set(anchored.slice(0, Math.max(0, anchored.length - MAX_DECISION_POINTS)))
  return standing.map(decision => (asContext.has(decision) ? { ...decision, line: null } : decision))
}
