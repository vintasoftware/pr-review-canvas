// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type CliIo, runDoctor } from '../commands.js'
import { ORIGIN_HINT } from '../config.js'
import type { Host } from '../host/host.js'
import { PROMPTS_DIR } from '../paths.js'
import { baseLine } from '../prompt-bases.js'
import { createFakeGh, createFakeGit, createFakeTerminal, makeTempDir } from '../testing/fakes.js'
import { type DoctorDeps, runDoctorChecks } from './doctor.js'
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
    env: {},
    client: () => createFakeGh(),
    version: '0.0.0-test',
    acpxVersion: async () => '0.13.2',
    readSkill: async file =>
      file === path.join(REPO, CLAUDE_SKILLS_DIR, SKILL_NAME, 'SKILL.md') ? installed : null,
    ...over,
  }
}

describe('runDoctorChecks', () => {
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
    expect(report.checks.skill.hint).toBe('run `pr-review upgrade` or `pr-review install-skill`')
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
      cli: 'gh',
      checks: {
        git: { ok: true, detail: REPO },
        origin: { ok: true, detail: 'acme/widgets (GitHub)' },
        gh: { ok: true, detail: 'Logged in to github.com' },
        ghAuth: { ok: true, detail: 'Logged in to github.com' },
        dataDir: { ok: true, detail: dataDir },
        skill: { ok: true, detail: path.join(CLAUDE_SKILLS_DIR, SKILL_NAME) },
        prompts: { ok: true, detail: 'bundled templates' },
      },
    })
  })

  it('names the tokens the project’s own templates lack, from every release up to this one', async () => {
    const repo = await makeTempDir()
    // Copied from this version's bundled template, so the missing tokens are all there is to say.
    const format = await readFile(path.join(PROMPTS_DIR, 'generation-format.md'), 'utf8')
    const line = baseLine('generation-format.md', '0.6.0', format)
    await writeFile(path.join(repo, 'format.md'), `${line}\n## Attention points\n`)
    await writeFile(path.join(repo, 'pr-review.config.yml'), 'prompts:\n  generation-format.md: format.md\n')
    const addedTokens = [
      { since: '0.5.0', template: 'generation-format.md', token: 'MAX_POINTS' },
      { since: '0.6.0', template: 'generation-format.md', token: 'RESOLVED' },
      // A release after this one: its template is not the one installed here.
      { since: '0.7.0', template: 'generation-format.md', token: 'LATER' },
    ] as const
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({ topLevel: repo, commonDir: path.join(repo, '.git'), remotes: {} }),
        dataDirOverride: await makeTempDir(),
        version: '0.6.0',
        addedTokens,
      })
    )
    expect(report.checks.prompts).toEqual({
      ok: false,
      detail: 'own templates lack tokens: {{MAX_POINTS}} in format.md, {{RESOLVED}} in format.md',
      hint:
        'add {{MAX_POINTS}} to format.md under "## Attention points", where pr-review 0.5.0\'s generation-format.md has it; ' +
        'add {{RESOLVED}} to format.md under "## Attention points", where pr-review 0.6.0\'s generation-format.md has it',
    })
    await writeFile(path.join(repo, 'format.md'), `${line}\n{{MAX_POINTS}} {{RESOLVED}}\n`)
    const fixed = await runDoctorChecks(
      deps({
        git: createFakeGit({ topLevel: repo, commonDir: path.join(repo, '.git'), remotes: {} }),
        dataDirOverride: await makeTempDir(),
        version: '0.6.0',
        addedTokens,
      })
    )
    expect(fixed.checks.prompts).toEqual({
      ok: true,
      detail: "own templates are based on this pr-review's: generation-format.md",
    })
  })

  it('names the own templates copied from another version of the bundled ones', async () => {
    const repo = await makeTempDir()
    await writeFile(path.join(repo, 'format.md'), '{{RESOLVED}} {{SETTLED_DECISIONS}} {{WRITING}}\n')
    await writeFile(path.join(repo, 'pr-review.config.yml'), 'prompts:\n  generation-format.md: format.md\n')
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({ topLevel: repo, commonDir: path.join(repo, '.git'), remotes: {} }),
        dataDirOverride: await makeTempDir(),
        version: '0.11.1',
      })
    )
    // A copy without a base line counts as copied from 0.10.0, and generation-format.md changed since.
    expect(report.checks.prompts).toMatchObject({
      ok: false,
      detail: "copied from another version of pr-review's templates: format.md",
    })
    expect(report.checks.prompts?.hint).toMatch(
      /^format\.md: pr-review's generation-format\.md changed after 0\.10\.0, .*compare\/v0\.10\.0\.\.\.v0\.11\.1, then make `<!-- pr-review-canvas 0\.11\.1 generation-format\.md [0-9a-f]{12} -->` its first line$/
    )
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

  it('names an origin it cannot use without the token kept in its URL', async () => {
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({ remotes: { origin: 'https://oauth2:glpat-secret@bitbucket.org/a/b.git' } }),
      })
    )
    expect(report.checks.origin).toEqual({
      ok: false,
      detail: 'https://***@bitbucket.org/a/b.git',
      hint: ORIGIN_HINT,
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
        client: () =>
          createFakeGh({ auth: { installed: false, authenticated: false, detail: 'gh is not on PATH' } }),
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
      hint: ORIGIN_HINT,
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

  it('checks glab, not gh, when origin is GitLab, including a self-hosted one named by the environment', async () => {
    const asked: Host[] = []
    const report = await runDoctorChecks(
      deps({
        git: createFakeGit({
          topLevel: REPO,
          commonDir: '/repo/.git',
          remotes: { origin: 'git@git.company.com:group/sub/app.git' },
        }),
        env: { PR_REVIEW_HOST: 'gitlab' },
        client: host => {
          asked.push(host)
          return createFakeGh({
            auth: { installed: false, authenticated: false, detail: 'glab is not on PATH' },
          })
        },
        dataDirOverride: await makeTempDir(),
      })
    )
    expect(asked.map(h => [h.kind, h.hostname])).toEqual([['gitlab', 'git.company.com']])
    expect(report.cli).toBe('glab')
    expect(report.checks.origin).toEqual({ ok: true, detail: 'group/sub/app (GitLab)' })
    expect(report.checks.gh).toEqual({
      ok: false,
      detail: 'glab is not on PATH',
      hint: 'install it from https://gitlab.com/gitlab-org/cli',
    })
    expect(report.checks.ghAuth.hint).toBe('run `glab auth login`')
  })

  it('accepts a GitLab origin and still reports a missing skill', async () => {
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
      ok: true,
      detail: 'acme/widgets (GitLab)',
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
    expect(report.checks.origin).toEqual({ ok: false, detail: 'fatal: no remotes', hint: ORIGIN_HINT })
    expect(report.checks.dataDir).toEqual({
      ok: false,
      detail: 'fatal: not a git repository',
      hint: 'pass --data-dir <dir>',
    })
  })
})

describe('pr-review doctor', () => {
  const lines: string[] = []
  const io: CliIo = { stdout: l => lines.push(l), stderr: () => undefined, json: true }
  const { output } = createFakeTerminal()
  beforeEach(() => {
    lines.length = 0
  })

  it('prints one JSON line and exits 0 when everything is in place', async () => {
    const dataDir = await makeTempDir()
    const code = await runDoctor(deps({ dataDirOverride: dataDir }), [], io, output)
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: true, version: '0.0.0-test', cli: 'gh' })
  })

  it.each([
    { version: '0.13.2', check: { ok: true, detail: '0.13.2' }, exit: 0 },
    ...[null, '', '   '].map(version => ({
      version,
      check: {
        ok: false,
        detail: 'acpx is missing or could not report its version',
        hint: 'install with `npm install -g acpx@latest` and check `acpx --version`',
      },
      exit: 1,
    })),
  ])('checks acpx with --all-checks when its version is $version', async ({ version, check, exit }) => {
    const dependencies = deps({
      dataDirOverride: await makeTempDir(),
      acpxVersion: vi.fn(async () => version),
    })
    const core = await runDoctorChecks(dependencies)
    const code = await runDoctor(dependencies, ['--all-checks'], io, output)
    expect(code).toBe(exit)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { ...core, ok: exit === 0, checks: { ...core.checks, acpx: check } },
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
    expect(await runDoctor(dependencies, ['--all-checks'], io, output)).toBe(1)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      {
        ...core,
        ok: false,
        checks: {
          ...core.checks,
          acpx: {
            ok: false,
            detail: 'process timed out',
            hint: 'install with `npm install -g acpx@latest` and check `acpx --version`',
          },
        },
      },
    ])
  })

  it('keeps core failures when acpx is installed', async () => {
    const dependencies = deps({ dataDirOverride: await makeTempDir(), readSkill: async () => null })
    const core = await runDoctorChecks(dependencies)
    expect(await runDoctor(dependencies, ['--all-checks'], io, output)).toBe(1)
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { ...core, ok: false, checks: { ...core.checks, acpx: { ok: true, detail: '0.13.2' } } },
    ])
  })

  it('exits 1 when a check fails, and refuses an unknown flag', async () => {
    const code = await runDoctor(deps({ git: createFakeGit({ remotes: {} }) }), [], io, output)
    expect(code).toBe(1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ ok: false })
    await expect(runDoctor(deps(), ['--wat'], io, output)).rejects.toThrow(/wat/)
  })
})
