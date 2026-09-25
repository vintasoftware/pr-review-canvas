// @vitest-environment node
import { Writable } from 'node:stream'
import { visibleText } from '../cli-text.js'
import { type CliIo, runDoctor } from '../commands.js'
import { createFakeGh, createFakeGit, makeTempDir } from '../testing/fakes.js'
import type { DoctorDeps, DoctorReport } from './doctor.js'
import { printDoctorReport } from './doctor-view.js'

function linesOf(write: (output: Writable) => void): string[] {
  let text = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk)
      callback()
    },
  })
  write(output)
  return visibleText(text).split('\n')
}

function report(over: Partial<DoctorReport['checks']> = {}): DoctorReport {
  return {
    ok: true,
    version: '0.5.0',
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
    const lines = linesOf(output => printDoctorReport(report(), output, 80))
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

  it('names glab when the origin is GitLab', () => {
    const page = linesOf(output =>
      printDoctorReport(report({ origin: { ok: true, detail: 'acme/widgets (GitLab)' } }), output, 80)
    ).join('\n')
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
    const lines = linesOf(output => printDoctorReport(failed, output, 60))
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
    const page = linesOf(output => printDoctorReport(failed, output, 80)).join('\n')
    expect(page).toContain('2 checks failed')
    expect(page).toContain('not logged in')
    expect(page).toContain('acpx is missing')
  })

  it('includes acpx only when the report has it', () => {
    const withAcpx = report({ acpx: { ok: true, detail: '0.13.2' } })
    const page = linesOf(output => printDoctorReport(withAcpx, output, 80)).join('\n')
    expect(page).toContain('0.13.2')
    expect(linesOf(output => printDoctorReport(report(), output, 80)).join('\n')).not.toContain('acpx')
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

  it('prints a checklist by default, for a person or an agent', async () => {
    const dataDir = await makeTempDir()
    const lines: string[] = []
    const io: CliIo = { stdout: line => lines.push(line), stderr: () => undefined }
    const code = await runDoctor({ ...deps(), dataDirOverride: dataDir }, [], io)
    const page = lines.join('\n')
    expect(code).toBe(1)
    expect(page).toContain('ok')
    expect(page).toContain('failed')
    expect(page).toContain('pr-review install-skill')
    expect(page).not.toContain('{"ok"')
  })

  it('keeps the JSON line when --json is set', async () => {
    const dataDir = await makeTempDir()
    const lines: string[] = []
    const io: CliIo = { stdout: line => lines.push(line), stderr: () => undefined }
    const code = await runDoctor({ ...deps(), dataDirOverride: dataDir }, ['--json'], io)
    expect(code).toBe(1)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: false, version: '0.0.0-test' })
  })
})
