// Report each prerequisite separately so a broken setup still explains what needs fixing.
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DCG_INSTALL_HINT, DCG_POLICY_HINT, DcgPolicyError, SANDBOX_INSTALL_HINT } from '../acpx/sandbox.js'
import { ORIGIN_HINT } from '../config.js'
import type { Git } from '../git/git.js'
import { CLI_INFO, type HostClient } from '../host/client.js'
import { GITHUB_HOST, type Host } from '../host/host.js'
import { parseOriginRemote } from '../host/remote.js'
import { ensureDataDir, resolveDataDir } from '../store/data-dir.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, SKILL_NAME, SKILL_SOURCE_DIR } from './install-skill.js'
import { skillContent } from './skill-content.js'

export const DOCTOR_CHECKS = ['git', 'origin', 'gh', 'ghAuth', 'dataDir', 'skill', 'dcg'] as const
export type DoctorCheckName = (typeof DOCTOR_CHECKS)[number]

export interface DoctorCheck {
  ok: boolean
  detail: string
  hint?: string
}

export interface DoctorReport {
  ok: boolean
  version: string
  checks: Record<DoctorCheckName, DoctorCheck> & {
    acpx?: DoctorCheck
    sandbox?: DoctorCheck
    chatGuards?: DoctorCheck
  }
}

export interface DoctorDeps {
  git: Git
  /** Where `PR_REVIEW_HOST` is read from. */
  env: NodeJS.ProcessEnv
  /** The CLI client for the host origin names; without a usable origin, GitHub's is checked. */
  client: (host: Host) => HostClient
  version: string
  acpxVersion: () => Promise<string | null>
  dcgVersion: () => Promise<string>
  checkSandbox: () => Promise<void>
  checkChatGuards: (cwd: string) => Promise<string>
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
  let dcg: DoctorCheck
  try {
    const version = (await deps.dcgVersion()).trim()
    dcg = version
      ? { ok: true, detail: version }
      : { ok: false, detail: 'dcg did not report a version', hint: DCG_INSTALL_HINT }
  } catch (err) {
    dcg = {
      ok: false,
      detail: message(err),
      hint: err instanceof DcgPolicyError ? DCG_POLICY_HINT : DCG_INSTALL_HINT,
    }
  }
  const checks: DoctorReport['checks'] = { git, origin, gh, ghAuth, dataDir, skill, dcg }
  if (options.allChecks) {
    checks.acpx = await checkAcpx(deps)
    try {
      await deps.checkSandbox()
      checks.sandbox = { ok: true, detail: 'filesystem containment is available' }
    } catch (err) {
      checks.sandbox = { ok: false, detail: message(err), hint: SANDBOX_INSTALL_HINT }
    }
    try {
      if (!repoRoot || !checks.sandbox.ok || !dcg.ok)
        throw new Error('Fix the repository, sandbox, and dcg checks before checking chat hooks.')
      checks.chatGuards = { ok: true, detail: await deps.checkChatGuards(repoRoot) }
    } catch (err) {
      checks.chatGuards = {
        ok: false,
        detail: message(err),
        hint: 'see README AI Chat setup; chat requires active dcg hooks',
      }
    }
  }
  return { ok: Object.values(checks).every(check => check.ok), version: deps.version, checks }
}

const CHECK_LABELS: Record<keyof DoctorReport['checks'], string> = {
  git: 'Git repository',
  origin: 'GitHub origin',
  gh: 'GitHub CLI',
  ghAuth: 'GitHub login',
  dataDir: 'Canvas storage',
  skill: 'Review skill',
  dcg: 'dcg and required chat policy',
  acpx: 'acpx',
  sandbox: 'Filesystem sandbox',
  chatGuards: 'Native chat hooks',
}

/** Plain text works in terminals, pasted bug reports, and agent prompts. */
export function formatDoctorReport(
  report: DoctorReport,
  platform: NodeJS.Platform = process.platform
): string {
  const windows = platform === 'win32'
  const mac = platform === 'darwin'
  const installs: Partial<Record<keyof DoctorReport['checks'], string>> = {
    git: windows
      ? 'Install Git for Windows from https://git-scm.com/downloads/win.'
      : mac
        ? 'Install Git with `xcode-select --install`.'
        : 'Install Git with `sudo apt-get update` then `sudo apt-get install git`.',
    gh: windows
      ? 'Install GitHub CLI with `winget install --id GitHub.cli`.'
      : mac
        ? 'Install GitHub CLI with `brew install gh`, or use https://cli.github.com.'
        : 'Install GitHub CLI using https://github.com/cli/cli/blob/trunk/docs/install_linux.md.',
    acpx: 'Install acpx with `npm install -g acpx@0.13.2`, then check `acpx --version`.',
    sandbox: windows
      ? 'Install Ubuntu WSL2 from PowerShell with `wsl --install -d Ubuntu`. Inside Ubuntu, run `sudo apt-get update` then `sudo apt-get install bubblewrap`.'
      : mac
        ? 'Check that `/usr/bin/sandbox-exec` is available and permitted by your macOS security policy.'
        : 'Run `sudo apt-get update` then `sudo apt-get install bubblewrap`. If installed, check whether your OS permits unprivileged user namespaces.',
    chatGuards:
      'Install at least one supported agent: `npm install -g @openai/codex@0.154.0` or `npm install -g @anthropic-ai/claude-code@2.1.272`. Sign in with `codex login` or `claude auth login`. If already installed, follow the reported hook/configuration repair instructions.',
  }
  const lines = [`pr-review doctor ${report.version}`, '']
  const failures: string[] = []
  for (const [key, check] of Object.entries(report.checks)) {
    const name = key as keyof DoctorReport['checks']
    lines.push(`${check.ok ? 'PASS' : 'FAIL'} ${CHECK_LABELS[name]}: ${check.detail}`)
    if (!check.ok) {
      const steps = [installs[name], check.hint].filter((step): step is string => Boolean(step))
      failures.push(
        `${failures.length + 1}. ${CHECK_LABELS[name]}\n${steps.map(step => `   ${step}`).join('\n')}`
      )
    }
  }
  if (failures.length) lines.push('', 'Next steps', ...failures)
  if (windows)
    lines.push(
      '',
      'Windows 11: the review app uses Windows Git/GitHub CLI. Chat uses Ubuntu WSL2: install Node 22.18+ or 24+, dcg, acpx, and your agent there. Check `wsl --exec node --version` and `wsl --exec dcg --version`. A Windows-only installation does not satisfy chat checks.'
    )
  lines.push(
    '',
    report.ok
      ? 'All requested checks passed.'
      : `${failures.length} check(s) failed. Fix the items above and rerun the same doctor command.`
  )
  if (!report.checks.acpx)
    lines.push(
      'Run `pr-review doctor --all-checks` to also check chat dependencies, containment, and native hooks.'
    )
  lines.push('Use `--json` for the structured report.')
  return lines.join('\n')
}
