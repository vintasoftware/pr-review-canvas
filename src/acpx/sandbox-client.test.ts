// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSandboxClient } from './sandbox-client.js'

let fixture: string
beforeEach(async () => {
  fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chat preparation-')))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(fixture, { recursive: true, force: true })
})

it.runIf(process.platform !== 'win32')(
  'keeps the event loop responsive and shares preparation across concurrent and later calls',
  async () => {
    const dcg = execFileSync('/bin/sh', ['-c', 'command -v dcg'], { encoding: 'utf8' }).trim()
    const count = path.join(fixture, 'probes')
    const bin = path.join(fixture, 'bin')
    await mkdir(bin)
    const wrapper = path.join(bin, 'dcg')
    await writeFile(
      wrapper,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nif (process.argv[2] === '--version') { appendFileSync(${JSON.stringify(count)}, 'probe\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }\nprocess.exit(spawnSync(${JSON.stringify(dcg)}, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1);\n`
    )
    await chmod(wrapper, 0o700)
    vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env['PATH']}`)
    const launch = createSandboxClient({ stateRoot: path.join(fixture, 'runtime'), home: fixture })
    let settled = false
    const pending = Promise.all([launch('/bin/true', [], fixture), launch('/bin/true', [], fixture)])
    void pending
      .finally(() => {
        settled = true
      })
      .catch(() => undefined)
    // This timer must run while the version subprocess is deliberately still sleeping.
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(settled).toBe(false)
    const [first, second] = await pending
    expect(second).toEqual(first)
    expect(await launch('/bin/true', [], fixture)).toEqual(first)
    expect(await readFile(count, 'utf8')).toBe('probe\n')
  },
  60_000
)

it('publishes one complete runtime when independent servers prepare concurrently', async () => {
  const stateRoot = path.join(fixture, 'runtime')
  const options = { stateRoot, home: fixture }
  const commands = await Promise.all([
    createSandboxClient(options)('/bin/true', [], fixture),
    createSandboxClient(options)('/bin/true', [], fixture),
  ])
  expect(commands[0]).toEqual(commands[1])
  const entries = await readdir(stateRoot)
  expect(entries).toHaveLength(1)
  expect(await readFile(path.join(stateRoot, entries[0]!, '.initialized'), 'utf8')).toBe('')
}, 120_000)

it.runIf(process.platform !== 'win32')(
  'leaves no published runtime after an import failure and allows retry',
  async () => {
    const stateRoot = path.join(fixture, 'runtime')
    const credential = path.join(fixture, '.claude.json')
    await writeFile(credential, 'fixture credentials', { mode: 0o000 })
    const launch = createSandboxClient({ stateRoot, home: fixture })
    try {
      await expect(launch('/bin/true', [], fixture)).rejects.toThrow(/EACCES|permission denied/)
      expect(await readdir(stateRoot)).toEqual([])
    } finally {
      await chmod(credential, 0o600)
    }
    await launch('/bin/true', [], fixture)
    const entries = await readdir(stateRoot)
    expect(entries).toHaveLength(1)
    expect(await readFile(path.join(stateRoot, entries[0]!, 'home/.claude.json'), 'utf8')).toBe(
      'fixture credentials'
    )
  },
  90_000
)
