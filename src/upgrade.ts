// `pr-review upgrade`: brings pr-review, acpx, and the project's copy of the skill up to date. It
// says what it will change and asks first. Once pr-review itself moves, the new version checks the
// skill, so the skill it ships is stamped by the code that ships it.
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { type CliIo, EXIT, printJson, UsageError } from './commands.js'
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
  /** The acpx that PATH runs, which chat uses. */
  acpxPath: string | null
  /** Runs one command without a shell. Only `npm` is run. */
  run: (file: string, args: string[]) => Promise<CommandResult>
  /** Runs `pr-review <args>` from the package on disk, which is the new one after its upgrade. */
  runInstalled: (args: string[]) => Promise<CommandResult>
  /** Asks a yes/no question, or returns null when there is no one to ask. */
  confirm: (question: string) => Promise<boolean | null>
  readSkill?: ReadSkill
}

/** What one step upgrades, in the order a plan runs them. */
const StepKindSchema = z.enum(['package', 'acpx', 'skill'])
type StepKind = z.infer<typeof StepKindSchema>

const NpmStepSchema = z.object({
  kind: z.enum(['package', 'acpx']),
  name: z.string(),
  from: z.string(),
  to: z.string(),
})
const SkillStepSchema = z.object({ kind: z.literal('skill'), paths: z.array(z.string()) })
const OutcomeFields = {
  status: z.enum(['done', 'failed']),
  detail: z.string().optional(),
}
const StepOutcomeSchema = z.discriminatedUnion('kind', [
  NpmStepSchema.extend(OutcomeFields),
  SkillStepSchema.extend(OutcomeFields),
])
/** What an applied upgrade prints, and so what the parent reads back from the new version. */
const AppliedReportSchema = z.object({ steps: z.array(StepOutcomeSchema) })

export type UpgradeStep = z.infer<typeof NpmStepSchema> | z.infer<typeof SkillStepSchema>
export type StepOutcome = z.infer<typeof StepOutcomeSchema>

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

/**
 * Whether `installed` lies in the copy of `name` that `npm install -g` replaces. Installing over
 * any other copy (pnpm, brew, another node) would leave the one in use as it was.
 */
async function ownedByGlobalNpm(
  globalRoot: string | null,
  name: string,
  installed: string
): Promise<boolean> {
  if (globalRoot === null) return false
  try {
    const globalCopy = await realpath(path.join(globalRoot, name))
    const real = await realpath(installed)
    return real === globalCopy || real.startsWith(`${globalCopy}${path.sep}`)
  } catch {
    return false
  }
}

function notGlobalNote(name: string, latest: string, installed: string): string {
  return `${name} ${latest} is out, but the copy in use (${installed}) is not the global npm install; update it the way you installed it`
}

async function skillCopies(deps: UpgradeDeps): Promise<SkillCopy[]> {
  return deps.repoRoot === null ? [] : findSkillCopies(deps.repoRoot, deps.readSkill)
}

export async function planUpgrade(deps: UpgradeDeps): Promise<UpgradePlan> {
  const steps: UpgradeStep[] = []
  const notes: string[] = []

  const root = await deps.run('npm', ['root', '-g'])
  const globalRoot = root.ok ? root.stdout.trim() : null
  const latest = await latestVersion(deps, deps.packageName)
  if (latest === null) {
    notes.push(`${deps.packageName}: could not read the latest version from npm`)
  } else if (!isNewer(latest, deps.version)) {
    notes.push(`${deps.packageName} ${deps.version} is up to date`)
  } else if (await ownedByGlobalNpm(globalRoot, deps.packageName, deps.packageRoot)) {
    steps.push({ kind: 'package', name: deps.packageName, from: deps.version, to: latest })
  } else {
    notes.push(notGlobalNote(deps.packageName, latest, deps.packageRoot))
  }

  const acpx = deps.acpxPath === null ? null : await deps.acpxVersion()
  const acpxLatest = acpx === null ? null : await latestVersion(deps, ACPX_PACKAGE)
  if (acpx === null || deps.acpxPath === null) {
    notes.push('acpx is not installed; AI Chat needs it: npm install -g acpx@latest')
  } else if (acpxLatest === null) {
    notes.push('acpx: could not read the latest version from npm')
  } else if (!isNewer(acpxLatest, acpx)) {
    notes.push(`acpx ${acpx} is up to date`)
  } else if (await ownedByGlobalNpm(globalRoot, ACPX_PACKAGE, deps.acpxPath)) {
    steps.push({ kind: 'acpx', name: ACPX_PACKAGE, from: acpx, to: acpxLatest })
  } else {
    notes.push(notGlobalNote(ACPX_PACKAGE, acpxLatest, deps.acpxPath))
  }

  if (deps.repoRoot === null) {
    notes.push('not in a repository, so no project skill to refresh')
  } else {
    const copies = await skillCopies(deps)
    // A new pr-review can ship a new skill, so every copy is in question once the package moves.
    const packageMoves = steps.some(step => step.kind === 'package')
    const toCheck = copies.filter(copy => packageMoves || copy.stale)
    if (copies.length === 0) {
      notes.push('the project has no copy of the skill; run `pr-review install-skill` to add one')
    } else if (toCheck.length > 0) {
      steps.push({ kind: 'skill', paths: toCheck.map(copy => copy.path) })
    } else {
      notes.push(`the project skill matches pr-review ${deps.version}`)
    }
  }
  return { steps, notes }
}

export function describeStep(step: UpgradeStep): string {
  if (step.kind === 'skill') {
    return `refresh the project skill where it differs from pr-review's: ${step.paths.join(', ')}`
  }
  return `upgrade ${step.name} ${step.from} -> ${step.to} (npm install -g ${step.name}@${step.to})`
}

async function applySkill(deps: UpgradeDeps): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []
  for (const copy of await skillCopies(deps)) {
    if (!copy.stale) continue
    try {
      await installSkill({ name: copy.skill, targets: [{ kind: copy.kind, dir: copy.dir }] })
      written.push(copy.path)
    } catch (err) {
      if (!(err instanceof SkillDirExistsError)) throw err
      skipped.push(copy.path)
    }
  }
  return { written, skipped }
}

async function applySkillStep(
  step: z.infer<typeof SkillStepSchema>,
  deps: UpgradeDeps
): Promise<StepOutcome> {
  const { written, skipped } = await applySkill(deps)
  if (skipped.length > 0) {
    return {
      ...step,
      paths: written,
      status: 'failed',
      detail: `not a managed copy, left alone: ${skipped.join(', ')}; run \`pr-review install-skill --force\` to replace it`,
    }
  }
  return { ...step, paths: written, status: 'done' }
}

/**
 * The new pr-review's own `upgrade --yes --only <kinds>`: it plans again with its own code, and runs
 * only the kinds of step the user confirmed. Its report's steps join this one's, so this process
 * stays the one that prints them.
 */
async function handOff(deps: UpgradeDeps, kinds: StepKind[]): Promise<StepOutcome[]> {
  const result = await deps.runInstalled([
    'upgrade',
    '--yes',
    '--only',
    kinds.join(','),
    ...(deps.repoRoot === null ? [] : ['--repo', deps.repoRoot]),
  ])
  let report: unknown
  try {
    // The report is the last line; String() turns a missing one into text JSON.parse rejects.
    report = JSON.parse(String(result.stdout.trim().split('\n').at(-1)))
  } catch {
    report = null
  }
  const parsed = AppliedReportSchema.safeParse(report)
  if (parsed.success) return parsed.data.steps
  return [
    {
      kind: 'skill',
      paths: [],
      status: 'failed',
      detail:
        `the new pr-review did not report a result; run \`pr-review upgrade\` again\n` +
        result.stderr.trim().split('\n').slice(-3).join('\n'),
    },
  ]
}

/**
 * Runs every step in order. A failed npm install does not stop the rest. Once pr-review itself is
 * upgraded, the new version plans and runs whatever is left, so the skill it ships is checked and
 * copied by its own code.
 */
export async function applyUpgrade(plan: UpgradePlan, deps: UpgradeDeps): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = []
  for (const [index, step] of plan.steps.entries()) {
    if (step.kind === 'skill') {
      outcomes.push(await applySkillStep(step, deps))
      continue
    }
    const result = await deps.run('npm', ['install', '-g', `${step.name}@${step.to}`])
    if (!result.ok) {
      const detail = result.stderr.trim().split('\n').slice(-3).join('\n') || 'npm install failed'
      outcomes.push({ ...step, status: 'failed', detail })
      continue
    }
    outcomes.push({ ...step, status: 'done' })
    const rest = plan.steps.slice(index + 1)
    if (step.kind === 'package' && rest.length > 0) {
      return [
        ...outcomes,
        ...(await handOff(
          deps,
          rest.map(later => later.kind)
        )),
      ]
    }
  }
  return outcomes
}

/** `--only package,acpx,skill`: the kinds of step this run may take. */
function parseOnly(raw: string | undefined): ReadonlySet<StepKind> | null {
  if (raw === undefined) return null
  const kinds = z.array(StepKindSchema).safeParse(raw.split(','))
  if (!kinds.success) {
    throw new UsageError(`--only takes a comma list of ${StepKindSchema.options.join(', ')}; got "${raw}"`)
  }
  return new Set(kinds.data)
}

/**
 * `upgrade [--yes] [--only <kinds>]`: the plan on stderr, a confirmation, then one JSON line with
 * what happened.
 */
export async function runUpgrade(deps: UpgradeDeps, argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { yes: { type: 'boolean', short: 'y' }, only: { type: 'string' } },
    strict: true,
  })
  const only = parseOnly(values.only)
  const full = await planUpgrade(deps)
  const plan: UpgradePlan =
    only === null
      ? full
      : {
          steps: full.steps.filter(step => only.has(step.kind)),
          notes: [
            ...full.notes,
            ...full.steps
              .filter(step => !only.has(step.kind))
              .map(step => `left out by --only: ${describeStep(step)}`),
          ],
        }
  for (const note of plan.notes) io.stderr(`  ${note}`)
  if (plan.steps.length === 0) {
    io.stderr('Everything is up to date.')
    printJson(io, { applied: false, steps: [], notes: plan.notes })
    return EXIT.ok
  }
  io.stderr('pr-review upgrade will:')
  for (const step of plan.steps) io.stderr(`  - ${describeStep(step)}`)
  if (plan.steps.some(step => step.kind === 'package')) {
    io.stderr('  Once pr-review is upgraded, the new version checks and runs the steps after it.')
  }

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
  // A skill step lists only the copies it wrote, failed or not.
  const refreshed = outcomes.flatMap(o => (o.kind === 'skill' ? o.paths : []))
  if (refreshed.length > 0) {
    io.stderr(`The project skill changed. Commit and push ${refreshed.join(' and ')} so your team gets it.`)
  }
  const ok = outcomes.every(o => o.status !== 'failed')
  printJson(io, { applied: true, ok, steps: outcomes, notes: plan.notes })
  return ok ? EXIT.ok : EXIT.error
}
