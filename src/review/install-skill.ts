// `pr-review install-skill`: link the bundled skill into the host repo's skill directories, so
// Claude Code (`.claude/skills`) and Codex (`.agents/skills`) both see `/pr-review-canvas`.
import { appendFile, cp, lstat, mkdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PACKAGE_ROOT } from '../server/context.js'
import { readText } from '../store/atomic-json.js'

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
  /** Windows copies; everything else links. */
  platform?: NodeJS.Platform
  /** Replace a real directory that already sits at the target. */
  force?: boolean
}

/** A real directory (a customized copy of the skill) sits where the link would go. */
export class SkillDirExistsError extends Error {
  readonly path: string

  constructor(target: string) {
    super(`${target} is a directory, not a link to the bundled skill`)
    this.name = 'SkillDirExistsError'
    this.path = target
  }
}

export type InstallStatus = 'linked' | 'copied' | 'exists' | 'replaced'

export interface InstallSkillResult {
  skill: string
  targets: Array<{ kind: 'claude' | 'codex'; path: string; status: InstallStatus }>
}

/** What sits at the target now: nothing, a symlink (with its target), or something else. */
async function inspect(target: string): Promise<{ kind: 'none' } | { kind: 'link'; to: string } | { kind: 'other' }> {
  let stats: Awaited<ReturnType<typeof lstat>>
  try {
    stats = await lstat(target)
  } catch {
    return { kind: 'none' }
  }
  return stats.isSymbolicLink() ? { kind: 'link', to: await readlink(target) } : { kind: 'other' }
}

/** A copy carries a marker file, so a later run can tell it from a hand-made directory. */
export const COPY_MARKER = '.pr-review-install'

async function installOne(
  source: string,
  dir: string,
  copy: boolean,
  force: boolean
): Promise<{ path: string; status: InstallStatus }> {
  await mkdir(dir, { recursive: true })
  const realDir = await realpath(dir)
  const target = path.join(realDir, SKILL_NAME)
  const current = await inspect(target)
  if (current.kind === 'other' && !force && (await inspect(path.join(target, COPY_MARKER))).kind === 'none') {
    throw new SkillDirExistsError(target)
  }
  if (copy) {
    await rm(target, { recursive: true, force: true })
    await cp(source, target, { recursive: true })
    await writeFile(path.join(target, COPY_MARKER), `copied from ${source}\n`, 'utf8')
    return { path: target, status: 'copied' }
  }
  const relative = path.relative(realDir, source)
  if (current.kind === 'link' && current.to === relative) {
    return { path: target, status: 'exists' }
  }
  if (current.kind !== 'none') {
    await rm(target, { recursive: true, force: true })
  }
  await symlink(relative, target, 'dir')
  return { path: target, status: current.kind === 'none' ? 'linked' : 'replaced' }
}

export async function installSkill(opts: InstallSkillOptions): Promise<InstallSkillResult> {
  const source = await realpath(opts.source ?? SKILL_SOURCE_DIR)
  const copy = (opts.platform ?? process.platform) === 'win32'
  const targets: InstallSkillResult['targets'] = []
  for (const t of opts.targets) {
    const done = await installOne(source, t.dir, copy, opts.force === true)
    targets.push({ kind: t.kind, ...done })
  }
  return { skill: SKILL_NAME, targets }
}
