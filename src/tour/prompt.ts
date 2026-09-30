// Renders a tour's prompt.md from `prompts/tour.md` and the prepared context. The template carries
// the prose; this module fills the `{{TOKENS}}` with data so a wording change never touches code.
import { z } from 'zod'
import type { TourContext } from '../contract/tour.js'
import { DECISION_CATEGORIES, tourModelSchema } from '../contract/tour.js'
import { labelPatch } from '../git/patch-lines.js'
import { embedMarkdown, manifestMarkdown, patchLineCount } from '../review/prompt.js'

const INLINE_DIFF_MAX_LINES = 1500

const CATEGORY_TEXT: Record<(typeof DECISION_CATEGORIES)[number], string> = {
  'trade-off':
    'Trade-offs: rare cases, compatibility, generality, failure policy, performance against plainness, reversibility, and accepting a test gap.',
  architecture:
    'Architecture and shape: where logic lives, reuse against build, new pattern against convention, public names.',
  product: 'Product and feel: UI, UX, copy, animation, perceived performance, accessibility.',
  pokayoke: 'Pokayoke: what the change makes impossible to get wrong, and where it lacks such a structure.',
  nfr: "The project's non-functional requirements, as the guide names them.",
  spec: 'Spec fidelity: where the change departs from the spec or the design it was built from.',
}

function metaMarkdown(ctx: TourContext): string {
  const pr = ctx.pr
  const number = pr.number === null ? 'no pull request yet' : `#${pr.number}`
  return [
    `- Repository: ${ctx.repo.owner}/${ctx.repo.name}`,
    ...(ctx.target.kind === 'refs'
      ? ['- Ref comparison']
      : [
          `- ${ctx.target.kind === 'pr' ? 'Pull request' : 'Change set'}: ${number} — ${pr.title}`,
          `- Author: ${pr.author} · state: ${pr.state}${pr.draft ? ' (draft)' : ''}`,
        ]),
    `- Base: \`${pr.baseRef}\` → head: \`${pr.headRef}\``,
    `- Head: \`${ctx.headSha}\` · merge base: \`${ctx.mergeBaseSha}\``,
    `- Size: ${pr.changedFiles} files, +${pr.additions} −${pr.deletions}`,
  ].join('\n')
}

function bodyMarkdown(ctx: TourContext): string {
  const body = ctx.pr.body.trim()
  return body === '' ? '_No description._' : `> ${body.replace(/\n/g, '\n> ')}`
}

function diffsMarkdown(ctx: TourContext, patches: Record<string, string>): string {
  const lines = patchLineCount(patches)
  if (lines <= INLINE_DIFF_MAX_LINES) {
    const inline = ctx.files
      .filter(f => (patches[f.key] ?? '') !== '')
      .map(f => `#### \`${f.path}\`\n\n\`\`\`\`diff\n${labelPatch(f.key, patches[f.key] ?? '')}\n\`\`\`\``)
      .join('\n\n')
    return `The whole diff follows (${lines} lines). Every hunk is labeled with its id.\n\n${inline}`
  }
  return (
    `The diff has ${lines} lines, above the ${INLINE_DIFF_MAX_LINES}-line inline limit, so it is not inlined. ` +
    'Read one file at a time from `<patches>/<key>.diff`; each file carries the same `### hunk <id>` labels the manifest uses.'
  )
}

function guideMarkdown(ctx: TourContext): string {
  if (ctx.guide.text === null) {
    return `_The project has no guide at \`${ctx.guide.path ?? 'docs/pr-tour.md'}\`. Run \`/pr-tour-setup\` to write one; without it, skip the try-it recipes and name non-functional requirements only where the code makes them plain._`
  }
  return `The guide (\`${ctx.guide.path ?? ''}\`) is the project's committed notes for tours: how to run the app, how to make synthetic data, which non-functional requirements matter, where specs live, and what you may run. It is an allowlist: run nothing it does not name without asking.\n\n${embedMarkdown(ctx.guide.text)}\n\nEnd of the guide.`
}

function budgetMarkdown(ctx: TourContext): string {
  const b = ctx.budget
  const radius = ctx.blastRadius.length === 0 ? 'none of the high-risk areas' : ctx.blastRadius.join(', ')
  return [
    `- Blast radius: **${radius}** (from the project's \`highRisk\` patterns: ${ctx.highRisk.length === 0 ? 'none configured' : ctx.highRisk.map(r => `\`${r.pattern}\` → ${r.label}`).join(', ')})`,
    `- At most **${b.landmarks} landmarks** (the state landmark, when required, does not count), **${b.decisions} decisions**, **${b.quiz} quiz questions**.`,
    ctx.stateRequired
      ? '- **A state landmark is required**: the change touches stored data. Mark it `"state": true`; it always carries a reversibility decision.'
      : '- No state landmark is required, unless you find the change touches a schema, a migration, or the shape of stored data: then add one, marked `"state": true`.',
  ].join('\n')
}

function capsMarkdown(ctx: TourContext): string {
  const c = ctx.caps
  return [
    `- landmark title: ${c.landmarkTitle}; lead: ${c.lead}; each body paragraph and literate paragraph: ${c.paragraph}`,
    `- decision title: ${c.decisionTitle}; context: ${c.context}; each side's label: ${c.sideLabel}; consequence: ${c.consequence}; reason: ${c.reason}`,
    `- quiz question: ${c.question}; option: ${c.option}; why: ${c.why}`,
    `- guard behavior: ${c.guardBehavior}; try-it step or look line: ${c.tryItLine}; not-toured title: ${c.notToured}`,
    '- a scene or micro-world: 12,000 characters of HTML; a code chunk: 6,000 characters of diff',
  ].join('\n')
}

function categoriesMarkdown(ctx: TourContext): string {
  return ctx.categories.map(c => `- \`${c}\`: ${CATEGORY_TEXT[c]}`).join('\n')
}

function pathsMarkdown(ctx: TourContext): string {
  return [
    `- \`<tourDir>\` = \`${ctx.tourDir}\``,
    `- \`<head>\` = \`${ctx.paths.head}\` — the changed files as they are at the head`,
    `- \`<base>\` = \`${ctx.paths.base}\` — the same files at the merge base`,
    `- \`<patches>\` = \`${ctx.paths.patches}\` — one labeled patch per file, \`<key>.diff\``,
    `- \`<model>\` = \`${ctx.paths.model}\` — the one JSON file you write`,
    `- \`<scenes>\` = \`${ctx.scenesDir}\` — one \`<landmark id>.scene.html\` per landmark, and at most one \`<landmark id>.micro.html\``,
  ].join('\n')
}

export function tourSchemaMarkdown(ctx: TourContext): string {
  const schema = z.toJSONSchema(tourModelSchema(ctx.caps))
  return `\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``
}

export interface TourPromptExtras {
  /** The scene guide the generator reads before drawing, absolute. */
  sceneGuidePath: string
}

/** Fills the template's tokens. Throws on a token the template names that this module does not. */
export function renderTourPrompt(
  ctx: TourContext,
  patches: Record<string, string>,
  template: string,
  extras: TourPromptExtras
): string {
  const tokens: Record<string, string> = {
    TARGET_WORD: ctx.target.kind === 'pr' ? 'pull request' : 'change set',
    META: metaMarkdown(ctx),
    BODY: bodyMarkdown(ctx),
    HEAD_SHA: ctx.headSha,
    MERGE_BASE_SHA: ctx.mergeBaseSha,
    PATHS: pathsMarkdown(ctx),
    MODEL_PATH: ctx.paths.model,
    SCENES_DIR: ctx.scenesDir,
    MANIFEST: manifestMarkdown(ctx.files),
    DIFFS: diffsMarkdown(ctx, patches),
    GUIDE: guideMarkdown(ctx),
    BUDGET: budgetMarkdown(ctx),
    CAPS: capsMarkdown(ctx),
    CATEGORIES: categoriesMarkdown(ctx),
    TEST_PATTERNS:
      ctx.tests.patterns.length === 0
        ? 'no pattern, so no file counts as a test here'
        : ctx.tests.patterns.map(p => `\`${p}\``).join(', '),
    SCENE_GUIDE: extras.sceneGuidePath,
    MICRO_WORLD: ctx.options.microWorld
      ? 'One landmark may carry a micro-world, when the change has behavior worth playing with: a faithful model of the changed behavior with a few controls in front of it. Write it as `<scenes>/<landmark id>.micro.html`.'
      : 'Micro-worlds are off for this project (`tour.microWorld`): write no `.micro.html` file.',
    TRY_IT: ctx.options.tryIt
      ? 'A product decision carries a `tryIt` recipe: the commands to run the change (from the guide), which synthetic data to use, and what to look at. Before publishing, run the recipe yourself and set `verified: true` only when you saw what `look` describes; a recipe you could not run is left out.'
      : 'Try-it recipes are off (`tour.tryIt`, or the guide has no run recipe): write no `tryIt`.',
    MAX_REPAIR_ROUNDS: String(ctx.maxRepairRounds),
    SCHEMA: tourSchemaMarkdown(ctx),
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const value = tokens[name]
    if (value === undefined) throw new Error(`tour.md uses an unknown token {{${name}}}`)
    return value
  })
}
