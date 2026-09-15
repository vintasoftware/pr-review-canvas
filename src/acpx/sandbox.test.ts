// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentRunner } from './acpx.js'
import { fileURLToPath } from 'node:url'
import { agentPath, createSandbox } from './sandbox.js'

let fixture: string
beforeEach(async () => { fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat containment-'))) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(fixture, { recursive: true, force: true }) })

it('contains native writes in ensure, exec, prompt, and cancel while keeping sessions writable', async () => {
  // This is a required integration test: missing dcg/bwrap or denied namespaces must fail it.
  const repo = path.join(fixture, 'repo')
  const snapshots = path.join(fixture, 'snapshots')
  const home = path.join(fixture, 'host-home')
  const stateRoot = path.join(fixture, 'runtime')
  await Promise.all([repo, snapshots, home].map(dir => mkdir(dir)))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' })
  git('init')
  await writeFile(path.join(repo, 'tracked.txt'), 'committed')
  git('add', 'tracked.txt')
  git('-c', 'user.name=Containment Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture')
  await writeFile(path.join(repo, 'tracked.txt'), 'uncommitted work')
  const outside = path.join(fixture, 'outside.txt')
  const snapshot = path.join(snapshots, 'file.txt')
  await writeFile(outside, 'outside work')
  await writeFile(snapshot, 'snapshot content')
  await symlink(outside, path.join(repo, 'outside-link'))
  await writeFile(path.join(repo, 'containment.json'), JSON.stringify({ snapshot: agentPath(snapshot), outside: agentPath(outside) }))
  const before = git('status', '--porcelain')
  const head = git('rev-parse', 'HEAD')
  const bin = path.join(fixture, 'acpx')
  await writeFile(bin, await readFile(new URL('../testing/containment-acpx.mjs', import.meta.url)))
  await chmod(bin, 0o700)
  // Do not import the test operator's credentials or settings.
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'))
  const runner = createAgentRunner({ bin, sandbox: { stateRoot, home } })
  const options = { cwd: repo, agent: 'claude', session: 'containment', prompt: 'try writes', timeoutSec: 20 }
  await runner.ensureSession(options)
  expect(await runner.exec(options)).toMatchObject({ ok: true })
  const run = runner.run(options)
  const events = []
  for await (const event of run.events) events.push(event)
  expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end_turn' })
  await run.cancel()
  const runtime = path.join(stateRoot, (await readdir(stateRoot))[0]!)
  for (const stage of ['ensure', 'exec', 'prompt', 'cancel']) {
    const results = JSON.parse(await readFile(path.join(runtime, 'home', `${stage}.json`), 'utf8'))
    expect(results.scratch).toBe('allowed')
    expect(results.queueSocket).toBe('allowed')
    for (const action of ['overwrite', 'deletion', 'snapshotOverwrite', 'snapshotDeletion', 'outsideOverwrite', 'outsideCreation', 'symlinkOverwrite', 'guardOverwrite']) {
      expect(['EROFS', 'EPERM', 'EACCES'], `${stage}: ${action} was ${results[action]}`).toContain(results[action])
    }
    expect(results.gitReset, `${stage}: git reset`).not.toBe('allowed')
    expect(results.guardDeletion, `${stage}: guard deletion`).not.toBe('allowed')
    expect(results.guardDirectoryRename, `${stage}: guard directory rename`).not.toBe('allowed')
    expect(results.hardlinkOverwrite, `${stage}: hardlink`).not.toBe('allowed')
    if (results.windowsInterop !== undefined) expect(results.windowsInterop, `${stage}: Windows interop`).not.toBe('allowed')
  }
  expect(await readFile(path.join(repo, 'tracked.txt'), 'utf8')).toBe('uncommitted work')
  expect(await readFile(outside, 'utf8')).toBe('outside work')
  expect(await readFile(snapshot, 'utf8')).toBe('snapshot content')
  expect(git('rev-parse', 'HEAD')).toBe(head)
  expect(git('status', '--porcelain')).toBe(before)
}, 120_000)

it('fails closed before running an agent when dcg is missing', async () => {
  vi.stubEnv('PATH', fixture)
  if (process.platform === 'win32') vi.stubEnv('PR_REVIEW_WSL_DISTRO', 'pr-review-missing-distribution-test')
  const runner = createAgentRunner({ sandbox: { stateRoot: path.join(fixture, 'runtime'), home: fixture } })
  const options = { cwd: fixture, agent: 'claude', session: 'missing-dcg', prompt: 'hello', timeoutSec: 5 }
  expect(await runner.exec(options)).toMatchObject({ ok: false, code: 'AGENT_PERMISSION_DENIED', message: expect.stringMatching(/Install (Destructive Command Guard|Ubuntu WSL2)/) })
  const events = []
  for await (const event of runner.run(options).events) events.push(event)
  expect(events).toEqual([{ type: 'error', code: 'AGENT_PERMISSION_DENIED', message: expect.stringMatching(/Install (Destructive Command Guard|Ubuntu WSL2)/) }])
}, 30_000)

it('rejects runtime directory symlinks before importing settings', async () => {
  const outside = path.join(fixture, 'outside')
  const link = path.join(fixture, 'link')
  await mkdir(outside)
  await symlink(outside, link)
  const launch = createSandbox({ stateRoot: path.join(link, 'runtime'), home: fixture })
  if (process.platform === 'win32') {
    const command = launch('/bin/true', [], fixture)
    expect(() => execFileSync(command.file, command.args, { stdio: 'pipe' })).toThrow()
  } else {
    expect(() => launch('/bin/true', [], fixture)).toThrow('must not be a symlink')
  }
  expect(await readdir(outside)).toEqual([])
}, 60_000)

it('resumes two real acpx turns with writable session storage and denied native writes', async () => {
  const repo = path.join(fixture, 'repo')
  await mkdir(repo)
  await writeFile(path.join(repo, 'victim.txt'), 'preserve')
  const launch = createSandbox({ stateRoot: path.join(fixture, 'runtime'), home: fixture })
  const adapter = agentPath(fileURLToPath(new URL('../testing/sandbox-agent.mjs', import.meta.url)))
  const agent = `node '${adapter.replaceAll("'", "'\\''")}'`
  const common = ['--cwd', repo, '--format', 'json', '--approve-reads', '--no-terminal',
    '--non-interactive-permissions', 'deny', '--timeout', '20', '--ttl', '1', '--agent', agent]
  const call = (args: string[]): string => {
    const command = launch('acpx', [...common, ...args], repo)
    return execFileSync(command.file, command.args, { cwd: repo, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  expect(call(['sessions', 'ensure', '--name', 'smoke'])).toContain('session_ensured')
  for (const prompt of ['hello', 'again']) {
    const output = call(['prompt', '-s', 'smoke', prompt])
    expect(output).toMatch(/blocked: (EROFS|EPERM|EACCES)/)
    expect(output).toContain('"stopReason":"end_turn"')
  }
  expect(await readFile(path.join(repo, 'victim.txt'), 'utf8')).toBe('preserve')
}, 120_000)

it.runIf(process.platform !== 'win32')('runs the dependency-free WSL bridge without loading node_modules', () => {
  const request = Buffer.from(JSON.stringify({
    action: 'launch', file: 'node', args: ['-e', 'console.log("bridge ready")'], cwd: fixture,
    sandbox: { stateRoot: path.join(fixture, 'runtime'), home: fixture },
  })).toString('base64')
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL('./wsl-sandbox.mjs', import.meta.url)), '--pr-review-sandbox', request,
  ], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
  expect(output.trim()).toBe('bridge ready')
}, 30_000)

it.runIf(process.platform !== 'win32')('does not import credentials through links from a previous runtime', async () => {
  const home = path.join(fixture, 'host-home')
  const outside = path.join(fixture, 'outside')
  await mkdir(path.join(home, '.codex'), { recursive: true })
  await mkdir(outside)
  const options = { stateRoot: path.join(fixture, 'runtime'), home }
  createSandbox(options)('/bin/true', [], fixture)
  const key = createHash('sha256').update(`dcg-v1:${fixture}`).digest('hex')
  const agentHome = path.join(options.stateRoot, key, 'home', '.codex')
  await rm(agentHome, { recursive: true })
  await symlink(outside, agentHome)
  await writeFile(path.join(home, '.codex', 'auth.json'), '{"fixture":true}')
  expect(() => createSandbox(options)('/bin/true', [], fixture)).toThrow('Chat guard configuration changed')
  expect(await readdir(outside)).toEqual([])
})
