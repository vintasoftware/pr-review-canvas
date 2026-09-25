// @vitest-environment node
import { type CliIo, runDoctor } from '../commands.js'
import { createFakeGh, createFakeGit, createFakeTerminal, makeTempDir } from '../testing/fakes.js'
import type { DoctorDeps, DoctorReport } from './doctor.js'
import { printDoctorReport } from './doctor-view.js'

function linesOf(doctorReport: DoctorReport, columns = 80): string[] {
  const terminal = createFakeTerminal(columns)
  printDoctorReport(doctorReport, terminal.output)
  return terminal.text().split('\n')
}

function report(over: Partial<DoctorReport['checks']> = {}): DoctorReport {
  return {
    ok: true,
    version: '0.5.0',
    cli: 'gh',
    checks: {
      git: { ok: true, detail: '/repo' },
      origin: { ok: true, detail: 'acme/widgets (GitHub)' },
      gh: { ok: true, detail: 'github.com' },
      ghAuth: { ok: true, detail: 'github.com' },
      dataDir: { ok: true, detail: '/repo/.pr-review' },
      skill: { ok: true, detail: '.claude/skills/pr-review-canvas, .agents/skills/pr-review-canvas' },
      ...over,
    },
  }
}

describe('printDoctorReport', () => {
  it('lists each check and closes when they pass', () => {
    const lines = linesOf(report())
    const page = lines.join('\n')
    expect(page).toContain('pr-review doctor 0.5.0')
    expect(page).toContain('git')
    expect(page).toContain('ok')
    expect(page).toContain('/repo')
    expect(page).toContain('gh login')
    expect(page).toContain('All checks passed')
    expect(page).not.toContain('failed')
    expect(page).not.toContain('{"ok"')
    expect(lines.every(line => line.length <= 80)).toBe(true)
  })

  it('names glab when the report ran glab', () => {
    const page = linesOf({ ...report(), cli: 'glab' }).join('\n')
    expect(page).toContain('glab login')
    expect(page).not.toContain('gh login')
  })

  it('shows the hint under a failed check and wraps a long detail', () => {
    const failed = report({
      skill: {
        ok: false,
        detail: 'outdated or modified skill: .agents/skills/pr-review-canvas',
        hint: 'run `pr-review upgrade` or `pr-review install-skill`',
      },
    })
    failed.ok = false
    const lines = linesOf(failed, 60)
    const page = lines.join('\n')
    expect(page).toContain('failed')
    expect(page).toContain('1 check failed')
    expect(lines.some(line => line.includes('pr-review install-skill'))).toBe(true)
    expect(lines.every(line => line.length <= 60)).toBe(true)
  })

  it('counts several failures, including a blank detail and a failed acpx', () => {
    const failed = report({
      git: { ok: true, detail: '   ' },
      ghAuth: { ok: false, detail: 'not logged in', hint: 'run `gh auth login`' },
      acpx: { ok: false, detail: 'acpx is missing or could not report its version' },
    })
    failed.ok = false
    const page = linesOf(failed).join('\n')
    expect(page).toContain('2 checks failed')
    expect(page).toContain('not logged in')
    expect(page).toContain('acpx is missing')
  })

  it('includes acpx only when the report has it', () => {
    const withAcpx = report({ acpx: { ok: true, detail: '0.13.2' } })
    const page = linesOf(withAcpx).join('\n')
    expect(page).toContain('0.13.2')
    expect(linesOf(report()).join('\n')).not.toContain('acpx')
  })
})

describe('pr-review doctor presentation', () => {
  const deps = (): DoctorDeps => ({
    git: createFakeGit({
      topLevel: '/repo',
      commonDir: '/repo/.git',
      remotes: { origin: 'git@github.com:acme/widgets.git' },
    }),
    env: {},
    client: () => createFakeGh(),
    version: '0.0.0-test',
    acpxVersion: async () => '0.13.2',
    readSkill: async () => null,
  })

  it('prints a checklist by default, one line per detail and hint on a pipe', async () => {
    const dataDir = await makeTempDir()
    const lines: string[] = []
    const io: CliIo = { stdout: line => lines.push(line), stderr: () => undefined }
    const terminal = createFakeTerminal()
    const code = await runDoctor({ ...deps(), dataDirOverride: dataDir }, [], io, terminal.output)
    const page = terminal.text().split('\n')
    expect(code).toBe(1)
    expect(lines).toEqual([])
    expect(page.some(line => line.includes('ok'))).toBe(true)
    expect(
      page.some(line =>
        line.includes('failed  pr-review-canvas is in neither .claude/skills nor .agents/skills')
      )
    ).toBe(true)
    expect(page.some(line => line.includes('run `pr-review install-skill`'))).toBe(true)
    expect(page.join('\n')).not.toContain('{"ok"')
  })

  it('keeps the JSON line when --json is set', async () => {
    const dataDir = await makeTempDir()
    const lines: string[] = []
    const io: CliIo = { stdout: line => lines.push(line), stderr: () => undefined }
    const terminal = createFakeTerminal()
    const code = await runDoctor({ ...deps(), dataDirOverride: dataDir }, ['--json'], io, terminal.output)
    expect(code).toBe(1)
    expect(terminal.text()).toBe('')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: false, version: '0.0.0-test' })
  })
})
