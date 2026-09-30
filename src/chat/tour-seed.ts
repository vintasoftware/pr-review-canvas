// Renders the seed that opens a tour's grilling thread: who the agent is, what the tour says the
// change is, the decisions, and where the code sits on disk. The prose lives in
// prompts/tour-grill.md.
import type { TourArtifact } from '../contract/tour.js'
import { loadPromptFile, type ProjectPrompts } from '../prompt-files.js'
import { PROMPTS_DIR } from '../paths.js'
import { codeLocationMarkdown, prMetaMarkdown, type SeedPaths } from './seed.js'

export async function loadTourSeedTemplate(dir = PROMPTS_DIR, project?: ProjectPrompts): Promise<string> {
  return loadPromptFile('tour-grill.md', dir, project)
}

/** The landmarks as the tour tells them: the stage, the title, the lead, and the guards. */
export function landmarksMarkdown(tour: TourArtifact): string {
  return tour.landmarks
    .map(l => {
      const guards = l.guards.map(g => `\`${g.testPath}\` (${g.behavior})`).join(', ')
      return `- **${l.title}** (${l.stage}${l.state ? ', state landmark' : ''}): ${l.lead}${
        guards === '' ? '' : ` Guarded by ${guards}.`
      }`
    })
    .join('\n')
}

/** Every decision with its two sides, the recommendation, and where it points. */
export function decisionsMarkdown(tour: TourArtifact): string {
  if (tour.decisions.length === 0) return '_none_'
  return tour.decisions
    .map(d =>
      [
        `- \`${d.key}\` · ${d.category} · **${d.title}** (\`${d.anchor.path}:${d.anchor.line}\`)`,
        `  - keep: ${d.keep.label}. ${d.keep.consequence}`,
        `  - change: ${d.change.label}. ${d.change.consequence}`,
        `  - recommended: ${d.recommended}; the reason to keep: ${d.reason.text}`,
      ].join('\n')
    )
    .join('\n')
}

export function guideMarkdown(tour: TourArtifact): string {
  return tour.guide === null
    ? 'The project has no tour guide.'
    : `The project's tour guide is \`${tour.guide}\` at the head; it says how to run the app and what the agent may run.`
}

/** Fills the template. Every token is replaced, so a template typo shows up as a missing section. */
export function renderTourSeed(template: string, tour: TourArtifact, paths: SeedPaths): string {
  const values: Record<string, string> = {
    PR_META: prMetaMarkdown(tour.pr),
    LANDMARKS: landmarksMarkdown(tour),
    DECISIONS: decisionsMarkdown(tour),
    GUIDE: guideMarkdown(tour),
    HEAD_DIR: paths.headDir,
    BASE_DIR: paths.baseDir,
    PATCH_DIR: paths.patchDir,
    REPO_ROOT: paths.repoRoot,
    CODE_LOCATION: codeLocationMarkdown(paths),
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => values[token] ?? whole)
}
