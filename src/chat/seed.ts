// Renders the seed that opens a chat thread: who the agent is, what the pull request changes,
// and where the code sits on disk. The prose lives in prompts/chat-seed.md.
import type { Pr, ReviewArtifact } from '../contract/review-artifact.js'
import { loadPromptFile, type ProjectPrompts } from '../prompt-files.js'
import { PROMPTS_DIR } from '../paths.js'

export interface SeedPaths {
  headDir: string
  baseDir: string
  patchDir: string
  repoRoot: string
}

export async function loadSeedTemplate(dir = PROMPTS_DIR, project?: ProjectPrompts): Promise<string> {
  return loadPromptFile('chat-seed.md', dir, project)
}

/** The pull request in six lines: what a reviewer would read before opening the diff. */
export function prMetaMarkdown(pr: Pr): string {
  const number = pr.number === null ? '(not opened yet)' : `#${pr.number}`
  return [
    `- ${number} **${pr.title}** by ${pr.author}`,
    `- \`${pr.headRef}\` → \`${pr.baseRef}\`, head \`${pr.headSha.slice(0, 7)}\``,
    `- ${pr.changedFiles} files changed, +${pr.additions} −${pr.deletions}`,
  ].join('\n')
}

export function layersMarkdown(artifact: ReviewArtifact): string {
  if (artifact.layers.length === 0) {
    return '_none_'
  }
  return artifact.layers
    .map(layer => {
      const files = layer.files.map(f => `  - \`${f.path}\``).join('\n')
      const other = layer.kind === 'other' ? ' (mechanical)' : ''
      return files === '' ? `- **${layer.title}**${other}` : `- **${layer.title}**${other}\n${files}`
    })
    .join('\n')
}

export function pointsMarkdown(artifact: ReviewArtifact): string {
  if (artifact.points.length === 0) {
    return '_none_'
  }
  return artifact.points.map(p => `- ${p.level} · ${p.kind} · ${p.title} (\`${p.path}:${p.line}\`)`).join('\n')
}

export function testsMarkdown(artifact: ReviewArtifact): string {
  const rows = artifact.layers.flatMap(layer =>
    layer.tests.map(t => {
      const where = t.testPath === undefined ? '' : ` — \`${t.testPath}\``
      return `- ${t.status} · ${t.behavior}${where}`
    })
  )
  return rows.length === 0 ? '_none_' : rows.join('\n')
}

/** Fills the template. Every token is replaced, so a template typo shows up as a missing section. */
export function renderSeed(template: string, artifact: ReviewArtifact, paths: SeedPaths): string {
  const values: Record<string, string> = {
    PR_META: prMetaMarkdown(artifact.pr),
    LAYERS: layersMarkdown(artifact),
    POINTS: pointsMarkdown(artifact),
    TESTS: testsMarkdown(artifact),
    HEAD_DIR: paths.headDir,
    BASE_DIR: paths.baseDir,
    PATCH_DIR: paths.patchDir,
    REPO_ROOT: paths.repoRoot,
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => values[token] ?? whole)
}
