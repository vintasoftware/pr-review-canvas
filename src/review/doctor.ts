// `pr-review doctor`: one pass over everything the tool needs before it can serve a review, as
// one JSON line. It reports instead of throwing, so a broken setup still answers.
import { randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseGithubRemote } from '../config.js'
import type { Git } from '../git/git.js'
import type { GitHubClient } from '../github/gh.js'
import { ensureDataDir, resolveDataDir } from '../store/data-dir.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, SKILL_NAME } from './install-skill.js'

export const DOCTOR_CHECKS = ['git', 'origin', 'gh', 'ghAuth', 'dataDir', 'skill'] as const
export type DoctorCheckName = (typeof DOCTOR_CHECKS)[number]

export interface DoctorCheck {
  ok: boolean
  detail: string
  hint?: string
}

export interface DoctorReport {
  ok: boolean
  version: string
  checks: Record<DoctorCheckName, DoctorCheck>
}

export interface DoctorDeps {
  git: Git
  gh: GitHubClient
  version: string
  /** `--data-dir` or `PR_REVIEW_DATA_DIR`; without it the dir sits next to the git common dir. */
  dataDirOverride?: string | undefined
  /** Answers whether a file can be read; the skill check asks for the SKILL.md inside. */
  exists: (file: string) => Promise<boolean>
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Can the process write where canvases go? A probe file is written and removed. Its name is
 * random and it is created with `wx`, so the probe writes over nothing.
 */
async function checkDataDir(dir: string): Promise<DoctorCheck> {
  const probe = path.join(dir, `.doctor-probe-${randomBytes(8).toString('hex')}`)
  try {
    await ensureDataDir(dir)
    await writeFile(probe, '', { encoding: 'utf8', flag: 'wx' })
    await rm(probe, { force: true })
    return { ok: true, detail: dir }
  } catch (err) {
    return { ok: false, detail: `${dir}: ${message(err)}`, hint: 'pass --data-dir <dir> to a writable place' }
  }
}

/** The skill the generation flow needs, in either harness's directory. */
async function checkSkill(repoRoot: string | null, exists: DoctorDeps['exists']): Promise<DoctorCheck> {
  if (repoRoot === null) {
    return { ok: false, detail: 'no repository, so no skill directory to look in', hint: 'run from a clone' }
  }
  const targets = [CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR].map(dir => path.join(repoRoot, dir, SKILL_NAME))
  const found: string[] = []
  for (const target of targets) {
    // The file the harness reads, not the directory: an empty directory, a dangling link, and
    // an unreadable file all install nothing.
    if (await exists(path.join(target, 'SKILL.md'))) {
      found.push(path.relative(repoRoot, target))
    }
  }
  if (found.length === 0) {
    return {
      ok: false,
      detail: `${SKILL_NAME} is in neither ${CLAUDE_SKILLS_DIR} nor ${CODEX_SKILLS_DIR}`,
      hint: 'run `pnpm pr-review install-skill`',
    }
  }
  return { ok: true, detail: found.join(', ') }
}

/** Runs every check. Each failure carries the hint that fixes it. */
export async function runDoctorChecks(deps: DoctorDeps): Promise<DoctorReport> {
  let repoRoot: string | null = null
  let git: DoctorCheck
  try {
    repoRoot = await deps.git.topLevel()
    git = { ok: true, detail: repoRoot }
  } catch (err) {
    git = { ok: false, detail: message(err), hint: 'run from a clone or pass --repo <dir>' }
  }

  let origin: DoctorCheck
  try {
    const url = await deps.git.remoteUrl('origin')
    const repo = url === null ? null : parseGithubRemote(url)
    origin =
      repo === null
        ? { ok: false, detail: url ?? 'no origin remote', hint: 'add a github.com origin' }
        : { ok: true, detail: `${repo.owner}/${repo.name}` }
  } catch (err) {
    origin = { ok: false, detail: message(err), hint: 'add a github.com origin' }
  }

  const status = await deps.gh.authStatus()
  const gh: DoctorCheck = status.installed
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: 'install it from https://cli.github.com' }
  const ghAuth: DoctorCheck = status.authenticated
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: 'run `gh auth login`' }

  let dataDir: DoctorCheck
  try {
    const commonDir = await deps.git.commonDir()
    dataDir = await checkDataDir(resolveDataDir({ override: deps.dataDirOverride, commonDir }))
  } catch (err) {
    dataDir = { ok: false, detail: message(err), hint: 'pass --data-dir <dir>' }
  }

  const skill = await checkSkill(repoRoot, deps.exists)
  const checks = { git, origin, gh, ghAuth, dataDir, skill }
  return { ok: DOCTOR_CHECKS.every(name => checks[name].ok), version: deps.version, checks }
}
