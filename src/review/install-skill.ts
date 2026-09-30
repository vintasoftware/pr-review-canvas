// `pr-review install-skill`: copy the bundled skills into the host repo's skill directories, so
// Claude Code (`.claude/skills`) and Codex (`.agents/skills`) both see them.
import { appendFile, cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../server/context.js'
import { readText } from '../store/atomic-json.js'
import { stampSkill } from './skill-content.js'

/** The canvas skill: the first one, and the one whose presence says a project is set up. */
export const SKILL_NAME = 'pr-review-canvas'
/** Where the package keeps the skills it ships: one directory with a SKILL.md per skill. */
export const SKILLS_ROOT = path.join(PACKAGE_ROOT, 'skills')

export function skillSourceDir(name: string, root = SKILLS_ROOT): string {
  return path.join(root, name)
}
export const SKILL_SOURCE_DIR = skillSourceDir(SKILL_NAME)
export const CLAUDE_SKILLS_DIR = '.claude/skills'
/** Codex reads repo skills from `.agents/skills` under the project root (codex-rs/ext/skills). */
export const CODEX_SKILLS_DIR = '.agents/skills'

/**
 * The skills the package ships: every directory under `skills/` with a SKILL.md, the canvas skill
 * first and the rest by name. They are installed, checked, and refreshed together, so a new skill
 * needs no change here. A directory without a SKILL.md is not a skill yet.
 */
export async function listBundledSkills(root = SKILLS_ROOT): Promise<string[]> {
  const names: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if ((await inspect(path.join(root, entry.name, 'SKILL.md'))).kind === 'none') continue
    names.push(entry.name)
  }
  return names.sort((a, b) => (a === SKILL_NAME ? -1 : b === SKILL_NAME ? 1 : a.localeCompare(b)))
}

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
  /** Absolute skills directories to install into; each gets `<dir>/<name>`. */
  targets: Array<{ kind: 'claude' | 'codex'; dir: string }>
  /** Which bundled skill; the canvas skill by default. */
  name?: string
  /** The skill's own directory, when it is not the bundled one of that name. */
  source?: string
  /** Where the bundled skills are read from; the package's own unless a test says otherwise. */
  skillsRoot?: string | undefined
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
  name: string,
  source: string,
  dir: string,
  content: string,
  force: boolean
): Promise<{ path: string; status: InstallStatus }> {
  await mkdir(dir, { recursive: true })
  const realDir = await realpath(dir)
  const target = path.join(realDir, name)
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
  const name = opts.name ?? SKILL_NAME
  const source = await realpath(opts.source ?? skillSourceDir(name, opts.skillsRoot))
  const content = stampSkill(await readFile(path.join(source, 'SKILL.md'), 'utf8'))
  const targets: InstallSkillResult['targets'] = []
  for (const t of opts.targets) {
    const done = await installOne(name, source, t.dir, content, opts.force === true)
    targets.push({ kind: t.kind, ...done })
  }
  return { skill: name, targets }
}

/**
 * Installs every bundled skill into the same directories, the canvas skill first. The result is
 * the canvas skill's, with the others as `companions`, so what read the one-skill result still can.
 */
export async function installBundledSkills(
  opts: Omit<InstallSkillOptions, 'name' | 'source'>
): Promise<InstallSkillResult & { companions: InstallSkillResult[] }> {
  const [first, ...rest] = await listBundledSkills(opts.skillsRoot)
  if (first === undefined) throw new Error(`no skill with a SKILL.md under ${opts.skillsRoot ?? SKILLS_ROOT}`)
  const main = await installSkill({ ...opts, name: first })
  const companions: InstallSkillResult[] = []
  for (const name of rest) {
    companions.push(await installSkill({ ...opts, name }))
  }
  return { ...main, companions }
}
