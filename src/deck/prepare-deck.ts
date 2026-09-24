// `pr-review deck prepare`: resolve the local review's head, collect its diff, carry the decisions
// settled in the previous deck, and write the prompt the generator reads. Nothing here writes a
// deck; `deck publish` does, after validation.
import path from 'node:path'
import {
  DECK_CAPS,
  type DeckContext,
  deckCardCap,
  type SettledCard,
  SNIPPET_MAX_LINES,
} from '../contract/deck.js'
import type { FileEntry, Pr } from '../contract/review-artifact.js'
import { isLocalKey, keyToString, type ReviewKey } from '../contract/review-key.js'
import { describeLocalWork, resolveLocalBase, UNCOMMITTED_STATE } from '../git/local-target.js'
import { labelPatch } from '../git/patch-lines.js'
import { loadPromptFile } from '../prompt-files.js'
import { resolvePr } from '../review/prepare.js'
import { pickedLabel, sentence, settledFrom } from './settled-for-pr.js'
import { embedMarkdown, manifestMarkdown, patchLineCount } from '../review/prompt.js'
import type { AppContext } from '../server/context.js'
import { readText, writeJsonAtomic, writeTextAtomic } from '../store/atomic-json.js'

export const DECK_MODEL_FILE = 'deck-model.json'
export const DECK_PROMPT_FILE = 'self-review-deck.md'

export interface PrepareDeckResult {
  status: 'prepared' | 'exists'
  review: ReviewKey
  headSha: string
  base: string
  headRef: string
  uncommitted: boolean
  promptPath: string
  modelPath: string
  maxCards: number
  /** Decisions carried from the previous deck, which the generator must not ask again. */
  settled: number
}

function settledMarkdown(settled: readonly SettledCard[]): string {
  if (settled.length === 0) {
    return ''
  }
  const rows = settled.map(
    card => `- \`${card.key}\` **${card.title}**: the author picked ${sentence(pickedLabel(card))}`
  )
  return [
    '## Already settled',
    '',
    'The author settled these in an earlier deck of this review. Do not write a card for them again,',
    'with one exception: when the code at this head still contradicts the side the author picked,',
    'write the card again with the same `key`, and say in `context` what still contradicts it.',
    '',
    ...rows,
  ].join('\n')
}

function capsMarkdown(): string {
  return [
    `- title: ${DECK_CAPS.title}`,
    `- topic: ${DECK_CAPS.topic}`,
    `- context: ${DECK_CAPS.context}`,
    `- side label: ${DECK_CAPS.label}`,
    `- side consequence: ${DECK_CAPS.consequence}`,
    `- side why: ${DECK_CAPS.why}`,
    `- snippet: ${SNIPPET_MAX_LINES} lines`,
  ].join('\n')
}

function diffsMarkdown(
  files: readonly FileEntry[],
  patches: Record<string, string>,
  maxLines: number,
  dir: string
): string {
  const lines = patchLineCount(patches)
  if (lines > maxLines) {
    return (
      `The diff has ${lines} lines, above the ${maxLines}-line inline limit, so it is not inlined. ` +
      `Read one file at a time from \`${dir}/<key>.diff\`; the keys are in the manifest.`
    )
  }
  // A binary or unchanged-content file has no patch text to show.
  return files
    .flatMap(f => {
      const patch = patches[f.key]
      return patch ? [`#### \`${f.path}\`\n\n\`\`\`\`diff\n${labelPatch(f.key, patch)}\n\`\`\`\``] : []
    })
    .join('\n\n')
}

async function rulebookMarkdown(ctx: AppContext): Promise<string> {
  const rel = ctx.projectConfig.config.rulebook
  const text = rel === undefined ? null : await readText(path.resolve(ctx.config.repoRoot, rel))
  if (text === null) {
    return ''
  }
  return `### Project rulebook\n\nThe project's own standards, as reference for the choices it already settles.\n\n${embedMarkdown(text)}`
}

/**
 * The change the deck is about, in the shape the canvas reads a pull request in: a pull request
 * fetched from the forge, or the branch or working tree of this clone.
 */
async function resolveDeckTarget(
  ctx: AppContext,
  input: { review: ReviewKey; base?: string | undefined },
  log: (phase: string) => void
): Promise<Pr> {
  if (!isLocalKey(input.review)) {
    return resolvePr(ctx, input.review, log)
  }
  log('snapshot')
  const base = await resolveLocalBase(ctx.git, input.base)
  return describeLocalWork(ctx.git, { base, source: input.review, repo: ctx.config.repo, now: ctx.now })
}

export async function prepareDeck(
  ctx: AppContext,
  input: { review: ReviewKey; base?: string | undefined; force: boolean },
  log: (phase: string) => void
): Promise<PrepareDeckResult> {
  const pr = await resolveDeckTarget(ctx, input, log)
  const base = pr.baseRef
  const workDir = ctx.decks.workDir(input.review)
  const promptPath = path.join(workDir, 'prompt.md')
  const modelPath = path.join(workDir, DECK_MODEL_FILE)
  const previous = await ctx.decks.readDeck(input.review)
  const { picks } = await ctx.decks.readPicks(input.review)
  const settled = settledFrom(previous, picks)
  const result = {
    review: input.review,
    headSha: pr.headSha,
    base,
    headRef: pr.headRef,
    uncommitted: pr.state === UNCOMMITTED_STATE,
    promptPath,
    modelPath,
    settled: settled.length,
  }
  if (!input.force && previous !== null && previous.headSha === pr.headSha) {
    return { ...result, status: 'exists', maxCards: 0 }
  }

  log('collect-diffs')
  const derived = await ctx.derived.ensure(pr.headSha, pr.mergeBaseSha)
  const changedLines = derived.files.reduce((n, f) => n + f.additions + f.deletions, 0)
  const maxCards = deckCardCap(changedLines, ctx.projectConfig.config.selfReview)
  const context: DeckContext = {
    version: 1,
    review: input.review,
    base,
    headRef: pr.headRef,
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
    files: derived.files,
    changedLines,
    maxCards,
    modelPath,
    settled,
    preparedAt: ctx.now().toISOString(),
  }

  log('prompt')
  const template = await loadPromptFile(DECK_PROMPT_FILE, undefined, {
    repoRoot: ctx.config.repoRoot,
    overrides: ctx.projectConfig.config.prompts,
  })
  const additions = derived.files.reduce((n, f) => n + f.additions, 0)
  const what =
    pr.number !== null
      ? `Pull request #${pr.number}: ${pr.title}`
      : result.uncommitted
        ? 'Uncommitted work'
        : 'Branch'
  const meta = [
    `- Repository: ${ctx.config.repo.owner}/${ctx.config.repo.name}`,
    `- ${what} · \`${pr.headRef}\` → \`${base}\``,
    `- Head: \`${pr.headSha}\` · merge base: \`${pr.mergeBaseSha}\``,
    `- Size: ${derived.files.length} files, +${additions} −${changedLines - additions}`,
  ].join('\n')
  const tokens: Record<string, string> = {
    TARGET_WORD:
      pr.number !== null
        ? `pull request #${pr.number}`
        : result.uncommitted
          ? 'uncommitted work'
          : 'a branch',
    REVIEW_FLAG: isLocalKey(input.review) ? `--${input.review}` : `--pr ${keyToString(input.review)}`,
    MODEL_PATH: modelPath,
    MAX_CARDS: String(maxCards),
    CHANGED_LINES: String(changedLines),
    SNIPPET_MAX_LINES: String(SNIPPET_MAX_LINES),
    SETTLED: settledMarkdown(settled),
    CAPS: capsMarkdown(),
    META: meta,
    MANIFEST: manifestMarkdown(derived.files),
    RULEBOOK: await rulebookMarkdown(ctx),
    DIFFS: diffsMarkdown(
      derived.files,
      derived.patches,
      ctx.projectConfig.config.generation.inlineDiffMaxLines,
      path.join(ctx.derived.derivedDir(pr.headSha), 'patches')
    ),
  }
  const prompt = template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, name: string) => tokens[name] ?? whole)
  await ctx.decks.clearWork(input.review)
  await writeTextAtomic(promptPath, prompt)
  await writeJsonAtomic(path.join(workDir, 'context.json'), context)
  return { ...result, status: 'prepared', maxCards }
}
