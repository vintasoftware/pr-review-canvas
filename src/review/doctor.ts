// `pr-review doctor`: one pass over everything the tool needs before it can serve a review, as
// one JSON line. It reports instead of throwing, so a broken setup still answers.
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Git } from '../git/git.js'
import type { GitHubClient } from '../github/gh.js'
import { GITHUB_HOST, type HostInfo } from '../host/host.js'
import { parseOriginRemote } from '../host/remote.js'
import { ensureDataDir, resolveDataDir } from '../store/data-dir.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, SKILL_NAME, SKILL_SOURCE_DIR } from './install-skill.js'
import { skillContent } from './skill-content.js'

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
  checks: Record<DoctorCheckName, DoctorCheck> & { acpx?: DoctorCheck }
}

export interface DoctorDeps {
  git: Git
  gh: GitHubClient
  host?: HostInfo
  version: string
  acpxVersion: () => Promise<string | null>
  /** `--data-dir` or `PR_REVIEW_DATA_DIR`; without it the dir sits next to the git common dir. */
  dataDirOverride?: string | undefined
  readSkill?: (file: string) => Promise<string | null>
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
export async function checkSkill(
  repoRoot: string | null,
  readSkill: NonNullable<DoctorDeps['readSkill']> = file => readFile(file, 'utf8')
): Promise<DoctorCheck> {
  if (repoRoot === null) {
    return { ok: false, detail: 'no repository, so no skill directory to look in', hint: 'run from a clone' }
  }
  const targets = [CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR].map(dir => path.join(repoRoot, dir, SKILL_NAME))
  const found: string[] = []
  const stale: string[] = []
  let expected: string
  try {
    expected = skillContent(await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8')).hash
  } catch (err) {
    return { ok: false, detail: message(err), hint: 'reinstall the pr-review package' }
  }
  for (const target of targets) {
    try {
      const text = await readSkill(path.join(target, 'SKILL.md'))
      if (text === null) continue
      found.push(path.relative(repoRoot, target))
      const { hash, frontmatter } = skillContent(text)
      if (hash !== expected || frontmatter.getIn(['metadata', 'body-sha256']) !== expected) {
        stale.push(path.relative(repoRoot, target))
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        stale.push(`${path.relative(repoRoot, target)}: ${message(err)}`)
      }
    }
  }
  if (stale.length > 0) {
    return {
      ok: false,
      detail: `outdated or modified skill: ${stale.join(', ')}`,
      hint: 'run `pr-review install-skill`',
    }
  }
  if (found.length === 0) {
    return {
      ok: false,
      detail: `${SKILL_NAME} is in neither ${CLAUDE_SKILLS_DIR} nor ${CODEX_SKILLS_DIR}`,
      hint: 'run `pr-review install-skill`',
    }
  }
  return { ok: true, detail: found.join(', ') }
}

async function checkAcpx(deps: DoctorDeps): Promise<DoctorCheck> {
  const hint = 'install with `npm install -g acpx` and check `acpx --version`'
  try {
    const version = (await deps.acpxVersion())?.trim()
    return version
      ? { ok: true, detail: version }
      : { ok: false, detail: 'acpx is missing or could not report its version', hint }
  } catch (err) {
    return { ok: false, detail: message(err), hint }
  }
}

/** Runs core checks and, with allChecks, checks acpx for AI Chat. */
export async function runDoctorChecks(
  deps: DoctorDeps,
  options: { allChecks?: boolean } = {}
): Promise<DoctorReport> {
  let repoRoot: string | null = null
  let git: DoctorCheck
  try {
    repoRoot = await deps.git.topLevel()
    git = { ok: true, detail: repoRoot }
  } catch (err) {
    git = { ok: false, detail: message(err), hint: 'run from a clone or pass --repo <dir>' }
  }

  const host = deps.host ?? GITHUB_HOST
  let origin: DoctorCheck
  try {
    const url = await deps.git.remoteUrl('origin')
    const parsed = url === null ? null : parseOriginRemote(url, process.env)
    origin =
      parsed === null
        ? {
            ok: false,
            detail: url ?? 'no origin remote',
            hint: 'add a github.com or GitLab origin, or set PR_REVIEW_HOST=gitlab',
          }
        : { ok: true, detail: `${parsed.repo.owner}/${parsed.repo.name} (${parsed.host.label})` }
  } catch (err) {
    origin = {
      ok: false,
      detail: message(err),
      hint: 'add a github.com or GitLab origin, or set PR_REVIEW_HOST=gitlab',
    }
  }

  const status = await deps.gh.authStatus()
  const cliHint =
    host.kind === 'gitlab'
      ? 'install it from https://gitlab.com/gitlab-org/cli'
      : 'install it from https://cli.github.com'
  const authHint = host.kind === 'gitlab' ? 'run `glab auth login`' : 'run `gh auth login`'
  const gh: DoctorCheck = status.installed
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: cliHint }
  const ghAuth: DoctorCheck = status.authenticated
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: authHint }

  let dataDir: DoctorCheck
  try {
    const commonDir = await deps.git.commonDir()
    dataDir = await checkDataDir(resolveDataDir({ override: deps.dataDirOverride, commonDir }))
  } catch (err) {
    dataDir = { ok: false, detail: message(err), hint: 'pass --data-dir <dir>' }
  }

  const skill = await checkSkill(repoRoot, deps.readSkill)
  const checks: DoctorReport['checks'] = { git, origin, gh, ghAuth, dataDir, skill }
  if (options.allChecks) {
    checks.acpx = await checkAcpx(deps)
  }
  return { ok: Object.values(checks).every(check => check.ok), version: deps.version, checks }
}
