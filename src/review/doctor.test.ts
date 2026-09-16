// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DcgPolicyError } from '../acpx/sandbox.js'
import { type CliIo, runDoctor } from '../commands.js'
import { createFakeGh, createFakeGit, makeTempDir } from '../testing/fakes.js'
import { type DoctorDeps, formatDoctorReport, runDoctorChecks } from './doctor.js'
import { CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, SKILL_NAME, SKILL_SOURCE_DIR } from './install-skill.js'

import { stampSkill } from './skill-content.js'

const bundled = await readFile(path.join(SKILL_SOURCE_DIR, 'SKILL.md'), 'utf8')
const installed = stampSkill(bundled)
const REPO = '/repo'

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    git: createFakeGit({
      topLevel: REPO,
      commonDir: '/repo/.git',
      remotes: { origin: 'git@github.com:acme/widgets.git' },
    }),
    gh: createFakeGh(),
    version: '0.0.0-test',
    acpxVersion: async () => '0.13.2',
    dcgVersion: async () => '0.6.5',
    checkSandbox: async () => undefined,
    checkChatGuards: async () => 'chat hooks active',
    readSkill: async file =>
      file === path.join(REPO, CLAUDE_SKILLS_DIR, SKILL_NAME, 'SKILL.md') ? installed : null,
    ...over,
  }
}

describe('runDoctorChecks', () => {
  it('explains how to repair remote-service rules when dcg is already installed', async () => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        dcgVersion: async () => {
          throw new DcgPolicyError('dcg is installed, but cloud.aws:s3-rb was not blocked')
        },
      })
    )
    expect(report.checks.dcg).toMatchObject({ ok: false, detail: expect.stringContaining('cloud.aws:s3-rb') })
    expect(report.checks.dcg.hint).toContain('no personal dcg configuration is needed')
    expect(report.checks.dcg.hint).toContain('restore or reinstall the app’s bundled policy')
  })

  it('fails all-checks when dcg is installed but an agent hook is inactive', async () => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        checkChatGuards: async () => {
          throw new Error('Codex hook is untrusted')
        },
      }),
      { allChecks: true }
    )
    expect(report.ok).toBe(false)
    expect(report.checks.dcg.ok).toBe(true)
    expect(report.checks.chatGuards).toMatchObject({ ok: false, detail: 'Codex hook is untrusted' })
  })

  it.each(['missing', 'empty'])('requires dcg in the default doctor checks: %s', async mode => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        dcgVersion: async () => {
          if (mode === 'missing') throw new Error('spawn dcg ENOENT')
          return '   '
        },
      })
    )
    expect(report.ok).toBe(false)
    expect(report.checks.dcg).toMatchObject({
      ok: false,
      hint: expect.stringContaining('Install Destructive Command Guard'),
    })
  })

  it('fails all-checks when the sandbox is installed but unusable', async () => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        checkSandbox: async () => {
          throw new Error('user namespaces disabled')
        },
      }),
      { allChecks: true }
    )
    expect(report.ok).toBe(false)
    expect(report.checks.sandbox).toMatchObject({ ok: false, detail: 'user namespaces disabled' })
  })

  it.each([
    ['unstamped', bundled],
    ['edited body with unchanged hash', installed + '\nlocal edit'],
    ['older release', stampSkill(bundled + '\nold instructions')],
    ['invalid frontmatter', 'broken'],
  ])('reports a %s copy even when the other harness is current', async (_, stale) => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        readSkill: async file => (file.includes(CLAUDE_SKILLS_DIR) ? installed : stale),
      })
    )
    expect(report.checks.skill.ok).toBe(false)
    expect(report.checks.skill.detail).toContain(CODEX_SKILLS_DIR)
    expect(report.checks.skill.hint).toBe('run `pr-review install-skill`')
  })

  it('accepts copies after Git converts line endings to CRLF', async () => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        readSkill: async () => installed.replace(/\n/g, '\r\n'),
      })
    )
    expect(report.checks.skill.ok).toBe(true)
  })

  it('reports every check green on a working setup', async () => {
    const dataDir = await makeTempDir()
    const acpxVersion = vi.fn(async () => null)
    const report = await runDoctorChecks(deps({ dataDirOverride: dataDir, acpxVersion }))
    expect(acpxVersion).not.toHaveBeenCalled()
    expect(report).toEqual({
      ok: true,
      version: '0.0.0-test',
      checks: {
        git: { ok: true, detail: REPO },
        origin: { ok: true, detail: 'acme/widgets' },
        gh: { ok: true, detail: 'Logged in to github.com' },
        ghAuth: { ok: true, detail: 'Logged in to github.com' },
        dataDir: { ok: true, detail: dataDir },
        skill: { ok: true, detail: path.join(CLAUDE_SKILLS_DIR, SKILL_NAME) },
        dcg: { ok: true, detail: '0.6.5' },
      },
    })
  })

  it('looks for the SKILL.md, so an empty directory does not count as installed', async () => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        readSkill: async () => {
          throw Object.assign(new Error('is a directory'), { code: 'EISDIR' })
        },
      })
    )
    expect(report.checks.skill.ok).toBe(false)
  })

  it('names both skill directories when the skill is copied into both', async () => {
    const dataDir = await makeTempDir()
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: dataDir,
        readSkill: async () => installed,
      })
    )
    expect(report.checks.skill).toEqual({
      ok: true,
      detail: `${path.join(CLAUDE_SKILLS_DIR, SKILL_NAME)}, ${path.join(CODEX_SKILLS_DIR, SKILL_NAME)}`,
    })
  })

  it('reports what is wrong and how to fix it, one hint per failing check', async () => {
    // A data dir under a regular file cannot be created, which is the failure a read-only or
    // wrongly owned path produces too.
    const blocked = path.join(await makeTempDir(), 'a-file', 'data')
    await writeFile(path.dirname(blocked), '', 'utf8')
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({ commonDir: '/repo/.git', remotes: {} }),
        gh: createFakeGh({ auth: { installed: false, authenticated: false, detail: 'gh is not on PATH' } }),
        dataDirOverride: blocked,
        readSkill: async () => null,
      })
    )
    expect(report.ok).toBe(false)
    expect(report.checks.git.ok).toBe(false)
    expect(report.checks.git.hint).toBe('run from a clone or pass --repo <dir>')
    expect(report.checks.origin).toEqual({
      ok: false,
      detail: 'no origin remote',
      hint: 'add a github.com origin',
    })
    expect(report.checks.gh).toEqual({
      ok: false,
      detail: 'gh is not on PATH',
      hint: 'install it from https://cli.github.com',
    })
    expect(report.checks.ghAuth.hint).toBe('run `gh auth login`')
    expect(report.checks.dataDir.ok).toBe(false)
    expect(report.checks.dataDir.hint).toBe('pass --data-dir <dir> to a writable place')
    // Without a repository there is no place to look for the skill.
    expect(report.checks.skill).toEqual({
      ok: false,
      detail: 'no repository, so no skill directory to look in',
      hint: 'run from a clone',
    })
  })

  it('reports a remote that is not GitHub and a missing skill', async () => {
    const dataDir = await makeTempDir()
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({
          topLevel: REPO,
          commonDir: '/repo/.git',
          remotes: { origin: 'https://gitlab.com/acme/widgets.git' },
        }),
        dataDirOverride: dataDir,
        readSkill: async () => null,
      })
    )
    expect(report.checks.origin).toEqual({
      ok: false,
      detail: 'https://gitlab.com/acme/widgets.git',
      hint: 'add a github.com origin',
    })
    expect(report.checks.skill).toEqual({
      ok: false,
      detail: `${SKILL_NAME} is in neither ${CLAUDE_SKILLS_DIR} nor ${CODEX_SKILLS_DIR}`,
      hint: 'run `pr-review install-skill`',
    })
  })

  it('reports a thrown value that is not an Error', async () => {
    const git = createFakeGit({ commonDir: '/repo/.git' })
    const report = await runDoctorChecks(
      deps({
        git: {
          ...git,
          topLevel: async (): Promise<string> => {
            // A child process can reject with a string.
            throw 'not an Error'
          },
        },
        dataDirOverride: await makeTempDir(),
      })
    )
    expect(report.checks.git.detail).toBe('not an Error')
  })

  it('reports the failures of git itself rather than throwing', async () => {
    const git = createFakeGit({ topLevel: REPO, remotes: { origin: 'git@github.com:acme/widgets.git' } })
    const failing = {
      ...git,
      commonDir: async (): Promise<string> => {
        throw new Error('fatal: not a git repository')
      },
      remoteUrl: async (): Promise<string | null> => {
        throw new Error('fatal: no remotes')
      },
    }
    const report = await runDoctorChecks(deps({ git: failing }))
    expect(report.checks.origin).toEqual({
      ok: false,
      detail: 'fatal: no remotes',
      hint: 'add a github.com origin',
    })
    expect(report.checks.dataDir).toEqual({
      ok: false,
      detail: 'fatal: not a git repository',
      hint: 'pass --data-dir <dir>',
    })
  })
})

describe('pr-review doctor', () => {
  const lines: string[] = []
  const io: CliIo = { stdout: l => lines.push(l), stderr: () => undefined }
  beforeEach(() => {
    lines.length = 0
  })

  it('prints readable checks and installation instructions by default', async () => {
    const code = await runDoctor(
      deps({
        dataDirOverride: await makeTempDir(),
        dcgVersion: async () => {
          throw new Error('dcg not found')
        },
      }),
      [],
      io
    )
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('PASS Git repository')
    expect(lines.join('\n')).toContain('FAIL dcg and required chat policy: dcg not found')
    expect(lines.join('\n')).toContain('Next steps')
    expect(lines.join('\n')).toContain('Install Destructive Command Guard')
    expect(lines.join('\n')).toContain('https://github.com/Dicklesworthstone/destructive_command_guard')
  })

  it.each(['linux', 'darwin', 'win32'] as const)('gives installation instructions for %s', async platform => {
    const report = await runDoctorChecks(
      deps({
        dataDirOverride: await makeTempDir(),
        acpxVersion: async () => null,
        checkSandbox: async () => {
          throw new Error('sandbox unavailable')
        },
      }),
      { allChecks: true }
    )
    const text = formatDoctorReport(report, platform)
    expect(text).toContain('npm install -g acpx@0.13.2')
    expect(text).toContain(
      platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'sudo apt-get install bubblewrap'
    )
    if (platform === 'win32') {
      expect(text).toContain('wsl --install -d Ubuntu')
      expect(text).toContain('A Windows-only installation does not satisfy chat checks')
    }
  })

  it('prints one JSON line and exits 0 when everything is in place', async () => {
    const dataDir = await makeTempDir()
    const code = await runDoctor(deps({ dataDirOverride: dataDir }), ['--json'], io)
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: true, version: '0.0.0-test' })
  })

  it.each([
    { version: '0.13.2', check: { ok: true, detail: '0.13.2' }, exit: 0 },
    ...[null, '', '   '].map(version => ({
      version,
      check: {
        ok: false,
        detail: 'acpx is missing or could not report its version',
        hint: 'install with `npm install -g acpx` and check `acpx --version`',
      },
      exit: 1,
    })),
  ])('checks acpx with --all-checks when its version is $version', async ({ version, check, exit }) => {
    const dependencies = deps({
      dataDirOverride: await makeTempDir(),
      acpxVersion: vi.fn(async () => version),
    })
    const core = await runDoctorChecks(dependencies)
    const code = await runDoctor(dependencies, ['--all-checks', '--json'], io)
    expect(code).toBe(exit)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        ...core,
        ok: exit === 0,
        checks: {
          ...core.checks,
          chatGuards: { ok: true, detail: 'chat hooks active' },
          sandbox: { ok: true, detail: 'filesystem containment is available' },
          acpx: check,
        },
      },
    ])
    expect(dependencies.acpxVersion).toHaveBeenCalledOnce()
  })

  it('reports a failed acpx process as a check failure', async () => {
    const dependencies = deps({
      dataDirOverride: await makeTempDir(),
      acpxVersion: async () => {
        throw new Error('process timed out')
      },
    })
    const core = await runDoctorChecks(dependencies)
    expect(await runDoctor(dependencies, ['--all-checks', '--json'], io)).toBe(1)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        ...core,
        ok: false,
        checks: {
          ...core.checks,
          chatGuards: { ok: true, detail: 'chat hooks active' },
          sandbox: { ok: true, detail: 'filesystem containment is available' },
          acpx: {
            ok: false,
            detail: 'process timed out',
            hint: 'install with `npm install -g acpx` and check `acpx --version`',
          },
        },
      },
    ])
  })

  it('keeps core failures when acpx is installed', async () => {
    const dependencies = deps({ dataDirOverride: await makeTempDir(), readSkill: async () => null })
    const core = await runDoctorChecks(dependencies)
    expect(await runDoctor(dependencies, ['--all-checks', '--json'], io)).toBe(1)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        ...core,
        ok: false,
        checks: {
          ...core.checks,
          chatGuards: { ok: true, detail: 'chat hooks active' },
          sandbox: { ok: true, detail: 'filesystem containment is available' },
          acpx: { ok: true, detail: '0.13.2' },
        },
      },
    ])
  })

  it('exits 1 when a check fails, and refuses an unknown flag', async () => {
    const code = await runDoctor(deps({ git: createFakeGit({ remotes: {} }) }), ['--json'], io)
    expect(code).toBe(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: false })
    await expect(runDoctor(deps(), ['--wat'], io)).rejects.toThrow(/wat/)
  })
})
