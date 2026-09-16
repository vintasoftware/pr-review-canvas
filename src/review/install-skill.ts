// `pr-review install-skill`: copy the bundled skill into the host repo's skill directories, so
// Claude Code (`.claude/skills`) and Codex (`.agents/skills`) both see `/pr-review-canvas`.
import { appendFile, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../server/context.js'
import { readText } from '../store/atomic-json.js'
import { stampSkill } from './skill-content.js'

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
