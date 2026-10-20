// Renders a tour's prompt.md from `prompts/tour.md` and the prepared context. The template carries
// the prose; this module fills the `{{TOKENS}}` with data so a wording change never touches code.
import { z } from 'zod'
import type { TourContext } from '../contract/tour.js'
import { type DecisionCategory, TOUR_LIMITS, tourModelSchema } from '../contract/tour.js'
import { labelPatch } from '../git/patch-lines.js'
import {
  bodyMarkdown,
  embedMarkdown,
  manifestMarkdown,
  metaMarkdown,
  patchLineCount,
} from '../review/prompt.js'

const INLINE_DIFF_MAX_LINES = 1500

const CATEGORY_TEXT: Record<DecisionCategory, string> = {
  'trade-off':
    'Trade-offs: rare cases, compatibility, generality, failure policy, performance against plainness, reversibility, and accepting a test gap.',
  architecture:
    'Architecture and shape: where logic lives, reuse against build, new pattern against convention, public names.',
  product: 'Product and feel: UI, UX, copy, animation, perceived performance, accessibility.',
  pokayoke: 'Pokayoke: what the change makes impossible to get wrong, and where it lacks such a structure.',
  nfr: "The project's non-functional requirements, as the guide names them.",
  spec: 'Spec fidelity: where the change departs from the spec or the design it was built from.',
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
    return `_The project has no guide at \`${ctx.guide.path ?? 'docs/pr-tour.md'}\`, so write no try-it recipes and name non-functional requirements only where the code makes them plain._`
  }
  return `The guide (\`${ctx.guide.path ?? ''}\`) is the project's committed notes for tours: how to run the app, how to make synthetic data, which non-functional requirements matter, where specs live, and what you may run. It is an allowlist: run nothing it does not name without asking.\n\n${embedMarkdown(ctx.guide.text)}\n\nEnd of the guide.`
}

function budgetMarkdown(ctx: TourContext): string {
  const b = ctx.budget
  const radius = ctx.blastRadius.length === 0 ? 'none of the high-risk areas' : ctx.blastRadius.join(', ')
  return [
    `- Blast radius: **${radius}** (from the project's \`highRisk\` patterns: ${ctx.highRisk.length === 0 ? 'none configured' : ctx.highRisk.map(r => `\`${r.pattern}\` → ${r.label}`).join(', ')})`,
    `- Landmarks: the background, the world, and the respect landmark, one each, and at most **${b.why} why ${b.why === 1 ? 'landmark' : 'landmarks'}**. One more why landmark is allowed only with \`overBudget\` saying why this change needs it, and never more than **${b.whyMax}**: past that, merge the two most closely related why landmarks into one. The state landmark, when required, does not count.`,
    `- Decisions: at most one more than the why landmarks you write, and never more than **${b.decisions}**. Quiz questions: at most one fewer than the landmarks you write (at least 2), and never more than **${b.quiz}**.`,
    ctx.stateRequired
      ? '- **A state landmark is required**: the change touches stored data. Mark it `"state": true`; it says how the change is undone, with a reversibility decision when undoing it is not clean.'
      : '- No state landmark is required, unless you find the change touches a schema, a migration, or the shape of stored data: then add one, marked `"state": true`.',
  ].join('\n')
}

function capsMarkdown(ctx: TourContext): string {
  const c = ctx.caps
  return [
    `- landmark title: ${c.landmarkTitle}; lead: ${c.lead}; each body paragraph and literate paragraph: ${c.paragraph}; a body: ${TOUR_LIMITS.bodyParagraphs} paragraphs`,
    `- decision title: ${c.decisionTitle}; context: ${c.context}; each side's label: ${c.sideLabel}; consequence: ${c.consequence}`,
    `- quiz question: ${c.question}; option: ${c.option}; why: ${c.why}`,
    `- try-it step or look line: ${c.tryItLine}; not-toured title: ${c.notToured}`,
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
    `- \`<scenes>\` = \`${ctx.scenesDir}\` — one \`<landmark id>.scene.html\` per landmark, and at most ${TOUR_LIMITS.microWorlds} \`<landmark id>.micro.html\``,
  ].join('\n')
}

/** The files of one side of the delta, as inline code, or a word when there are none. */
function pathList(paths: string[]): string {
  return paths.length === 0 ? 'none' : paths.map(p => `\`${p}\``).join(', ')
}

/**
 * The earlier tour this one updates, and how to update it; empty when the tour starts blank. A
 * change the reader asked for in the earlier tour may have rebuilt the implementation, so nothing is
 * kept because it was there: what the head left untouched carries, the rest is judged again.
 */
function basisMarkdown(ctx: TourContext): string {
  const basis = ctx.basis
  if (basis === undefined) return ''
  const f = basis.files
  return [
    '## The earlier tour',
    '',
    `This head builds on \`${basis.tourSha}\`, an ancestor that already has a tour. Update that tour rather than writing one from a blank page. Its model is \`${basis.modelPath}\`, in the form \`<model>\` takes, and its pictures are in \`${basis.scenesDir}\`, named as \`<scenes>\` names them. Read both before you plan.`,
    '',
    `Against the earlier tour's diff, these files of this diff are unchanged: ${pathList(f.unchanged)}; changed: ${pathList(f.changed)}; new: ${pathList(f.added)}. These are gone from the diff: ${pathList(f.removed)}.`,
    '',
    "- **Carry** a landmark, decision, or question whose code names only unchanged files: keep its text, its id or key, and its picture (copy the file from the earlier tour's pictures into `<scenes>`). Its hunk ids and line numbers follow the head's diff.",
    '- **Judge again** everything that names a changed, new, or gone file: rewrite it, redraw its picture, drop it, or write a new one. The new commits may have carried out a change a reader asked for in the earlier tour, and rebuilt the code around it.',
    "- Keep the `key` of a decision that still stands, so the reader's pick carries to this tour. A decision the new commits settled, by taking its alternative or something else, is no longer open: drop it, or write the new trade-off under a new key.",
    '- The background and the world landmarks describe the whole change as it is now, not what changed since the earlier tour.',
    '- The budget, the caps, and every rule below hold as for a new tour; carried content counts against them.',
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
    BODY: bodyMarkdown(ctx.pr),
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
      ? `Up to ${TOUR_LIMITS.microWorlds} landmarks may carry a micro-world, when the change has behavior worth playing with: a faithful model of the changed behavior the reader drives. Write it as \`<scenes>/<landmark id>.micro.html\`. A micro-world may stand in for its landmark's scene, except on the background: then write no \`.scene.html\` for that landmark.`
      : 'Micro-worlds are off for this project (`tour.microWorld`): write no `.micro.html` file.',
    TRY_IT: ctx.options.tryIt
      ? 'A product decision carries a `tryIt` recipe: the commands to run the change (from the guide, as the reader runs them), which synthetic data to use, and what to look at. Before publishing, run the recipe yourself in the head checkout, with its `port` and `scratch`, and set `verified: true` only when you saw what `look` describes; a recipe you could not run is left out. A step is one line: a bare command shows as code; a step in words (open a page, pick a layer) marks its commands with backticks.'
      : 'Try-it recipes are off (`tour.tryIt`, or the guide has no run recipe): write no `tryIt`.',
    MAX_REPAIR_ROUNDS: String(ctx.maxRepairRounds),
    BASIS: basisMarkdown(ctx),
    SCHEMA: tourSchemaMarkdown(ctx),
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => {
    const value = tokens[name]
    if (value === undefined) throw new Error(`tour.md uses an unknown token {{${name}}}`)
    return value
  })
}
