import type { GenerationContext } from '../contract/generation-context.js'
import { ReviewArtifactSchema } from '../contract/review-artifact.js'
import { writeTextAtomic } from '../store/atomic-json.js'
import { applyFoldFixes, describeFoldFix, type FoldFix } from './fix-folds.js'
import { applyTitleTrims, type TitleTrim } from './trim-caps.js'

/**
 * Trims the over-cap titles of a model file, repairs its mechanically broken folds, and writes it
 * back. Returns the text to validate, unchanged when nothing needed fixing, so a file that is
 * already fine is never rewritten. A stored review.json keeps the folds it was published with.
 */
export async function fixModel(
  file: string,
  text: string,
  context: GenerationContext,
  patches: Readonly<Record<string, string>>
): Promise<{ text: string; trims: TitleTrim[]; folds: FoldFix[] }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // An unparseable file has nothing to fix; the validator reports the syntax error.
    return { text, trims: [], folds: [] }
  }
  // Folds first, so every reported path, a trimmed fold title's included, is one into the file
  // as written back.
  const folds = ReviewArtifactSchema.safeParse(parsed).success
    ? []
    : applyFoldFixes(parsed, context.files, patches)
  const trims = applyTitleTrims(parsed, context.caps)
  if (!trims.some(trim => trim.outcome === 'fixed') && folds.length === 0) {
    return { text, trims, folds }
  }
  const next = `${JSON.stringify(parsed, null, 2)}\n`
  await writeTextAtomic(file, next)
  return { text: next, trims, folds }
}

/** The fixes `fixModel` made, one line each, in the words `validate --fix` prints them. */
export function describeFixes(fixed: { trims: TitleTrim[]; folds: FoldFix[] }): string[] {
  return [
    ...fixed.folds.map(fold => `${fold.where}: ${describeFoldFix(fold)}`),
    ...fixed.trims.flatMap(trim =>
      trim.outcome === 'fixed' ? [`${trim.where}: "${trim.from}" -> "${trim.to}"`] : []
    ),
  ]
}
