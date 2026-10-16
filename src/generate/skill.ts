// The skill a generation from the review app follows: pr-review-canvas for a canvas, pr-tour for a
// tour. A project can tailor its copy, so a run follows that copy, as the skill run from a terminal
// in the project would; a project with none follows the copy this package ships.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { GenerationSkill } from '../contract/generation.js'
import type { ChatAgent } from '../contract/settings.js'
import { findSkillCopies, SKILL_NAME, skillSourceDir } from '../review/install-skill.js'
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
  version: string,
  name: string = SKILL_NAME
): Promise<LoadedSkill> {
  const copies = await findSkillCopies(repoRoot)
  const named = copies.flatMap(c => (c.skill === name && c.state !== 'missing' ? [c] : []))
  const copy = named.find(c => c.kind === agent) ?? named[0]
  if (copy === undefined) {
    const shipped = skillContent(await readFile(path.join(skillSourceDir(name), 'SKILL.md'), 'utf8'))
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
