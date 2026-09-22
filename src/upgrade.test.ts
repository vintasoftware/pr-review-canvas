// @vitest-environment node
import { appendFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CliIo } from './commands.js'
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

/** npm answers from `latest`; a name missing from it is one npm cannot find. */
function fake(opts: {
  version?: string
  latest?: Record<string, string>
  /** The installed acpx version; null means acpx is not on PATH. */
  acpx?: string | null
  acpxPath?: string
  confirm?: boolean | null
  failInstall?: boolean
  packageRoot?: string
}): Fake {
  const calls: string[] = []
  const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' })
  const deps: UpgradeDeps = {
    packageName: NAME,
    version: opts.version ?? '0.5.0',
    packageRoot: opts.packageRoot ?? packageRoot,
    repoRoot: repo,
    acpxVersion: async () => (opts.acpx === undefined ? '0.13.2' : opts.acpx),
    acpxPath: opts.acpx === null ? null : (opts.acpxPath ?? globalAcpx),
    run: async (_file, args) => {
      calls.push(args.join(' '))
      if (args[0] === 'view') {
        const version = opts.latest?.[args[1] ?? '']
        return version === undefined ? { ok: false, stdout: '', stderr: 'E404' } : ok(`${version}\n`)
      }
      if (args[0] === 'root') return ok(`${globalRoot}\n`)
      return opts.failInstall ? { ok: false, stdout: '', stderr: 'npm ERR! EACCES' } : ok('')
    },
    confirm: async () => (opts.confirm === undefined ? true : opts.confirm),
  }
  return { deps, calls }
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
  it('plans pr-review, acpx, and a skill check after the package moves', async () => {
    await installCopies()
    const { deps } = fake({ latest: { [NAME]: '0.6.0', acpx: '0.19.1' } })
    expect((await planUpgrade(deps)).steps).toEqual([
      { kind: 'package', name: NAME, from: '0.5.0', to: '0.6.0' },
      { kind: 'acpx', name: 'acpx', from: '0.13.2', to: '0.19.1' },
      {
        kind: 'skill',
        paths: [`${CLAUDE_SKILLS_DIR}/pr-review-canvas`, `${CODEX_SKILLS_DIR}/pr-review-canvas`],
        afterPackage: true,
      },
    ])
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
      { kind: 'skill', paths: [`${CODEX_SKILLS_DIR}/pr-review-canvas`], afterPackage: false },
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

  it('reports a failed install and exits 1', async () => {
    const { deps } = fake({ latest: { [NAME]: '0.5.0', acpx: '0.19.1' }, failInstall: true })
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
