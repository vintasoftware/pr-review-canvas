// @vitest-environment node
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeTempDir } from '../testing/fakes.js'
import { findBrowser, headlessScreenshot, PHONE_VIEWPORT } from './preview.js'

/** An executable file named `name` in `dir`, running `body` as a shell script. */
async function executable(dir: string, name: string, body = 'exit 0'): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(file, 0o755)
  return file
}

describe('findBrowser', () => {
  it('takes PR_REVIEW_BROWSER first, then the first Chrome-family name on the PATH', async () => {
    const dir = await makeTempDir()
    const chromium = await executable(dir, 'chromium')
    expect(findBrowser({ PATH: dir, PR_REVIEW_BROWSER: '/opt/chrome' }, 'linux')).toBe('/opt/chrome')
    expect(findBrowser({ PATH: dir }, 'linux')).toBe(chromium)
    expect(findBrowser({ PATH: dir, PR_REVIEW_BROWSER: '' }, 'linux')).toBe(chromium)
    const chrome = await executable(dir, 'google-chrome')
    expect(findBrowser({ PATH: dir }, 'linux')).toBe(chrome)
  })

  it('looks where macOS and Windows install browsers, and finds none on a bare machine', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(
        findBrowser({ PATH: '', PROGRAMFILES: '/nowhere', LOCALAPPDATA: '/nowhere' }, platform)
      ).toBeNull()
    }
  })
})

describe('headlessScreenshot', () => {
  /** A stand-in browser: it records its arguments and writes the screenshot it is asked for. */
  async function fakeBrowser(dir: string, log: string): Promise<string> {
    return executable(
      dir,
      'browser',
      `printf '%s\\n' "$@" > '${log}'
for arg in "$@"; do case "$arg" in --screenshot=*) printf png > "\${arg#--screenshot=}";; esac; done`
    )
  }
  const profiles = async () => (await readdir(tmpdir())).filter(name => name.startsWith('pr-review-preview-'))

  it('runs the browser headless at the desktop size, in a profile it removes after', async () => {
    const dir = await makeTempDir()
    const log = path.join(dir, 'args.txt')
    const browser = await fakeBrowser(dir, log)
    const before = await profiles()
    const file = path.join(dir, 'landmark.png')
    await headlessScreenshot(browser, 'http://127.0.0.1:9/tour/42?preview', file)
    expect(await readFile(file, 'utf8')).toBe('png')
    const args = (await readFile(log, 'utf8')).trim().split('\n')
    expect(args).toContain('--headless')
    expect(args).toContain('--force-prefers-reduced-motion')
    expect(args).toContain('--window-size=1280,1000')
    expect(args).toContain(`--screenshot=${file}`)
    expect(args.at(-1)).toBe('http://127.0.0.1:9/tour/42?preview')
    const profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
    expect(profile).toMatch(/pr-review-preview-/)
    expect(await profiles()).toEqual(before)
  })

  it('takes a phone-sized picture when asked', async () => {
    const dir = await makeTempDir()
    const log = path.join(dir, 'args.txt')
    const browser = await fakeBrowser(dir, log)
    await headlessScreenshot(browser, 'http://127.0.0.1:9/', path.join(dir, 'phone.png'), PHONE_VIEWPORT)
    expect((await readFile(log, 'utf8')).split('\n')).toContain('--window-size=390,844')
  })

  it('fails when the browser does, and still removes its profile', async () => {
    const dir = await makeTempDir()
    const browser = await executable(dir, 'browser', 'exit 3')
    const before = await profiles()
    await expect(
      headlessScreenshot(browser, 'http://127.0.0.1:9/', path.join(dir, 'x.png'))
    ).rejects.toThrow()
    expect(await profiles()).toEqual(before)
  })
})
