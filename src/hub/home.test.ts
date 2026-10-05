// @vitest-environment node
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeTempDir } from '../testing/fakes.js'
import {
  hubHome,
  processAlive,
  readAppearance,
  readRegistry,
  readServerInfo,
  removeServerInfo,
  type ServerInfo,
  writeAppearance,
  writeRegistry,
  writeServerInfo,
} from './home.js'

const info: ServerInfo = { pid: 4242, port: 3010, version: '1.0.0', token: 'secret' }

let dir: string
beforeEach(async () => {
  dir = await makeTempDir()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('hubHome', () => {
  it('defaults to ~/.pr-review', () => {
    expect(hubHome({})).toBe(path.join(os.homedir(), '.pr-review'))
  })

  it('falls back to the default when PR_REVIEW_HOME is empty', () => {
    expect(hubHome({ PR_REVIEW_HOME: '' })).toBe(path.join(os.homedir(), '.pr-review'))
  })

  it('uses PR_REVIEW_HOME, resolved', () => {
    expect(hubHome({ PR_REVIEW_HOME: '/tmp/hub/../home' })).toBe(path.resolve('/tmp/home'))
  })
})

describe('server info', () => {
  it('round trips, in an owner-only file inside an owner-only folder', async () => {
    const home = path.join(dir, 'home')
    await writeServerInfo(home, info)
    expect(await readServerInfo(home)).toEqual(info)
    expect((await stat(path.join(home, 'server.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(home)).mode & 0o777).toBe(0o700)
  })

  it('reads null when the file is missing', async () => {
    expect(await readServerInfo(dir)).toBeNull()
  })

  it('reads null when the file is not JSON or misses fields', async () => {
    await writeFile(path.join(dir, 'server.json'), '{oops')
    expect(await readServerInfo(dir)).toBeNull()
    await writeFile(path.join(dir, 'server.json'), JSON.stringify({ ...info, token: '' }))
    expect(await readServerInfo(dir)).toBeNull()
  })

  it('is removed only by the pid it names', async () => {
    await writeServerInfo(dir, info)
    await removeServerInfo(dir, info.pid + 1)
    expect(await readServerInfo(dir)).toEqual(info)
    await removeServerInfo(dir, info.pid)
    expect(await readServerInfo(dir)).toBeNull()
  })

  it('removing a missing file does nothing', async () => {
    await expect(removeServerInfo(dir, info.pid)).resolves.toBeUndefined()
  })
})

describe('registry', () => {
  const projects = [
    { basePath: '/r/acme/widgets/', repoRoot: '/src/widgets' },
    { basePath: '/r/acme/widgets~wt/', repoRoot: '/wt' },
  ]

  it('round trips, creating the folder', async () => {
    const home = path.join(dir, 'nested', 'home')
    await writeRegistry(home, projects)
    expect(await readRegistry(home)).toEqual(projects)
    expect(JSON.parse(await readFile(path.join(home, 'projects.json'), 'utf8'))).toEqual({ projects })
  })

  it('reads as empty when missing or invalid', async () => {
    expect(await readRegistry(dir)).toEqual([])
    await writeFile(path.join(dir, 'projects.json'), 'not json')
    expect(await readRegistry(dir)).toEqual([])
    await writeFile(path.join(dir, 'projects.json'), JSON.stringify({ projects: [{ basePath: 1 }] }))
    expect(await readRegistry(dir)).toEqual([])
  })

  it('throws on a read error other than a missing file', async () => {
    await mkdir(path.join(dir, 'projects.json'))
    await expect(readRegistry(dir)).rejects.toThrow()
  })
})

describe('appearance', () => {
  it('reads as the defaults when missing or invalid', async () => {
    expect(await readAppearance(dir)).toEqual({ skin: 'github', theme: 'auto' })
    await writeFile(path.join(dir, 'appearance.json'), 'not json')
    expect(await readAppearance(dir)).toEqual({ skin: 'github', theme: 'auto' })
    await writeFile(path.join(dir, 'appearance.json'), JSON.stringify({ skin: 'neon', theme: 'dark' }))
    expect(await readAppearance(dir)).toEqual({ skin: 'github', theme: 'auto' })
  })

  it('saves the fields given over the saved ones, creating the folder, and returns the result', async () => {
    const home = path.join(dir, 'nested', 'home')
    expect(await writeAppearance(home, { theme: 'dark' })).toEqual({ skin: 'github', theme: 'dark' })
    expect((await stat(home)).mode & 0o777).toBe(0o700)
    expect(await writeAppearance(home, { skin: 'terminal' })).toEqual({ skin: 'terminal', theme: 'dark' })
    expect(await readAppearance(home)).toEqual({ skin: 'terminal', theme: 'dark' })
    expect(await writeAppearance(home, { skin: 'olive', theme: 'light' })).toEqual({
      skin: 'olive',
      theme: 'light',
    })
    expect(JSON.parse(await readFile(path.join(home, 'appearance.json'), 'utf8'))).toEqual({
      skin: 'olive',
      theme: 'light',
    })
  })
})

describe('processAlive', () => {
  it('is true for this process', () => {
    expect(processAlive(process.pid)).toBe(true)
  })

  it('is false for a process that exited', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    const pid = child.pid
    await new Promise(resolve => child.once('exit', resolve))
    expect(pid).toBeDefined()
    expect(processAlive(pid as number)).toBe(false)
  })

  it("is true for another user's process", () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    })
    expect(processAlive(1)).toBe(true)
  })
})
