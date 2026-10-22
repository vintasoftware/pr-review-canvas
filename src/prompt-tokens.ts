// The `{{TOKENS}}` releases added to the bundled prompt templates. A project's own copy of a
// template, made from an earlier release, lacks them, and rendering cannot tell: only an unknown
// token fails it. `pr-review upgrade` and `doctor` find the copies that need one and say where the
// bundled template has it.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { PROMPTS_DIR } from './paths.js'
import { type PromptOverrides, PromptOverridesSchema } from './project-config.js'

const TemplateNameSchema = PromptOverridesSchema.keyof()

export interface AddedToken {
  /** The release whose bundled template has it first. */
  since: string
  template: keyof PromptOverrides
  token: string
}

/**
 * Oldest first. A release that adds a token to a bundled template lists it here under its own
 * version; `prompt-tokens.test.ts` fails on a token missing from this list, and on a release whose
 * version is older than an entry's.
 */
export const ADDED_TOKENS: readonly AddedToken[] = [
  { since: '0.10.0', template: 'generation-format.md', token: 'RESOLVED' },
  { since: '0.10.0', template: 'generation-format.md', token: 'SETTLED_DECISIONS' },
]

export const TokenGapSchema = z.object({
  since: z.string(),
  template: TemplateNameSchema,
  token: z.string(),
  /** The project's own template, as `pr-review.config.yml` names it. */
  file: z.string(),
  /** The heading the bundled template has the token under, when it has one above it. */
  heading: z.string().nullable(),
})
export type TokenGap = z.infer<typeof TokenGapSchema>

/** The heading nearest above the token's line in `text`. */
function headingAbove(text: string, token: string): string | null {
  const lines = text.split('\n')
  const at = lines.findIndex(line => line.includes(`{{${token}}}`))
  for (let i = at; i >= 0; i--) {
    if (/^#{1,6} /.test(lines[i]!)) return lines[i]!.trim()
  }
  return null
}

/**
 * The tokens of `added` that the project's own templates lack. A template the project does not
 * override is the bundled one, which has them all; one it cannot read fails generation with its own
 * error, so it is left to that.
 */
export async function promptGaps(
  repoRoot: string,
  overrides: PromptOverrides | undefined,
  added: readonly AddedToken[],
  dir = PROMPTS_DIR
): Promise<TokenGap[]> {
  const gaps: TokenGap[] = []
  for (const entry of added) {
    const file = overrides?.[entry.template]
    if (file === undefined) continue
    const own = await readFile(path.resolve(repoRoot, file), 'utf8').catch(() => null)
    if (own === null || own.includes(`{{${entry.token}}}`)) continue
    const bundled = await readFile(path.join(dir, entry.template), 'utf8')
    gaps.push({ ...entry, file, heading: headingAbove(bundled, entry.token) })
  }
  return gaps
}

/** What to add, and where, for one gap. */
export function describeGap(gap: TokenGap): string {
  const where = gap.heading === null ? '' : ` under "${gap.heading}"`
  return `add {{${gap.token}}} to ${gap.file}${where}, where pr-review ${gap.since}'s ${gap.template} has it`
}
