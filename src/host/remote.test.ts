// @vitest-environment node
import { GITHUB_HOST } from './host.js'
import { parseOriginRemote, splitGitRemote } from './remote.js'

describe('splitGitRemote', () => {
  it('reads scp-like ssh, ssh://, and https forms, with or without .git, a user, or a trailing slash', () => {
    const expected = { hostname: 'github.com', path: 'vintasoftware/building-blocks' }
    expect(splitGitRemote('git@github.com:vintasoftware/building-blocks.git')).toEqual(expected)
    expect(splitGitRemote('git@github.com:vintasoftware/building-blocks')).toEqual(expected)
    expect(splitGitRemote('ssh://git@github.com/vintasoftware/building-blocks.git')).toEqual(expected)
    expect(splitGitRemote('https://github.com/vintasoftware/building-blocks.git')).toEqual(expected)
    expect(splitGitRemote('https://github.com/vintasoftware/building-blocks/')).toEqual(expected)
    expect(splitGitRemote('https://user@GitHub.com/vintasoftware/building-blocks\n')).toEqual(expected)
    expect(splitGitRemote('')).toBeNull()
    expect(splitGitRemote('ftp://gitlab.com/a/b')).toBeNull()
  })
})

describe('parseOriginRemote', () => {
  it('reads a github.com origin as GitHub, with exactly an owner and a name', () => {
    expect(parseOriginRemote('git@github.com:acme/widgets.git')).toEqual({
      host: GITHUB_HOST,
      repo: { owner: 'acme', name: 'widgets' },
    })
    expect(parseOriginRemote('https://github.com/only-owner')).toBeNull()
    expect(parseOriginRemote('https://github.com/acme/group/widgets')).toBeNull()
  })

  it('reads gitlab.com and any host named gitlab as GitLab, nesting groups into the owner', () => {
    expect(parseOriginRemote('git@gitlab.com:acme/widgets.git')).toMatchObject({
      host: { kind: 'gitlab', hostname: 'gitlab.com' },
      repo: { owner: 'acme', name: 'widgets' },
    })
    expect(parseOriginRemote('https://gitlab.example.com/group/sub/project.git')).toMatchObject({
      host: { kind: 'gitlab', hostname: 'gitlab.example.com', webBase: 'https://gitlab.example.com' },
      repo: { owner: 'group/sub', name: 'project' },
    })
    expect(parseOriginRemote('https://gitlab.com/only-one')).toBeNull()
  })

  it('needs PR_REVIEW_HOST=gitlab for a self-hosted instance whose name does not say so', () => {
    const url = 'git@git.company.com:group/app.git'
    expect(parseOriginRemote(url)).toBeNull()
    expect(parseOriginRemote(url, { PR_REVIEW_HOST: 'nope' })).toBeNull()
    expect(parseOriginRemote(url, { PR_REVIEW_HOST: ' GitLab ' })).toMatchObject({
      host: { kind: 'gitlab', hostname: 'git.company.com' },
      repo: { owner: 'group', name: 'app' },
    })
    // github.com stays GitHub whatever the variable says.
    expect(parseOriginRemote('git@github.com:acme/widgets.git', { PR_REVIEW_HOST: 'gitlab' })?.host).toBe(
      GITHUB_HOST
    )
  })
})
