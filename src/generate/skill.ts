// The skill a generation from the review app follows. A project can tailor its copy of
// pr-review-canvas, so a run follows that copy, as the skill run from a terminal in the project
// would; a project with none follows the copy this package ships.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerationSkill } from '../contract/generation.js'
import type { ChatAgent } from '../contract/settings.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, SKILL_NAME, SKILL_SOURCE_DIR } from '../review/install-skill.js'
import { skillContent } from '../review/skill-content.js'
import { AppError } from '../server/errors.js'

export interface LoadedSkill {
  info: GenerationSkill
  /** The instructions, without the frontmatter. */
  body: string
}

async function readIfThere(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * The project's copy in the agent's own skills folder, else in the other harness's, else the
 * shipped one. A copy is `current` when its instructions are the shipped ones, `outdated` when
 * they are the ones an older pr-review installed (the body still matches the hash it was stamped
 * with), and `edited` otherwise.
 */
export async function loadGenerationSkill(
  repoRoot: string,
  agent: ChatAgent,
  version: string
): Promise<LoadedSkill> {
  const shipped = skillContent(await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8'))
  const dirs =
    agent === 'codex' ? [CODEX_SKILLS_DIR, CLAUDE_SKILLS_DIR] : [CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR]
  for (const dir of dirs) {
    const rel = path.join(dir, SKILL_NAME)
    let copy: ReturnType<typeof skillContent> | null
    try {
      const text = await readIfThere(path.join(repoRoot, rel, 'SKILL.md'))
      copy = text === null ? null : skillContent(text)
    } catch (err) {
      throw new AppError(
        'GENERATION_FAILED',
        `the project's skill at ${rel} cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        500,
        'fix it, or replace it with `pr-review install-skill --force`'
      )
    }
    if (copy === null) {
      continue
    }
    const stamped = copy.frontmatter.getIn(['metadata', 'body-sha256'])
    const state = copy.hash === shipped.hash ? 'current' : copy.hash === stamped ? 'outdated' : 'edited'
    return { info: { source: 'project', path: rel, state }, body: copy.body }
  }
  return { info: { source: 'default', version }, body: shipped.body }
}
