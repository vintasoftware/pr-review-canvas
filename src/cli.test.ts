// @vitest-environment node
// The one-shot commands over a real throwaway repository, as `pr-review <command>` runs them.
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { main } from './cli.js'
import { execGit } from './git/git.js'
import { makeTempDir } from './testing/fakes.js'

let dir: string
let repo: string

beforeEach(async () => {
  dir = await realpath(await makeTempDir('pr-review-cli-'))
  repo = path.join(dir, 'widgets')
  await mkdir(repo)
  await execGit(repo, ['init', '-q', '-b', 'main'])
  await execGit(repo, ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'])
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

/** Runs the CLI and returns what it wrote to stderr. */
async function stderrOf(argv: string[]): Promise<string> {
  const written: string[] = []
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    written.push(String(chunk))
    return true
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  await main(argv)
  return written.join('')
}

it('says on stderr that an invalid project config fell back to the defaults', async () => {
  await writeFile(path.join(repo, 'pr-review.config.yml'), 'sharing:\n  viewerLink: true\n')
  const stderr = await stderrOf(['validate', '--repo', repo, '--data-dir', path.join(dir, 'data')])
  expect(stderr).toContain('warning: pr-review.config.yml is invalid, using defaults: sharing.viewerLink')
})

it('prints no warning when the project config is valid', async () => {
  await writeFile(path.join(repo, 'pr-review.config.yml'), 'sharing:\n  viewerLink: false\n')
  const stderr = await stderrOf(['validate', '--repo', repo, '--data-dir', path.join(dir, 'data')])
  expect(stderr).not.toContain('warning:')
})
