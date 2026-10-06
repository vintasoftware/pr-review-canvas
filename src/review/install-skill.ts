// `pr-review install-skill`: copy the bundled skill into the host repo's skill directories, so
// Claude Code (`.claude/skills`) and Codex (`.agents/skills`) both see `/pr-review-canvas`, and
// find the copies a project has, which doctor, upgrade, and generation read.
import { appendFile, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../paths.js'
import { readText } from '../store/atomic-json.js'
import type { SkillState } from '../contract/generation.js'
import { skillContent, skillState, stampSkill } from './skill-content.js'

export const SKILL_NAME = 'pr-review-canvas'
export const SKILL_SOURCE_DIR = path.join(PACKAGE_ROOT, 'skills', SKILL_NAME)
export const CLAUDE_SKILLS_DIR = '.claude/skills'
/** Codex reads repo skills from `.agents/skills` under the project root (codex-rs/ext/skills). */
export const CODEX_SKILLS_DIR = '.agents/skills'

export async function ignoreLocalSettings(repoRoot: string): Promise<void> {
  const file = path.join(repoRoot, '.gitignore')
  const text = (await readText(file)) ?? ''
  const entry = '.pr-review/settings.yml'
  if (text.split(/\r?\n/).some(line => line === entry || line === `/${entry}`)) {
    return
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const separator = text.length > 0 && !text.endsWith('\n') ? newline : ''
  await appendFile(file, `${separator}${entry}${newline}`, 'utf8')
}

export interface InstallSkillOptions {
  /** Absolute skills directories to install into; each gets `<dir>/pr-review-canvas`. */
  targets: Array<{ kind: 'claude' | 'codex'; dir: string }>
  source?: string
  /** Replace a real directory that already sits at the target. */
  force?: boolean
}

/** Preserve directories that were not created by the installer unless forced. */
export class SkillDirExistsError extends Error {
  readonly path: string

  constructor(target: string) {
    super(`${target} is a directory, not a managed copy of the bundled skill`)
    this.name = 'SkillDirExistsError'
    this.path = target
  }
}

export type InstallStatus = 'copied'

export interface InstallSkillResult {
  skill: string
  targets: Array<{ kind: 'claude' | 'codex'; path: string; status: InstallStatus }>
}

/** Inspect the entry without following a possibly dangling symlink. */
async function inspect(target: string): Promise<{ kind: 'none' } | { kind: 'link' } | { kind: 'other' }> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    return { kind: 'none' }
  }
  return stats.isSymbolicLink() ? { kind: 'link' } : { kind: 'other' }
}

/** A copy carries a marker file, so a later run can tell it from a hand-made directory. */
export const COPY_MARKER = '.pr-review-install'

async function installOne(
  source: string,
  dir: string,
  content: string,
  force: boolean
): Promise<{ path: string; status: InstallStatus }> {
  await mkdir(dir, { recursive: true })
  const realDir = await realpath(dir)
  const target = path.join(realDir, SKILL_NAME)
  const current = await inspect(target)
  if (current.kind === 'other' && !force && (await inspect(path.join(target, COPY_MARKER))).kind === 'none') {
    throw new SkillDirExistsError(target)
  }
  if (current.kind === 'other') {
    const realTarget = await realpath(target)
    if (source === realTarget || source.startsWith(`${realTarget}${path.sep}`)) {
      throw new Error('Cannot install a skill over its source directory')
    }
  }
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true, dereference: true })
  await writeFile(path.join(target, 'SKILL.md'), content, 'utf8')
  await writeFile(path.join(target, COPY_MARKER), 'pr-review managed skill copy\n', 'utf8')
  return { path: target, status: 'copied' }
}

export async function installSkill(opts: InstallSkillOptions): Promise<InstallSkillResult> {
  const source = await realpath(opts.source ?? SKILL_SOURCE_DIR)
  const content = stampSkill(await readFile(path.join(source, 'SKILL.md'), 'utf8'))
  const targets: InstallSkillResult['targets'] = []
  for (const t of opts.targets) {
    const done = await installOne(source, t.dir, content, opts.force === true)
    targets.push({ kind: t.kind, ...done })
  }
  return { skill: SKILL_NAME, targets }
}

export type ReadSkill = (file: string) => Promise<string | null>

const readSkillFile: ReadSkill = file => readFile(file, 'utf8')

/** One copy of the skill in the repository, next to how it compares with the bundled one. */
export type SkillCopy = {
  kind: 'claude' | 'codex'
  /** The skills directory the copy sits in, absolute. */
  dir: string
  /** `<dir>/pr-review-canvas`, relative to the repository. */
  path: string
} & (
  | {
      state: SkillState
      /** The instructions, without the frontmatter. */
      body: string
    }
  | {
      state: 'unreadable'
      /** Why the copy could not be read. */
      error: string
    }
)

/**
 * The copies of the skill in `.claude/skills` and `.agents/skills`. A directory without one is
 * left out. Throws when the bundled skill itself cannot be read.
 */
export async function findSkillCopies(
  repoRoot: string,
  readSkill: ReadSkill = readSkillFile
): Promise<SkillCopy[]> {
  const expected = skillContent(await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8')).hash
  const copies: SkillCopy[] = []
  for (const [kind, skillsDir] of [
    ['claude', CLAUDE_SKILLS_DIR],
    ['codex', CODEX_SKILLS_DIR],
  ] as const) {
    const dir = path.join(repoRoot, skillsDir)
    const target = path.join(dir, SKILL_NAME)
    const rel = path.relative(repoRoot, target)
    try {
      const text = await readSkill(path.join(target, 'SKILL.md'))
      if (text === null) continue
      const copy = skillContent(text)
      copies.push({ kind, dir, path: rel, state: skillState(copy, expected), body: copy.body })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        copies.push({
          kind,
          dir,
          path: rel,
          state: 'unreadable',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }
  return copies
}
