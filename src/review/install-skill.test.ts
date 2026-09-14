// @vitest-environment node
import { lstat, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { makeTempDir } from '../testing/fakes.js'
import { COPY_MARKER, installSkill, SKILL_SOURCE_DIR, SkillDirExistsError } from './install-skill.js'

let dir: string
beforeEach(async () => {
  dir = await realpath(await makeTempDir())
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('installSkill', () => {
  it('links the bundled skill into both directories with a relative target, then reports exists', async () => {
    const targets = [
      { kind: 'claude' as const, dir: path.join(dir, '.claude', 'skills') },
      { kind: 'codex' as const, dir: path.join(dir, '.agents', 'skills') },
    ]
    const first = await installSkill({ targets, platform: 'linux' })
    const claude = path.join(dir, '.claude', 'skills', 'pr-review-canvas')
    const codex = path.join(dir, '.agents', 'skills', 'pr-review-canvas')
    expect(first).toEqual({
      skill: 'pr-review-canvas',
      targets: [
        { kind: 'claude', path: claude, status: 'linked' },
        { kind: 'codex', path: codex, status: 'linked' },
      ],
    })
    const source = await realpath(SKILL_SOURCE_DIR)
    expect(await readlink(claude)).toBe(path.relative(path.dirname(claude), source))
    expect(await readFile(path.join(claude, 'SKILL.md'), 'utf8')).toContain('name: pr-review-canvas')
    expect(await readFile(path.join(codex, 'SKILL.md'), 'utf8')).toContain('name: pr-review-canvas')
    const second = await installSkill({ targets, platform: 'linux' })
    expect(second.targets.map(t => t.status)).toEqual(['exists', 'exists'])
  })

  it('replaces a link that points elsewhere, but refuses a real directory unless forced', async () => {
    const skills = path.join(dir, 'skills')
    await mkdir(skills, { recursive: true })
    await symlink('../elsewhere', path.join(skills, 'pr-review-canvas'))
    const relinked = await installSkill({ targets: [{ kind: 'claude', dir: skills }], platform: 'linux' })
    expect(relinked.targets[0]?.status).toBe('replaced')
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toContain('pr-review-canvas')
    await rm(path.join(skills, 'pr-review-canvas'))
    await mkdir(path.join(skills, 'pr-review-canvas'))
    await writeFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'my customized copy')
    const err = await installSkill({ targets: [{ kind: 'claude', dir: skills }], platform: 'linux' }).catch(e => e)
    expect(err).toBeInstanceOf(SkillDirExistsError)
    expect(err).toMatchObject({ path: path.join(skills, 'pr-review-canvas') })
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toBe('my customized copy')
    const forced = await installSkill({ targets: [{ kind: 'claude', dir: skills }], platform: 'linux', force: true })
    expect(forced.targets[0]?.status).toBe('replaced')
    expect((await lstat(path.join(skills, 'pr-review-canvas'))).isSymbolicLink()).toBe(true)
  })

  it('copies instead of linking on Windows, refreshes its own copy, and refuses a hand-made directory', async () => {
    const skills = path.join(dir, 'skills')
    const copied = await installSkill({ targets: [{ kind: 'codex', dir: skills }], platform: 'win32' })
    expect(copied.targets).toEqual([{ kind: 'codex', path: path.join(skills, 'pr-review-canvas'), status: 'copied' }])
    expect((await lstat(path.join(skills, 'pr-review-canvas'))).isDirectory()).toBe(true)
    expect((await lstat(path.join(skills, 'pr-review-canvas', COPY_MARKER))).isFile()).toBe(true)
    await writeFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'stale')
    await installSkill({ targets: [{ kind: 'codex', dir: skills }], platform: 'win32' })
    expect(await readFile(path.join(skills, 'pr-review-canvas', 'SKILL.md'), 'utf8')).toContain(
      'name: pr-review-canvas'
    )
    await rm(path.join(skills, 'pr-review-canvas', COPY_MARKER))
    await expect(installSkill({ targets: [{ kind: 'codex', dir: skills }], platform: 'win32' })).rejects.toBeInstanceOf(
      SkillDirExistsError
    )
  })

  it('accepts another source directory', async () => {
    const source = path.join(dir, 'my-skill')
    await mkdir(source)
    await writeFile(path.join(source, 'SKILL.md'), 'custom')
    const result = await installSkill({
      targets: [{ kind: 'claude', dir: path.join(dir, 's') }],
      source,
      platform: 'linux',
    })
    expect(result.targets[0]?.status).toBe('linked')
    expect(await readFile(path.join(dir, 's', 'pr-review-canvas', 'SKILL.md'), 'utf8')).toBe('custom')
  })
})
