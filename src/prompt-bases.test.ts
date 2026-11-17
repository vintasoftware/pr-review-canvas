// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROMPTS_DIR } from './paths.js'
import { baseLine, stripBaseLine, templateNotices } from './prompt-bases.js'

let repo: string
let bundledDir: string
beforeEach(async () => {
  repo = await mkdtemp(path.join(os.tmpdir(), 'prompt-bases-'))
  bundledDir = path.join(repo, 'bundled')
  await mkdir(bundledDir)
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

const bundledV2 = '## Writing\n\nSay it plainly, in full sentences.\n'

async function own(file: string, text: string): Promise<void> {
  await writeFile(path.join(repo, file), text)
}

describe('base lines', () => {
  it('names the version, the template, and its bundled text', () => {
    expect(baseLine('generation-format.md', '0.11.1', bundledV2)).toMatch(
      /^<!-- pr-review-canvas 0\.11\.1 generation-format\.md [0-9a-f]{12} -->$/
    )
    expect(baseLine('generation-format.md', '0.11.1', bundledV2)).not.toBe(
      baseLine('generation-format.md', '0.11.1', `${bundledV2}More.\n`)
    )
    // A checkout that turned LF into CRLF keeps the hash.
    expect(baseLine('generation-format.md', '0.11.1', bundledV2.replaceAll('\n', '\r\n'))).toBe(
      baseLine('generation-format.md', '0.11.1', bundledV2)
    )
  })

  it('drops the line only when it comes first', () => {
    const line = baseLine('chat-seed.md', '0.11.1', 'seed')
    expect(stripBaseLine(`${line}\nYou are reviewing {{PR_META}}\n`)).toBe('You are reviewing {{PR_META}}\n')
    expect(stripBaseLine(`${line}\r\nCRLF\r\n`)).toBe('CRLF\r\n')
    expect(stripBaseLine(`Intro\n${line}\n`)).toBe(`Intro\n${line}\n`)
  })
})

describe('templateNotices', () => {
  it('says nothing of a copy whose line names the installed bundled template, or of one it cannot read', async () => {
    await writeFile(path.join(bundledDir, 'generation-format.md'), bundledV2)
    await own('format.md', `${baseLine('generation-format.md', '0.11.1', bundledV2)}\nmine\n`)
    const overrides = { 'generation-format.md': 'format.md', 'chat-seed.md': 'missing.md' }
    expect(await templateNotices(repo, overrides, '0.12.0', bundledDir)).toEqual([])
  })

  it('links what changed since the copy’s version and gives the line to paste once merged', async () => {
    await writeFile(path.join(bundledDir, 'generation-format.md'), bundledV2)
    await own('format.md', `${baseLine('generation-format.md', '0.11.1', 'older text')}\nmine\n`)
    expect(
      await templateNotices(repo, { 'generation-format.md': 'format.md' }, '0.12.0', bundledDir)
    ).toEqual([
      {
        file: 'format.md',
        message:
          "format.md: pr-review's generation-format.md changed after 0.11.1, the version this copy counts as copied from. " +
          'Merge what you want from https://github.com/vintasoftware/pr-review-canvas/compare/v0.11.1...v0.12.0, ' +
          `then make \`${baseLine('generation-format.md', '0.12.0', bundledV2)}\` its first line`,
      },
    ])
  })

  it('takes a copy without a line to be from 0.10.0, the last release before lines', async () => {
    const overrides = {
      'generation-format.md': 'format.md',
      'judging-strict.md': 'judging.md',
      'writing.md': 'writing.md',
    }
    for (const file of Object.values(overrides)) await own(file, 'mine\n')
    const notices = await templateNotices(repo, overrides, '0.11.1')
    // generation-format.md changed after 0.10.0; judging-strict.md did not.
    expect(notices.map(n => n.file)).toEqual(['format.md', 'writing.md'])
    expect(notices[0]?.message).toContain('compare/v0.10.0...v0.11.1')
    // writing.md is newer than 0.10.0, so nothing tells which version a copy of it came from.
    const writing = await readFile(path.join(PROMPTS_DIR, 'writing.md'), 'utf8')
    expect(notices[1]?.message).toBe(
      'writing.md: pr-review cannot tell which version of its writing.md this copy came from. ' +
        `Compare it with ${path.join(PROMPTS_DIR, 'writing.md')}, ` +
        `then make \`${baseLine('writing.md', '0.11.1', writing)}\` its first line`
    )
  })

  it('asks for an upgrade when the copy came from a newer pr-review', async () => {
    await writeFile(path.join(bundledDir, 'generation-format.md'), bundledV2)
    await own('format.md', `${baseLine('generation-format.md', '0.13.0', 'newer text')}\nmine\n`)
    expect(
      await templateNotices(repo, { 'generation-format.md': 'format.md' }, '0.12.0', bundledDir)
    ).toEqual([
      {
        file: 'format.md',
        message:
          'format.md: this copy came from pr-review 0.13.0, newer than this 0.12.0; run `pr-review upgrade`',
      },
    ])
  })

  it('cannot tell the base from a line for another template or another text of this version', async () => {
    await writeFile(path.join(bundledDir, 'generation-format.md'), bundledV2)
    await writeFile(path.join(bundledDir, 'chat-seed.md'), 'seed')
    await own('format.md', `${baseLine('chat-seed.md', '0.11.1', 'seed')}\nmine\n`)
    await own('seed.md', `${baseLine('chat-seed.md', '0.12.0', 'edited by hand')}\nmine\n`)
    const notices = await templateNotices(
      repo,
      { 'generation-format.md': 'format.md', 'chat-seed.md': 'seed.md' },
      '0.12.0',
      bundledDir
    )
    expect(notices.map(n => n.message.split('. ')[0])).toEqual([
      'format.md: pr-review cannot tell which version of its generation-format.md this copy came from',
      'seed.md: pr-review cannot tell which version of its chat-seed.md this copy came from',
    ])
  })
})
