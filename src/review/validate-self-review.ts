// The rules that keep a pull request's canvas faithful to the author's self-review. Whether the
// code really contradicts a settled decision is a judgment no check can make; what a check can
// make sure of is that every reopened decision says so, on the code it concerns, and that every
// card the author left for reviewers reaches them.
import type { GenerationContext, SelfReviewDecision } from '../contract/generation-context.js'
import type { FileEntry, ModelOutput, ModelPoint } from '../contract/review-artifact.js'
import type { ValidationError } from '../contract/validation.js'
import { hunkForLine } from '../git/patch-lines.js'

type SelfReview = NonNullable<GenerationContext['selfReview']>

/** The id of the chunk a line sits in, or null when it is outside the diff. */
function chunkOf(
  byPath: ReadonlyMap<string, FileEntry>,
  at: { path: string; side?: 'new' | 'old' | undefined; line?: number | undefined }
): string | null {
  const file = byPath.get(at.path)
  if (file === undefined || at.line === undefined) {
    return null
  }
  return hunkForLine(file.hunks, at.side ?? 'new', at.line)?.id ?? null
}

function label(p: ModelPoint, i: number): string {
  return `point ${i + 1} "${p.title}"`
}

function keysOf(decisions: readonly SelfReviewDecision[]): string {
  return decisions.length === 0 ? 'none' : decisions.map(d => d.key).join(', ')
}

export function validateSelfReview(
  output: ModelOutput,
  files: readonly FileEntry[],
  selfReview: SelfReview | undefined
): ValidationError[] {
  const errors: ValidationError[] = []
  const add = (code: ValidationError['code'], where: string, message: string) =>
    errors.push({ code, where, message })
  const settled = new Map((selfReview?.settled ?? []).map(d => [d.key, d]))
  const open = new Map((selfReview?.open ?? []).map(d => [d.key, d]))
  const byPath = new Map(files.map(f => [f.path, f]))
  // The chunks a settled decision sits in, so a point on one can be told apart from the rest.
  const settledIn = new Map<string, SelfReviewDecision[]>()
  for (const d of settled.values()) {
    const chunk = chunkOf(byPath, d)
    if (chunk !== null) settledIn.set(chunk, [...(settledIn.get(chunk) ?? []), d])
  }

  output.points.forEach((p, i) => {
    const where = `point:${i + 1}`
    const chunk = chunkOf(byPath, p)
    if (p.reopens !== undefined) {
      const decision = settled.get(p.reopens)
      if (decision === undefined) {
        add(
          'SELF_REVIEW_KEY',
          where,
          `${label(p, i)} reopens "${p.reopens}", which is no settled decision (settled: ${keysOf([...settled.values()])})`
        )
      } else if (p.kind !== 'decision' || p.level !== 'decide') {
        add(
          'SELF_REVIEW_LEVEL',
          where,
          `${label(p, i)} reopens "${p.reopens}" as ${p.kind}/${p.level}; a reopened decision is a decision/decide point`
        )
      } else {
        const expected = chunkOf(byPath, decision)
        if (expected !== null && chunk !== expected) {
          add(
            'REOPEN_ELSEWHERE',
            where,
            `${label(p, i)} reopens "${p.reopens}" from ${p.path}:${p.line}, but the decision sits at ${decision.path}:${decision.line}; anchor it there`
          )
        }
      }
    }
    if (p.asks !== undefined) {
      if (!open.has(p.asks)) {
        add(
          'SELF_REVIEW_KEY',
          where,
          `${label(p, i)} asks "${p.asks}", which is no card left for reviewers (open: ${keysOf([...open.values()])})`
        )
      } else if (p.level !== 'decide') {
        add(
          'SELF_REVIEW_LEVEL',
          where,
          `${label(p, i)} asks "${p.asks}" at level ${p.level}; it is a decide point`
        )
      }
    }
    // A decide point on a settled decision's code must declare the reopen with a key that names a
    // settled decision; a misspelled key is no declaration.
    const here = chunk === null ? [] : (settledIn.get(chunk) ?? [])
    const declared = p.reopens !== undefined && settled.has(p.reopens)
    const asking = p.asks !== undefined && open.has(p.asks)
    if (p.level === 'decide' && !declared && !asking && here.length > 0) {
      add(
        'SETTLED_REOPENED',
        where,
        `${label(p, i)} is a decide point on the code of settled decision ${here.map(d => `"${d.key}"`).join(', ')}; ` +
          'set `reopens` when the code contradicts the pick, lower it to check or fyi, or anchor it on the code it is really about'
      )
    }
  })

  const asked = new Set(output.points.flatMap(p => (p.asks === undefined ? [] : [p.asks])))
  for (const d of open.values()) {
    // A card whose code changed since it was dealt may no longer apply; the generator judges it.
    if (d.line !== undefined && !asked.has(d.key)) {
      add(
        'OPEN_UNASKED',
        `open:${d.key}`,
        `the author left "${d.key}" ("${d.title}") for reviewers, and no decide point has \`asks: "${d.key}"\``
      )
    }
  }
  return errors
}
