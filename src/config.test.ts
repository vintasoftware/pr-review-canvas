// @vitest-environment node
import {
  ConfigError,
  loadRuntimeConfig,
  ORIGIN_HINT,
  parseChatOverrides,
  parsePort,
  resolveOrigin,
  resolveRepoRoot,
} from './config.js'
import { GITHUB_HOST } from './host/host.js'
import { createFakeGit } from './testing/fakes.js'

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

describe('resolveRepoRoot and resolveOrigin', () => {
  it('maps git failures to ConfigError with a hint', async () => {
    await expect(resolveRepoRoot(createFakeGit())).rejects.toMatchObject({
      code: 'NOT_A_REPO',
      hint: 'run from a clone or pass --repo <dir>',
    })
    await expect(resolveOrigin(createFakeGit({ remotes: {} }))).rejects.toMatchObject({
      code: 'NO_ORIGIN',
      message: 'the repository has no "origin" remote',
      hint: ORIGIN_HINT,
    })
    await expect(
      resolveOrigin(createFakeGit({ remotes: { origin: 'git@bitbucket.org:a/b.git' } }))
    ).rejects.toMatchObject({
      code: 'NO_ORIGIN',
      message: 'origin is not a GitHub or GitLab URL: git@bitbucket.org:a/b.git',
      hint: ORIGIN_HINT,
    })
    await expect(
      resolveOrigin(createFakeGit({ remotes: { origin: 'git@bitbucket.org:a/b.git' } }), {
        PR_REVIEW_HOST: 'gitlab',
      })
    ).resolves.toMatchObject({
      host: { kind: 'gitlab', hostname: 'bitbucket.org' },
      repo: { owner: 'a', name: 'b' },
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
      host: GITHUB_HOST,
      fixtureCanvasPath: null,
      chatOverrides: {},
    })
  })

  it('classifies a GitLab origin', async () => {
    const gitlabGit = createFakeGit({
      topLevel: '/work/repo',
      commonDir: '/work/repo/.git',
      remotes: { origin: 'git@gitlab.com:acme/widgets.git' },
    })
    expect(await loadRuntimeConfig({}, {}, gitlabGit, '/cwd')).toMatchObject({
      repo: { owner: 'acme', name: 'widgets' },
      host: { kind: 'gitlab', hostname: 'gitlab.com' },
    })
  })

  it('lets flags win over env and env over defaults, and resolves the fixture path from cwd', async () => {
    const env = { PR_REVIEW_PORT: '4001', PR_REVIEW_DATA_DIR: '/env/data' }
    expect(await loadRuntimeConfig({}, env, git(), '/cwd')).toMatchObject({
      port: 4001,
      dataDir: '/env/data',
    })
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
    await expect(loadRuntimeConfig({}, { PR_REVIEW_PORT: 'x' }, git(), '/cwd')).rejects.toThrow(
      /invalid port/
    )
  })
})

describe('chat command-line overrides', () => {
  it.each(['claude', 'codex'])('selects %s with an explicit model', agent => {
    expect(parseChatOverrides({ chatAgent: agent, chatModel: 'custom-model' })).toEqual({
      chatAgent: agent,
      chatModel: 'custom-model',
    })
  })

  it('leaves the saved model in effect when the flag is empty', () => {
    expect(parseChatOverrides({ chatModel: '' })).toEqual({})
    expect(parseChatOverrides({ chatModel: 'custom-model' })).toEqual({ chatModel: 'custom-model' })
  })

  it('rejects unsupported agents with a usage hint', () => {
    expect(() => parseChatOverrides({ chatAgent: 'unknown' })).toThrow(
      expect.objectContaining({ code: 'BAD_REQUEST', hint: 'use --chat-agent claude or --chat-agent codex' })
    )
  })
})
