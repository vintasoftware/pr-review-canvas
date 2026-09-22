// `pr-review upgrade`: brings pr-review, acpx, and the project's copy of the skill up to date. It
// says what it will change and asks first; the skill is checked again after pr-review itself moves,
// since a new package can ship a new skill.
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { type CliIo, EXIT, printJson } from './commands.js'
import { findSkillCopies, type ReadSkill, type SkillCopy } from './review/doctor.js'
import { installSkill, SkillDirExistsError } from './review/install-skill.js'

export const ACPX_PACKAGE = 'acpx'

export interface CommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

export interface UpgradeDeps {
  /** The running pr-review: its package name, version, and where it is installed. */
  packageName: string
  version: string
  packageRoot: string
  /** The repository whose skill copies are refreshed, or null outside one. */
  repoRoot: string | null
  acpxVersion: () => Promise<string | null>
  /** Runs one command without a shell. Only `npm` is run. */
  run: (file: string, args: string[]) => Promise<CommandResult>
  /** Asks a yes/no question, or returns null when there is no one to ask. */
  confirm: (question: string) => Promise<boolean | null>
  readSkill?: ReadSkill
}

export type UpgradeStep =
  | { kind: 'package' | 'acpx'; name: string; from: string; to: string }
  /** `afterPackage`: the copies are compared again once the new package is on disk. */
  | { kind: 'skill'; paths: string[]; afterPackage: boolean }

export interface UpgradePlan {
  steps: UpgradeStep[]
  /** What was looked at and left alone, and why. */
  notes: string[]
}

/** `1.2.10` against `1.2.9`, numerically. A prerelease tag is ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => v.trim().replace(/^v/, '').split(/[-+]/)[0]!.split('.').map(Number)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (Number.isNaN(diff)) return false
    if (diff !== 0) return diff > 0
  }
  return false
}

async function latestVersion(deps: UpgradeDeps, name: string): Promise<string | null> {
  const result = await deps.run('npm', ['view', name, 'version'])
  const version = result.stdout.trim()
  return result.ok && version !== '' ? version : null
}

/** Whether the running copy is the one `npm install -g` would replace. */
async function installedGlobally(deps: UpgradeDeps): Promise<boolean> {
  const root = await deps.run('npm', ['root', '-g'])
  if (!root.ok) return false
  try {
    const globalCopy = await realpath(path.join(root.stdout.trim(), deps.packageName))
    return globalCopy === (await realpath(deps.packageRoot))
  } catch {
    return false
  }
}

async function skillCopies(deps: UpgradeDeps): Promise<SkillCopy[]> {
  return deps.repoRoot === null ? [] : findSkillCopies(deps.repoRoot, deps.readSkill)
}

export async function planUpgrade(deps: UpgradeDeps): Promise<UpgradePlan> {
  const steps: UpgradeStep[] = []
  const notes: string[] = []

  const latest = await latestVersion(deps, deps.packageName)
  let packageMoves = false
  if (latest === null) {
    notes.push(`${deps.packageName}: could not read the latest version from npm`)
  } else if (!isNewer(latest, deps.version)) {
    notes.push(`${deps.packageName} ${deps.version} is up to date`)
  } else if (await installedGlobally(deps)) {
    steps.push({ kind: 'package', name: deps.packageName, from: deps.version, to: latest })
    packageMoves = true
  } else {
    notes.push(
      `${deps.packageName} ${latest} is out, but this copy (${deps.version}) runs from ${deps.packageRoot}, ` +
        'not a global npm install; update it the way you installed it'
    )
  }

  const acpx = (await deps.acpxVersion())?.trim() ?? null
  const acpxLatest = acpx === null ? null : await latestVersion(deps, ACPX_PACKAGE)
  if (acpx === null) {
    notes.push('acpx is not installed; AI Chat needs it: npm install -g acpx@latest')
  } else if (acpxLatest === null) {
    notes.push('acpx: could not read the latest version from npm')
  } else if (isNewer(acpxLatest, acpx)) {
    steps.push({ kind: 'acpx', name: ACPX_PACKAGE, from: acpx, to: acpxLatest })
  } else {
    notes.push(`acpx ${acpx} is up to date`)
  }

  if (deps.repoRoot === null) {
    notes.push('not in a repository, so no project skill to refresh')
  } else {
    const copies = await skillCopies(deps)
    const stale = copies.filter(copy => copy.stale !== null)
    if (copies.length === 0) {
      notes.push('the project has no copy of the skill; run `pr-review install-skill` to add one')
    } else if (packageMoves) {
      steps.push({ kind: 'skill', paths: copies.map(copy => copy.path), afterPackage: true })
    } else if (stale.length > 0) {
      steps.push({ kind: 'skill', paths: stale.map(copy => copy.path), afterPackage: false })
    } else {
      notes.push(`the project skill matches pr-review ${deps.version}`)
    }
  }
  return { steps, notes }
}

export function describeStep(step: UpgradeStep): string {
  if (step.kind === 'skill') {
    const which = step.paths.join(', ')
    return step.afterPackage
      ? `refresh the project skill (${which}) if the new pr-review ships a different one`
      : `refresh the project skill: ${which}`
  }
  return `upgrade ${step.name} ${step.from} -> ${step.to} (npm install -g ${step.name}@${step.to})`
}

export type StepOutcome = UpgradeStep & { status: 'done' | 'unchanged' | 'failed'; detail?: string }

async function applySkill(deps: UpgradeDeps): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []
  for (const copy of await skillCopies(deps)) {
    if (copy.stale === null) continue
    try {
      await installSkill({ targets: [{ kind: copy.kind, dir: copy.dir }] })
      written.push(copy.path)
    } catch (err) {
      if (!(err instanceof SkillDirExistsError)) throw err
      skipped.push(copy.path)
    }
  }
  return { written, skipped }
}

/**
 * Runs every step in order. A failed npm install does not stop the rest: the skill step compares
 * against whatever package is on disk by then.
 */
export async function applyUpgrade(plan: UpgradePlan, deps: UpgradeDeps): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = []
  for (const step of plan.steps) {
    if (step.kind === 'skill') {
      const { written, skipped } = await applySkill(deps)
      const detail =
        skipped.length === 0
          ? undefined
          : `not a managed copy, left alone: ${skipped.join(', ')}; run \`pr-review install-skill --force\` to replace it`
      outcomes.push({
        ...step,
        paths: written,
        status: skipped.length > 0 ? 'failed' : written.length > 0 ? 'done' : 'unchanged',
        ...(detail === undefined ? {} : { detail }),
      })
      continue
    }
    const result = await deps.run('npm', ['install', '-g', `${step.name}@${step.to}`])
    if (!result.ok) {
      const detail = result.stderr.trim().split('\n').slice(-3).join('\n') || 'npm install failed'
      outcomes.push({ ...step, status: 'failed', detail })
      continue
    }
    outcomes.push({ ...step, status: 'done' })
  }
  return outcomes
}

/** `upgrade [--yes]`: the plan on stderr, a confirmation, then one JSON line with what happened. */
export async function runUpgrade(deps: UpgradeDeps, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { yes: { type: 'boolean', short: 'y' } },
    strict: true,
  })
  const plan = await planUpgrade(deps)
  for (const note of plan.notes) io.stderr(`  ${note}`)
  if (plan.steps.length === 0) {
    io.stderr('Everything is up to date.')
    printJson(io, { applied: false, steps: [], notes: plan.notes })
    return EXIT.ok
  }
  io.stderr('pr-review upgrade will:')
  for (const step of plan.steps) io.stderr(`  - ${describeStep(step)}`)

  const confirmed = values.yes === true ? true : await deps.confirm('Proceed? [y/N] ')
  if (confirmed !== true) {
    io.stderr(confirmed === null ? 'Nothing changed. Re-run with --yes to apply.' : 'Nothing changed.')
    printJson(io, { applied: false, steps: plan.steps, notes: plan.notes })
    return EXIT.ok
  }

  const outcomes = await applyUpgrade(plan, deps)
  for (const outcome of outcomes) {
    io.stderr(
      `  ${outcome.status}: ${describeStep(outcome)}${outcome.detail ? `\n    ${outcome.detail}` : ''}`
    )
  }
  const refreshed = outcomes.flatMap(o => (o.kind === 'skill' && o.status !== 'unchanged' ? o.paths : []))
  if (refreshed.length > 0) {
    io.stderr(`The project skill changed. Commit and push ${refreshed.join(' and ')} so your team gets it.`)
  }
  const ok = outcomes.every(o => o.status !== 'failed')
  printJson(io, { applied: true, ok, steps: outcomes, notes: plan.notes })
  return ok ? EXIT.ok : EXIT.error
}
