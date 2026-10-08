// Renders the seed that opens a chat thread: who the agent is, what the pull request changes,
// and where the code sits on disk. The prose lives in prompts/chat-seed.md.
import type { Pr, ReviewArtifact } from '../contract/review-artifact.js'
import { loadPromptFile, type ProjectPrompts } from '../prompt-files.js'
import { PROMPTS_DIR } from '../paths.js'
import { pointRef } from '../../static/js/proposed-comment.js'

/**
 * The agent's working directory for this turn: a review checkout at the reviewed commit, the
 * reader's working tree when that is the work under review, or the reader's checkout because
 * checkouts are turned off or this one failed (`fallback`, with why).
 */
export type CodeSource =
  | { kind: 'checkout'; cwd: string; sha: string }
  | { kind: 'working-tree'; cwd: string }
  | { kind: 'reader-checkout'; cwd: string }
  | { kind: 'fallback'; cwd: string; message: string; branch: string | null }

export interface SeedPaths {
  headDir: string
  baseDir: string
  patchDir: string
  repoRoot: string
  code: CodeSource
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
  return artifact.points
    .map(p => {
      const settled = artifact.settled?.[p.fingerprint]
      const answer = settled === undefined ? '' : ` — settled by the author: ${settled.reason}`
      return `- ${p.level} · ${p.kind} · for the ${p.audience} · ${p.title} (\`${p.path}:${p.line}\`) · point \`${pointRef(p.fingerprint)}\`${answer}`
    })
    .join('\n')
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

/** The "Where the code is" section: what the working directory holds, and where the rest is. */
export function codeLocationMarkdown(paths: SeedPaths): string {
  const sides = [
    `- base (the merge base) of each changed file: \`${paths.baseDir}\``,
    `- per-file patches: \`${paths.patchDir}\``,
  ]
  switch (paths.code.kind) {
    case 'checkout':
      return [
        `Your working directory, \`${paths.code.cwd}\`, is a checkout of the repository at the`,
        `reviewed commit \`${paths.code.sha.slice(0, 7)}\`. Read any file there, changed or not, for the`,
        'version under review. Git submodules are not checked out in it. The other side of the diff is',
        'materialized too:',
        '',
        ...sides,
        '',
        'The checkout holds tracked files only. Installed dependencies (`node_modules`, virtual',
        `environments, build output) are in the reader's checkout at \`${paths.repoRoot}\`. They follow`,
        "that checkout's lockfile, so when this pull request changes its dependencies, what is installed",
        'there may not be what the pull request uses. Say so when it matters to an answer.',
      ].join('\n')
    case 'working-tree':
      return [
        `Your working directory, \`${paths.repoRoot}\`, is the reader's own checkout, and its working`,
        'tree is the work under review, uncommitted edits included. The reader may keep editing while',
        'you answer. The other side of the diff is materialized:',
        '',
        ...sides,
      ].join('\n')
    case 'reader-checkout':
    case 'fallback':
      return [
        "The pull request's files are materialized on disk, so you can read either side without git:",
        '',
        `- head (the pull request's version): \`${paths.headDir}\``,
        ...sides,
        '',
        `Your working directory, \`${paths.repoRoot}\`, is the reader's own checkout, which may be on`,
        'another branch: a file the pull request did not change may differ there from what the pull',
        "request builds on. Prefer the materialized head when you want the pull request's version of a",
        'file.',
      ].join('\n')
  }
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
    CODE_LOCATION: codeLocationMarkdown(paths),
  }
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, token: string) => values[token] ?? whole)
}
