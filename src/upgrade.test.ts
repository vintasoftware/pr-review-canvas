// @vitest-environment node
import { appendFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CliIo, splitCommonFlags } from './commands.js'
import { findSkillCopies } from './review/doctor.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, installSkill } from './review/install-skill.js'
import { makeTempDir } from './testing/fakes.js'
import { type CommandResult, isNewer, planUpgrade, runUpgrade, type UpgradeDeps } from './upgrade.js'

const NAME = '@vintasoftware/pr-review-canvas'

let tmp: string
let repo: string
let globalRoot: string
let packageRoot: string
/** The acpx PATH runs when it came from `npm install -g`: a file inside the global package. */
let globalAcpx: string

beforeEach(async () => {
  tmp = await realpath(await makeTempDir('pr-review-upgrade-'))
  repo = path.join(tmp, 'repo')
  globalRoot = path.join(tmp, 'global')
  packageRoot = path.join(globalRoot, NAME)
  await mkdir(repo, { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  globalAcpx = path.join(globalRoot, 'acpx', 'dist', 'cli.js')
  await mkdir(path.dirname(globalAcpx), { recursive: true })
  await writeFile(globalAcpx, '')
})
afterEach(() => rm(tmp, { recursive: true, force: true }))

interface Fake {
  deps: UpgradeDeps
  calls: string[]
}

/**
 * A machine with npm on it. `npm view` answers from `latest` (a missing name is one npm cannot
 * find), and `npm install -g` changes what is installed, so the next look sees the new version.
 * `runInstalled` runs the real upgrade as whatever pr-review version is installed by then.
 */
function fake(opts: {
  version?: string
  latest?: Record<string, string>
  /** The installed acpx version; null means acpx is not on PATH. */
  acpx?: string | null
  acpxPath?: string
  confirm?: boolean | null
  /** npm install fails with this stderr. */
  failInstall?: string
  /** The installed pr-review prints something other than its report. */
  garbledInstalled?: boolean
  packageRoot?: string
  repoRoot?: string | null
  /** `npm root -g` fails. */
  noGlobalRoot?: boolean
}): Fake {
  const calls: string[] = []
  const installed: Record<string, string | null> = {
    [NAME]: opts.version ?? '0.5.0',
    acpx: opts.acpx === undefined ? '0.13.2' : opts.acpx,
  }
  const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' })
  const depsFor = (version: string): UpgradeDeps => ({
    packageName: NAME,
    version,
    packageRoot: opts.packageRoot ?? packageRoot,
    repoRoot: opts.repoRoot === undefined ? repo : opts.repoRoot,
    acpxVersion: async () => installed['acpx'] ?? null,
    acpxPath: installed['acpx'] === null ? null : (opts.acpxPath ?? globalAcpx),
    run: async (_file, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'view') {
        const latest = opts.latest?.[args[1] ?? '']
        return latest === undefined ? { ok: false, stdout: '', stderr: 'E404' } : ok(`${latest}\n`)
      }
      if (args[0] === 'root') {
        return opts.noGlobalRoot ? { ok: false, stdout: '', stderr: 'EACCES' } : ok(`${globalRoot}\n`)
      }
      if (opts.failInstall !== undefined) return { ok: false, stdout: '', stderr: opts.failInstall }
      const [pkg, to] = (args[2] ?? '').split(/@(?=[^@]*$)/)
      installed[pkg ?? ''] = to ?? null
      return ok('')
    },
    runInstalled: async args => {
      calls.push(`pr-review ${installed[NAME]} ${args.join(' ')}`)
      if (opts.garbledInstalled) return { ok: false, stdout: 'Segmentation fault', stderr: 'boom' }
      // What cli.ts does with the arguments: the command name, then the common flags.
      const [command, ...flags] = args
      const { repo: childRepo, rest } = splitCommonFlags(flags)
      const child = capture()
      const code =
        command === 'upgrade' && (childRepo ?? null) === (opts.repoRoot === undefined ? repo : opts.repoRoot)
          ? await runUpgrade(depsFor(installed[NAME] ?? ''), rest, child.io)
          : 2
      return { ok: code === 0, stdout: child.out.join('\n'), stderr: child.err.join('\n') }
    },
    confirm: async () => (opts.confirm === undefined ? true : opts.confirm),
  })
  return { deps: depsFor(installed[NAME] ?? ''), calls }
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { io: { stdout: line => out.push(line), stderr: line => err.push(line) }, out, err }
}

async function installCopies(): Promise<void> {
  await installSkill({
    targets: [
      { kind: 'claude', dir: path.join(repo, CLAUDE_SKILLS_DIR) },
      { kind: 'codex', dir: path.join(repo, CODEX_SKILLS_DIR) },
    ],
  })
}

describe('isNewer', () => {
  it.each([
    ['0.19.1', '0.13.2', true],
    ['1.2.10', '1.2.9', true],
    ['1.2.1', '1.2', true],
    ['1.2', '1.2.0', false],
    ['0.5.0', '0.5.0', false],
    ['0.4.0', '0.5.0', false],
    ['v1.0.0', '0.9.9', true],
    ['1.0.0-beta.1', '1.0.0', false],
    ['garbage', '1.0.0', false],
  ])('%s over %s is %s', (candidate, current, expected) => {
    expect(isNewer(candidate, current)).toBe(expected)
  })
})

describe('planUpgrade', () => {
  it('plans pr-review and acpx, and leaves the skill to the new pr-review', async () => {
    await installCopies()
    const { deps } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.19.1' } })
    const plan = await planUpgrade(deps)
    expect(plan.steps).toEqual([
      { kind: 'package', name: NAME, from: '0.5.0', to: '0.6.0' },
      { kind: 'acpx', name: 'acpx', from: '0.13.2', to: '0.19.1' },
    ])
    expect(plan.notes).toContain('the new pr-review checks the project skill once it is installed')
  })

  it('leaves a pr-review that is not the global npm install to the user', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.13.2' }, packageRoot: tmp })
    const plan = await planUpgrade(deps)
    expect(plan.steps).toEqual([])
    expect(plan.notes).toContain(
      `${NAME} 0.6.0 is out, but the copy in use (${tmp}) is not the global npm install; update it the way you installed it`
    )
    expect(plan.notes).toContain('acpx 0.13.2 is up to date')
  })

  it('leaves an acpx that did not come from npm install -g to the user', async () => {
    const elsewhere = path.join(tmp, 'pnpm', 'acpx')
    await mkdir(path.dirname(elsewhere), { recursive: true })
    await writeFile(elsewhere, '')
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, acpxPath: elsewhere })
    const plan = await planUpgrade(deps)
    expect(plan.steps).toEqual([])
    expect(plan.notes).toContain(
      `acpx 0.19.1 is out, but the copy in use (${elsewhere}) is not the global npm install; update it the way you installed it`
    )
  })

  it('plans nothing it cannot confirm when npm does not answer', async () => {
    const { deps } = fake({ latest: {} })
    const plan = await planUpgrade({
      ...deps,
      run: async () => ({ ok: false, stdout: '', stderr: 'npm: not found' }),
    })
    expect(plan.steps).toEqual([])
    expect(plan.notes).toEqual([
      `${NAME}: could not read the latest version from npm`,
      'acpx: could not read the latest version from npm',
      'the project has no copy of the skill; run `pr-review install-skill` to add one',
    ])
  })

  it('upgrades nothing in place when npm has no global root', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.19.1' }, noGlobalRoot: true })
    expect((await planUpgrade(deps)).steps).toEqual([])
  })

  it('has no skill to look at outside a repository', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.13.2' } })
    const plan = await planUpgrade({ ...deps, repoRoot: null })
    expect(plan.notes).toContain('not in a repository, so no project skill to refresh')
  })

  it('suggests installing acpx instead of upgrading one that is missing', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.5.0' }, acpx: null })
    const plan = await planUpgrade(deps)
    expect(plan.steps).toEqual([])
    expect(plan.notes).toContain('acpx is not installed; AI Chat needs it: npm install -g acpx@latest')
  })

  it('plans only the stale skill copy when the package stays', async () => {
    await installCopies()
    await appendFile(path.join(repo, CODEX_SKILLS_DIR, 'pr-review-canvas', 'SKILL.md'), '\nedited\n')
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, acpx: '0.19.1' })
    expect((await planUpgrade(deps)).steps).toEqual([
      { kind: 'skill', paths: [`${CODEX_SKILLS_DIR}/pr-review-canvas`] },
    ])
  })
})

describe('runUpgrade', () => {
  it('asks, installs, refreshes the skill, and says to commit it', async () => {
    await installCopies()
    await appendFile(path.join(repo, CLAUDE_SKILLS_DIR, 'pr-review-canvas', 'SKILL.md'), '\nold\n')
    const { deps, calls } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' } })
    const { io, out, err } = capture()

    expect(await runUpgrade(deps, [], io)).toBe(0)
    expect(calls).toContain('install -g acpx@0.19.1')
    expect((await findSkillCopies(repo)).every(copy => !copy.stale)).toBe(true)
    expect(err.join('\n')).toContain(
      `Commit and push ${CLAUDE_SKILLS_DIR}/pr-review-canvas so your team gets it.`
    )
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ applied: true, ok: true })
  })

  it('hands the skill to the new pr-review after upgrading itself', async () => {
    await installCopies()
    await appendFile(path.join(repo, CODEX_SKILLS_DIR, 'pr-review-canvas', 'SKILL.md'), '\nold\n')
    const { deps, calls } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.19.1' } })
    const { io, out, err } = capture()

    expect(await runUpgrade(deps, [], io)).toBe(0)
    expect(calls).toContain(`pr-review 0.6.0 upgrade --yes --repo ${repo}`)
    expect((await findSkillCopies(repo)).every(copy => !copy.stale)).toBe(true)
    expect(JSON.parse(out[0] ?? '').steps).toEqual([
      { kind: 'package', name: NAME, from: '0.5.0', to: '0.6.0', status: 'done' },
      { kind: 'acpx', name: 'acpx', from: '0.13.2', to: '0.19.1', status: 'done' },
      { kind: 'skill', paths: [`${CODEX_SKILLS_DIR}/pr-review-canvas`], status: 'done' },
    ])
    expect(err.filter(line => line.startsWith('The project skill changed.'))).toEqual([
      `The project skill changed. Commit and push ${CODEX_SKILLS_DIR}/pr-review-canvas so your team gets it.`,
    ])
  })

  it('reports a new pr-review that does not answer as a failed skill step', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.13.2' }, garbledInstalled: true })
    const { io, out } = capture()
    expect(await runUpgrade(deps, ['--yes'], io)).toBe(1)
    expect(JSON.parse(out[0] ?? '').steps.at(-1)).toEqual({
      kind: 'skill',
      paths: [],
      status: 'failed',
      detail: 'the new pr-review did not report a result; run `pr-review upgrade` again\nboom',
    })
  })

  it('changes nothing when the answer is no, or when there is no one to ask', async () => {
    for (const answer of [false, null]) {
      const { deps, calls } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, confirm: answer })
      const { io, out, err } = capture()
      expect(await runUpgrade(deps, [], io)).toBe(0)
      expect(calls.some(call => call.startsWith('install'))).toBe(false)
      expect(JSON.parse(out[0] ?? '')).toMatchObject({ applied: false })
      expect(err.at(-1)).toBe(
        answer === null ? 'Nothing changed. Re-run with --yes to apply.' : 'Nothing changed.'
      )
    }
  })

  it('applies without asking under --yes', async () => {
    const { deps, calls } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, confirm: null })
    expect(await runUpgrade(deps, ['--yes'], capture().io)).toBe(0)
    expect(calls).toContain('install -g acpx@0.19.1')
  })

  it('leaves a stale skill directory it did not make, and says how to replace it', async () => {
    const handMade = path.join(repo, CLAUDE_SKILLS_DIR, 'pr-review-canvas')
    await mkdir(handMade, { recursive: true })
    await writeFile(path.join(handMade, 'SKILL.md'), '---\nname: pr-review-canvas\n---\nmine\n')
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.13.2' } })
    const { io, out, err } = capture()
    expect(await runUpgrade(deps, ['--yes'], io)).toBe(1)
    expect(JSON.parse(out[0] ?? '').steps).toEqual([
      {
        kind: 'skill',
        paths: [],
        status: 'failed',
        detail: `not a managed copy, left alone: ${CLAUDE_SKILLS_DIR}/pr-review-canvas; run \`pr-review install-skill --force\` to replace it`,
      },
    ])
    expect(err.some(line => line.startsWith('The project skill changed.'))).toBe(false)
  })

  it('hands off without --repo outside a repository', async () => {
    const { deps, calls } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.13.2' }, repoRoot: null })
    expect(await runUpgrade(deps, ['--yes'], capture().io)).toBe(0)
    expect(calls).toContain('pr-review 0.6.0 upgrade --yes')
  })

  it('names the install that failed when npm says nothing', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, failInstall: '' })
    const { io, out } = capture()
    expect(await runUpgrade(deps, ['--yes'], io)).toBe(1)
    expect(JSON.parse(out[0] ?? '').steps[0]).toMatchObject({
      status: 'failed',
      detail: 'npm install failed',
    })
  })

  it('reports a failed install and exits 1', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, failInstall: 'npm ERR! EACCES' })
    const { io, out } = capture()
    expect(await runUpgrade(deps, ['-y'], io)).toBe(1)
    expect(JSON.parse(out[0] ?? '')).toMatchObject({
      applied: true,
      ok: false,
      steps: [{ kind: 'acpx', status: 'failed', detail: 'npm ERR! EACCES' }],
    })
  })

  it('says so when everything is current', async () => {
    await installCopies()
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, acpx: '0.19.1' })
    const { io, out, err } = capture()
    expect(await runUpgrade(deps, [], io)).toBe(0)
    expect(err.at(-1)).toBe('Everything is up to date.')
    expect(JSON.parse(out[0] ?? '')).toEqual({ applied: false, steps: [], notes: expect.any(Array) })
  })
})
