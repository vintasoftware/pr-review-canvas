import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_SOURCE_DIR } from '../review/install-skill.js'
import { skillContent, stampSkill } from '../review/skill-content.js'
import { AppError } from '../server/errors.js'
import { loadGenerationSkill } from './skill.js'

const CLAUDE = '.claude/skills/pr-review-canvas'
const CODEX = '.agents/skills/pr-review-canvas'

let repoRoot: string
let shippedText: string

beforeEach(async () => {
  repoRoot = await mkdtemp(path.join(os.tmpdir(), 'pr-review-skill-'))
  shippedText = await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8')
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

/** Writes a project copy of the skill, as `install-skill` lays it out. */
async function writeCopy(rel: string, text: string): Promise<void> {
  await mkdir(path.join(repoRoot, rel), { recursive: true })
  await writeFile(path.join(repoRoot, rel, 'SKILL.md'), text, 'utf8')
}

/** The shipped skill as `install-skill` writes it: stamped with its body's hash. */
function installed(): string {
  return stampSkill(shippedText)
}

/** What another pr-review version installed: its own body, stamped with that body's hash. */
function otherVersionInstall(): string {
  return stampSkill(shippedText.replace('# pr-review-canvas', '# pr-review-canvas (another wording)'))
}

/** A stamped copy whose body the project then changed. */
function edited(): string {
  return `${installed()}\n## Our house rules\n\nName every migration.\n`
}

describe('loadGenerationSkill', () => {
  it('follows the shipped skill, named by the server version, when the project has none', async () => {
    const skill = await loadGenerationSkill(repoRoot, 'claude', '1.2.3')
    expect(skill.info).toEqual({ source: 'default', version: '1.2.3' })
    expect(skill.body).toBe(skillContent(shippedText).body)
    expect(skill.body.startsWith('---')).toBe(false)
    expect(skill.body).toContain('# pr-review-canvas')
  })

  it('tells a current, an other-version, and an edited project copy apart', async () => {
    await writeCopy(CLAUDE, installed())
    const current = await loadGenerationSkill(repoRoot, 'claude', '1.2.3')
    expect(current.info).toEqual({ source: 'project', path: CLAUDE, state: 'current' })
    expect(current.body).toBe(skillContent(shippedText).body)

    await writeCopy(CLAUDE, otherVersionInstall())
    const otherVersion = await loadGenerationSkill(repoRoot, 'claude', '1.2.3')
    expect(otherVersion.info).toEqual({ source: 'project', path: CLAUDE, state: 'other-version' })
    expect(otherVersion.body).toContain('# pr-review-canvas (another wording)')

    await writeCopy(CLAUDE, edited())
    const changed = await loadGenerationSkill(repoRoot, 'claude', '1.2.3')
    expect(changed.info).toEqual({ source: 'project', path: CLAUDE, state: 'edited' })
    expect(changed.body).toContain('Name every migration.')
    expect(changed.body).not.toContain('body-sha256')
  })

  it('counts any unstamped copy as edited, as doctor does, the shipped body included', async () => {
    await writeCopy(CLAUDE, shippedText)
    expect((await loadGenerationSkill(repoRoot, 'claude', '1')).info).toMatchObject({ state: 'edited' })
    await writeCopy(CLAUDE, '---\nname: pr-review-canvas\n---\nOur own skill.\n')
    const own = await loadGenerationSkill(repoRoot, 'claude', '1')
    expect(own.info).toMatchObject({ state: 'edited' })
    expect(own.body).toBe('Our own skill.\n')
  })

  it('reads a CRLF checkout of the shipped skill as current', async () => {
    await writeCopy(CODEX, installed().replace(/\n/g, '\r\n'))
    expect((await loadGenerationSkill(repoRoot, 'codex', '1')).info).toMatchObject({ state: 'current' })
  })

  it("looks in claude's folder first for claude, then in codex's", async () => {
    await writeCopy(CODEX, edited())
    expect((await loadGenerationSkill(repoRoot, 'claude', '1')).info).toEqual({
      source: 'project',
      path: CODEX,
      state: 'edited',
    })
    await writeCopy(CLAUDE, installed())
    expect((await loadGenerationSkill(repoRoot, 'claude', '1')).info).toEqual({
      source: 'project',
      path: CLAUDE,
      state: 'current',
    })
  })

  it("looks in codex's folder first for codex, then in claude's", async () => {
    await writeCopy(CLAUDE, otherVersionInstall())
    expect((await loadGenerationSkill(repoRoot, 'codex', '1')).info).toEqual({
      source: 'project',
      path: CLAUDE,
      state: 'other-version',
    })
    await writeCopy(CODEX, installed())
    expect((await loadGenerationSkill(repoRoot, 'codex', '1')).info).toEqual({
      source: 'project',
      path: CODEX,
      state: 'current',
    })
  })

  it('refuses a copy with no frontmatter, naming its path and how to replace it', async () => {
    await writeCopy(CLAUDE, '# Just instructions\n')
    const err = await loadGenerationSkill(repoRoot, 'claude', '1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'GENERATION_FAILED', status: 500 })
    expect((err as AppError).message).toContain(CLAUDE)
    expect((err as AppError).message).toContain('missing YAML frontmatter')
    expect((err as AppError).hint).toContain('pr-review install-skill --force')
  })

  it('refuses a copy it cannot read, without falling back to the other folder', async () => {
    // A directory where SKILL.md should be cannot be read, and is no missing file.
    await mkdir(path.join(repoRoot, CODEX, 'SKILL.md'), { recursive: true })
    await writeCopy(CLAUDE, installed())
    const err = await loadGenerationSkill(repoRoot, 'codex', '1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(err).toMatchObject({ code: 'GENERATION_FAILED' })
    expect((err as AppError).message).toContain(`the project's skill at ${CODEX} cannot be read`)
    expect((err as AppError).hint).toContain('pr-review install-skill --force')
  })
})
