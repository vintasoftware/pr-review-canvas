// `pr-review doctor`: one pass over everything the tool needs before it can serve a review, as
// one JSON line. It reports instead of throwing, so a broken setup still answers.
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ORIGIN_HINT } from '../config.js'
import type { Git } from '../git/git.js'
import { CLI_INFO, type HostClient } from '../host/client.js'
import { GITHUB_HOST, type Host } from '../host/host.js'
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
  /** Where `PR_REVIEW_HOST` is read from. */
  env: NodeJS.ProcessEnv
  /** The CLI client for the host origin names; without a usable origin, GitHub's is checked. */
  client: (host: Host) => HostClient
  version: string
  acpxVersion: () => Promise<string | null>
  /** `--data-dir` or `PR_REVIEW_DATA_DIR`; without it the dir sits next to the git common dir. */
  dataDirOverride?: string | undefined
  readSkill?: ReadSkill
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
export type ReadSkill = (file: string) => Promise<string | null>

const readSkillFile: ReadSkill = file => readFile(file, 'utf8')

/** One copy of the skill in the repository, next to how it compares with the bundled one. */
export interface SkillCopy {
  kind: 'claude' | 'codex'
  /** The skills directory the copy sits in, absolute. */
  dir: string
  /** `<dir>/pr-review-canvas`, relative to the repository. */
  path: string
  /** Why the copy differs from the bundled skill, or null when it matches. */
  stale: string | null
}

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
      const { hash, frontmatter } = skillContent(text)
      const matches = hash === expected && frontmatter.getIn(['metadata', 'body-sha256']) === expected
      copies.push({ kind, dir, path: rel, stale: matches ? null : rel })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        copies.push({ kind, dir, path: rel, stale: `${rel}: ${message(err)}` })
      }
    }
  }
  return copies
}

export async function checkSkill(
  repoRoot: string | null,
  readSkill: ReadSkill = readSkillFile
): Promise<DoctorCheck> {
  if (repoRoot === null) {
    return { ok: false, detail: 'no repository, so no skill directory to look in', hint: 'run from a clone' }
  }
  let copies: SkillCopy[]
  try {
    copies = await findSkillCopies(repoRoot, readSkill)
  } catch (err) {
    return { ok: false, detail: message(err), hint: 'reinstall the pr-review package' }
  }
  const stale = copies.flatMap(copy => (copy.stale === null ? [] : [copy.stale]))
  if (stale.length > 0) {
    return {
      ok: false,
      detail: `outdated or modified skill: ${stale.join(', ')}`,
      hint: 'run `pr-review upgrade` or `pr-review install-skill`',
    }
  }
  if (copies.length === 0) {
    return {
      ok: false,
      detail: `${SKILL_NAME} is in neither ${CLAUDE_SKILLS_DIR} nor ${CODEX_SKILLS_DIR}`,
      hint: 'run `pr-review install-skill`',
    }
  }
  return { ok: true, detail: copies.map(copy => copy.path).join(', ') }
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

  let host = GITHUB_HOST
  let origin: DoctorCheck
  try {
    const url = await deps.git.remoteUrl('origin')
    const parsed = url === null ? null : parseOriginRemote(url, deps.env)
    if (parsed === null) {
      origin = { ok: false, detail: url ?? 'no origin remote', hint: ORIGIN_HINT }
    } else {
      host = parsed.host
      origin = { ok: true, detail: `${parsed.repo.owner}/${parsed.repo.name} (${host.label})` }
    }
  } catch (err) {
    origin = { ok: false, detail: message(err), hint: ORIGIN_HINT }
  }

  // The `gh` keys are the report's public names; for a GitLab origin they describe glab.
  const status = await deps.client(host).authStatus()
  const cli = CLI_INFO[host.cli.cli]
  const gh: DoctorCheck = status.installed
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: `install it from ${cli.installUrl}` }
  const ghAuth: DoctorCheck = status.authenticated
    ? { ok: true, detail: status.detail }
    : { ok: false, detail: status.detail, hint: `run \`${cli.loginCommand}\`` }

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
