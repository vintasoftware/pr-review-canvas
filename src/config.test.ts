// @vitest-environment node
import {
  ConfigError,
  loadRuntimeConfig,
  parseGithubRemote,
  parsePort,
  resolveGithubRepo,
  resolveRepoRoot,
} from './config.js'
import { createFakeGit } from './testing/fakes.js'

describe('parseGithubRemote', () => {
  it('reads ssh and https forms with or without .git', () => {
    const expected = { owner: 'vintasoftware', name: 'building-blocks' }
    expect(parseGithubRemote('git@github.com:vintasoftware/building-blocks.git')).toEqual(expected)
    expect(parseGithubRemote('git@github.com:vintasoftware/building-blocks')).toEqual(expected)
    expect(parseGithubRemote('ssh://git@github.com/vintasoftware/building-blocks.git')).toEqual(expected)
    expect(parseGithubRemote('https://github.com/vintasoftware/building-blocks.git')).toEqual(expected)
    expect(parseGithubRemote('https://github.com/vintasoftware/building-blocks/')).toEqual(expected)
    expect(parseGithubRemote('https://user@github.com/vintasoftware/building-blocks\n')).toEqual(expected)
  })

  it('rejects non-GitHub urls', () => {
    expect(parseGithubRemote('git@gitlab.com:a/b.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/only-owner')).toBeNull()
    expect(parseGithubRemote('')).toBeNull()
  })
})

describe('parsePort', () => {
  it('falls back, parses, and rejects garbage', () => {
    expect(parsePort(undefined, 3010)).toBe(3010)
    expect(parsePort('', 3010)).toBe(3010)
    expect(parsePort('4000', 3010)).toBe(4000)
    expect(() => parsePort('abc', 3010)).toThrow(ConfigError)
    expect(() => parsePort('70000', 3010)).toThrow(/invalid port/)
    expect(() => parsePort('0', 3010)).toThrow(ConfigError)
  })
})

describe('resolveRepoRoot and resolveGithubRepo', () => {
  it('maps git failures to ConfigError with a hint', async () => {
    await expect(resolveRepoRoot(createFakeGit())).rejects.toMatchObject({
      code: 'NOT_A_REPO',
      hint: 'run from a clone or pass --repo <dir>',
    })
    await expect(resolveGithubRepo(createFakeGit({ remotes: {} }))).rejects.toMatchObject({ code: 'NO_ORIGIN' })
    await expect(
      resolveGithubRepo(createFakeGit({ remotes: { origin: 'git@gitlab.com:a/b.git' } }))
    ).rejects.toMatchObject({
      code: 'NO_ORIGIN',
      message: 'origin is not a GitHub URL: git@gitlab.com:a/b.git',
    })
  })

  it('passes unknown errors through', async () => {
    const git = createFakeGit()
    git.topLevel = async () => {
      throw new TypeError('boom')
    }
    await expect(resolveRepoRoot(git)).rejects.toBeInstanceOf(TypeError)
  })
})

describe('loadRuntimeConfig', () => {
  const git = () =>
    createFakeGit({
      topLevel: '/work/repo',
      commonDir: '/work/repo/.git',
      remotes: { origin: 'git@github.com:acme/widgets.git' },
    })

  it('uses defaults when nothing is given', async () => {
    expect(await loadRuntimeConfig({}, {}, git(), '/cwd')).toEqual({
      port: 3010,
      repoRoot: '/work/repo',
      commonDir: '/work/repo/.git',
      dataDir: '/work/repo/.pr-review',
      repo: { owner: 'acme', name: 'widgets' },
      fixtureCanvasPath: null,
      chatOverrides: {},
    })
  })

  it('lets flags win over env and env over defaults, and resolves the fixture path from cwd', async () => {
    const env = { PR_REVIEW_PORT: '4001', PR_REVIEW_DATA_DIR: '/env/data' }
    expect(await loadRuntimeConfig({}, env, git(), '/cwd')).toMatchObject({ port: 4001, dataDir: '/env/data' })
    expect(
      await loadRuntimeConfig(
        { port: 5000, dataDir: '/flag/data', fixtureCanvas: 'fixtures/review.json' },
        env,
        git(),
        '/cwd'
      )
    ).toMatchObject({ port: 5000, dataDir: '/flag/data', fixtureCanvasPath: '/cwd/fixtures/review.json' })
  })

  it('rejects a bad env port', async () => {
    await expect(loadRuntimeConfig({}, { PR_REVIEW_PORT: 'x' }, git(), '/cwd')).rejects.toThrow(/invalid port/)
  })
})
