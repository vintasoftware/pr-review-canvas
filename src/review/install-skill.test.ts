// @vitest-environment node
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makeTempDir } from '../testing/fakes.js'
import { checkSkill } from './doctor.js'
import { skillContent } from './skill-content.js'
import { COPY_MARKER, installSkill, SKILL_SOURCE_DIR, SkillDirExistsError } from './install-skill.js'

let dir: string
beforeEach(async () => {
  dir = await realpath(await makeTempDir())
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('installSkill', () => {
  it('copies the bundled skill into both directories and can reinstall', async () => {
    const targets = [
      { kind: 'claude' as const, dir: path.join(dir, '.claude', 'skills') },
      { kind: 'codex' as const, dir: path.join(dir, '.agents', 'skills') },
    ]
    const first = await installSkill({ targets })
    const claude = path.join(dir, '.claude', 'skills', 'pr-review-canvas')
    const codex = path.join(dir, '.agents', 'skills', 'pr-review-canvas')
    expect(first).toEqual({
      skill: 'pr-review-canvas',
      targets: [
        { kind: 'claude', path: claude, status: 'copied' },
        { kind: 'codex', path: codex, status: 'copied' },
      ],
    })
    expect((await lstat(claude)).isSymbolicLink()).toBe(false)
    const installed = skillContent(await readFile(path.join(claude, 'SKILL.md'), 'utf8'))
    expect(installed.frontmatter.getIn(['metadata', 'body-sha256'])).toBe(installed.hash)
    expect(installed.hash).toBe(
      skillContent(await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8')).hash
    )
    expect(await readFile(path.join(claude, COPY_MARKER), 'utf8')).not.toContain(SKILL_SOURCE_DIR)
    expect(await readFile(path.join(claude, 'SKILL.md'), 'utf8')).toContain('name: pr-review-canvas')
    expect(await readFile(path.join(codex, 'SKILL.md'), 'utf8')).toContain('name: pr-review-canvas')
    const second = await installSkill({ targets })
    expect(second.targets.map(t => t.status)).toEqual(['copied', 'copied'])
  })

  it('replaces a link that points elsewhere, but refuses a real directory unless forced', async () => {
    const skills = path.join(dir, 'skills')
    await mkdir(skills, { recursive: true })
    await symlink('../elsewhere', path.join(skills, 'pr-review-canvas'))
    const relinked = await installSkill({ targets: [{ kind: 'claude', dir: skills }] })
    expect(relinked.targets[0]?.status).toBe('copied')
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toContain(
      'pr-review-canvas'
    )
    await rm(path.join(skills, 'pr-review-canvas'), { recursive: true })
    await mkdir(path.join(skills, 'pr-review-canvas'))
    await writeFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'my customized copy')
    const err = await installSkill({ targets: [{ kind: 'claude', dir: skills }] }).catch(e => e)
    expect(err).toBeInstanceOf(SkillDirExistsError)
    expect(err).toMatchObject({ path: path.join(skills, 'pr-review-canvas') })
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toBe(
      'my customized copy'
    )
    const forced = await installSkill({ targets: [{ kind: 'claude', dir: skills }], force: true })
    expect(forced.targets[0]?.status).toBe('copied')
    expect((await lstat(path.join(skills, 'pr-review-canvas'))).isSymbolicLink()).toBe(false)
  })

  it('refreshes its own copy and refuses a hand-made directory', async () => {
    const skills = path.join(dir, 'skills')
    const copied = await installSkill({ targets: [{ kind: 'codex', dir: skills }] })
    expect(copied.targets).toEqual([
      { kind: 'codex', path: path.join(skills, 'pr-review-canvas'), status: 'copied' },
    ])
    expect((await lstat(path.join(skills, 'pr-review-canvas'))).isDirectory()).toBe(true)
    expect((await lstat(path.join(skills, 'pr-review-canvas', COPY_MARKER))).isFile()).toBe(true)
    await writeFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'stale')
    await installSkill({ targets: [{ kind: 'codex', dir: skills }] })
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toContain(
      'name: pr-review-canvas'
    )
    await rm(path.join(skills, 'pr-review-canvas', COPY_MARKER))
    await expect(installSkill({ targets: [{ kind: 'codex', dir: skills }] })).rejects.toBeInstanceOf(
      SkillDirExistsError
    )
  })

  it('copies into a shared, repo-local skills directory through both harness links', async () => {
    const shared = path.join(dir, 'ai-tools', 'skills')
    await mkdir(shared, { recursive: true })
    for (const harness of ['.claude', '.agents']) {
      await mkdir(path.join(dir, harness))
      await symlink('../ai-tools/skills', path.join(dir, harness, 'skills'))
    }
    const targets = [
      { kind: 'claude' as const, dir: path.join(dir, '.claude/skills') },
      { kind: 'codex' as const, dir: path.join(dir, '.agents/skills') },
    ]
    await installSkill({ targets })
    expect((await lstat(path.join(shared, 'pr-review-canvas'))).isDirectory()).toBe(true)
    expect((await checkSkill(dir)).ok).toBe(true)
    await writeFile(path.join(shared, 'pr-review-canvas', 'SKILL.md'), 'old skill')
    expect((await checkSkill(dir)).ok).toBe(false)
    await installSkill({ targets })
    expect((await checkSkill(dir)).ok).toBe(true)
  })

  it('accepts another source directory', async () => {
    const source = path.join(dir, 'my-skill')
    await mkdir(source)
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: custom\n---\ncustom')
    const result = await installSkill({
      targets: [{ kind: 'claude', dir: path.join(dir, 's') }],
      source,
    })
    await rm(source, { recursive: true })
    expect(result.targets[0]?.status).toBe('copied')
    expect(await readFile(path.join(dir, 's', 'pr-review-canvas', 'SKILL.md'), 'utf8')).toContain('custom')
  })
})
