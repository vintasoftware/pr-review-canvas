// @vitest-environment node
import { GITHUB_HOST, gitlabHost } from './host.js'
import { hostOverrideFromEnv, parseGithubRemote, parseGitlabRemote, parseOriginRemote } from './remote.js'

describe('parseGithubRemote', () => {
  it('reads ssh and https forms with or without .git', () => {
    const expected = { owner: 'vintasoftware', name: 'building-blocks' }
    expect(parseGithubRemote('git@github.com:vintasoftware/building-blocks.git')).toEqual(expected)
    expect(parseGithubRemote('https://github.com/vintasoftware/building-blocks/')).toEqual(expected)
  })

  it('rejects GitLab and incomplete GitHub urls', () => {
    expect(parseGithubRemote('git@gitlab.com:a/b.git')).toBeNull()
    expect(parseGithubRemote('https://github.com/only-owner')).toBeNull()
  })
})

describe('parseGitlabRemote', () => {
  it('reads gitlab.com ssh, https, nested groups, and a gitlab.* host', () => {
    expect(parseGitlabRemote('git@gitlab.com:acme/widgets.git')).toEqual({
      hostname: 'gitlab.com',
      repo: { owner: 'acme', name: 'widgets' },
    })
    expect(parseGitlabRemote('https://gitlab.com/group/sub/project.git')).toEqual({
      hostname: 'gitlab.com',
      repo: { owner: 'group/sub', name: 'project' },
    })
    expect(parseGitlabRemote('https://gitlab.example.com/acme/widgets.git')).toEqual({
      hostname: 'gitlab.example.com',
      repo: { owner: 'acme', name: 'widgets' },
    })
  })

  it('rejects github.com and a host that does not look like GitLab unless forced', () => {
    expect(parseGitlabRemote('git@github.com:acme/widgets.git')).toBeNull()
    expect(parseGitlabRemote('git@git.company.com:acme/widgets.git')).toBeNull()
    expect(parseGitlabRemote('git@git.company.com:acme/widgets.git', true)).toEqual({
      hostname: 'git.company.com',
      repo: { owner: 'acme', name: 'widgets' },
    })
  })
})

describe('parseOriginRemote', () => {
  it('classifies GitHub and GitLab from the URL', () => {
    expect(parseOriginRemote('git@github.com:acme/widgets.git')).toEqual({
      host: GITHUB_HOST,
      repo: { owner: 'acme', name: 'widgets' },
    })
    expect(parseOriginRemote('git@gitlab.com:acme/widgets.git')).toEqual({
      host: gitlabHost('gitlab.com'),
      repo: { owner: 'acme', name: 'widgets' },
    })
  })

  it('honors PR_REVIEW_HOST=gitlab for a self-hosted URL', () => {
    expect(parseOriginRemote('git@git.company.com:group/app.git', { PR_REVIEW_HOST: 'gitlab' })).toEqual({
      host: gitlabHost('git.company.com'),
      repo: { owner: 'group', name: 'app' },
    })
  })

  it('honors PR_REVIEW_HOST=github and ssh:// GitLab remotes', () => {
    expect(parseOriginRemote('https://github.com/acme/widgets.git', { PR_REVIEW_HOST: 'github' })).toEqual({
      host: GITHUB_HOST,
      repo: { owner: 'acme', name: 'widgets' },
    })
    expect(parseGitlabRemote('ssh://git@gitlab.com/group/project.git')).toEqual({
      hostname: 'gitlab.com',
      repo: { owner: 'group', name: 'project' },
    })
    expect(parseGitlabRemote('https://gitlab.com/only-one')).toBeNull()
    expect(parseGitlabRemote('')).toBeNull()
    expect(parseGitlabRemote('ftp://gitlab.com/a/b')).toBeNull()
    expect(hostOverrideFromEnv({ PR_REVIEW_HOST: 'nope' })).toBeNull()
  })
})
