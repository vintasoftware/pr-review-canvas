// The skill a generation from the review app follows. A project can tailor its copy of
// pr-review-canvas, so a run follows that copy, as the skill run from a terminal in the project
// would; a project with none follows the copy this package ships.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerationSkill } from '../contract/generation.js'
import type { ChatAgent } from '../contract/settings.js'
import { findSkillCopies } from '../review/doctor.js'
import { SKILL_SOURCE_DIR } from '../review/install-skill.js'
import { skillContent } from '../review/skill-content.js'
import { AppError } from '../server/errors.js'

export interface LoadedSkill {
  info: GenerationSkill
  /** The instructions, without the frontmatter. */
  body: string
}

/**
 * The project's copy in the agent's own skills folder, else in the other harness's, else the
 * shipped one. The copy's state is the one `doctor` and `upgrade` go by.
 */
export async function loadGenerationSkill(
  repoRoot: string,
  agent: ChatAgent,
  version: string
): Promise<LoadedSkill> {
  const copies = await findSkillCopies(repoRoot)
  const copy = copies.find(c => c.kind === agent) ?? copies[0]
  if (copy === undefined) {
    const shipped = skillContent(await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8'))
    return { info: { source: 'default', version }, body: shipped.body }
  }
  if (copy.state === 'unreadable') {
    throw new AppError(
      'GENERATION_FAILED',
      `the project's skill at ${copy.path} cannot be read: ${copy.error}`,
      500,
      'fix it, or replace it with `pr-review install-skill --force`'
    )
  }
  return { info: { source: 'project', path: copy.path, state: copy.state }, body: copy.body }
}
