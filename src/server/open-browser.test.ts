// @vitest-environment node
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { openBrowser, opener } from './open-browser.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const URL = 'http://localhost:3010/'

describe('opener', () => {
  it('names each platform opener and passes the URL as its one argument', () => {
    expect(opener(URL, 'darwin')).toEqual(['open', [URL]])
    expect(opener(URL, 'win32')).toEqual(['explorer.exe', [URL]])
    expect(opener(URL, 'linux')).toEqual(['xdg-open', [URL]])
  })
})

describe('openBrowser', () => {
  it('starts a detached opener without a shell and logs when it cannot run', () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    vi.mocked(spawn).mockReturnValue(child as never)
    const log = vi.fn()

    openBrowser(URL, log)

    const [command, args] = opener(URL)
    expect(spawn).toHaveBeenCalledWith(command, args, { stdio: 'ignore', detached: true })
    expect(child.unref).toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    child.emit('error', new Error('spawn xdg-open ENOENT'))
    expect(log).toHaveBeenCalledWith(`could not open a browser (spawn xdg-open ENOENT); open ${URL}`)
  })
})
